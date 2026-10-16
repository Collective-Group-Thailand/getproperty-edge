# getproperty Device Protocol (v1) — MQTT between `getproperty-edge` and `getproperty-api`

> Owned by `getproperty-api`; identical copy in `getproperty-edge/docs/contract/device-protocol.md`. JSON Schemas of every payload are generated into `contract/device-protocol.json` by `pnpm contract:build` (from the same DTO classes the MQTT ingest worker validates with). Implements D-130, D-131, D-030, D-033, D-034.
> **Schema mapping (schema-design v2, D-151/D-152):** `gatewayId` and `meterId` are `smart.device` ids (a meter device is linked to its `core.asset_item` once installed, and to a unit or common area through `core.meter_assignment`); `roomCode` is a display label only — it carries `core.unit.unit_no` or the meter assignment's `code` for common areas, and keeps its wire name until a coordinated protocol change with `getproperty-edge`. Accepted readings land in `smart.telemetry_point` (insight) and `smart.meter_reading` (billing, D-030); dedup stays `(meterId, seq)` (D-143). The protocol itself is unchanged by the schema lock.

## 1. Transport & identity
- Broker: EMQX (managed or self-hosted), MQTT 5 over TLS 1.2+ on 8883; WebSocket 443 fallback for buildings whose network blocks 8883.
- Identity: per-gateway X.509 client certificate issued at bootstrap (`POST /v1/device/bootstrap`, HTTPS, with the one-time provisioning code printed on the gateway QR). CN = `gw-<gatewayId>`. Certificates rotate every 12 months (the agent requests renewal at 11); revoked on `retired`.
- Broker ACL (from the API's device registry, pushed to EMQX): a gateway may publish only to `gp/v1/<gatewayId>/+` and subscribe only to `gp/v1/<gatewayId>/config` and `gp/v1/<gatewayId>/cmd`.
- Clock: the gateway syncs NTP; readings carry the gateway clock; the cloud records `receivedAt` and flags readings whose `readAt` is > 10 min ahead of receipt (`quality: clock_suspect`).

## 2. Topics
| Topic | Direction | QoS | Retained | Payload |
|---|---|---|---|---|
| `gp/v1/<gatewayId>/telemetry` | gateway → cloud | 1 | no | `TelemetryBatch` |
| `gp/v1/<gatewayId>/health` | gateway → cloud | 1 | no | `Health` every 60 s |
| `gp/v1/<gatewayId>/events` | gateway → cloud | 1 | no | `DeviceEvent` (meter_offline, pulse_overflow, config_applied, config_rejected, ota_*, tamper, power_loss, restart) |
| `gp/v1/<gatewayId>/config` | cloud → gateway | 1 | **yes** | `GatewayConfig` (full document, versioned) |
| `gp/v1/<gatewayId>/cmd` | cloud → gateway | 1 | no | `Command` (read_now, restart, ota_apply, upload_logs, set_log_level, identify) |
| `gp/v1/<gatewayId>/cmd/ack` | gateway → cloud | 1 | no | `CommandAck` |
| LWT: `gp/v1/<gatewayId>/health` | broker | 1 | no | `{ "status": "offline_lwt" }` |

## 3. Payloads (summary — the schemas are normative)
```jsonc
// TelemetryBatch
{ "gatewayId": "uuid", "configVersion": 12, "sentAt": "2026-11-01T00:15:03+07:00",
  "readings": [
    { "meterId": "uuid", "seq": 48213, "readAt": "2026-11-01T00:15:00+07:00",
      "register": "12345.678", "unit": "kwh", "quality": "good",      // good | estimated_by_gateway | clock_suspect | overflow_corrected
      "extra": { "voltage": 228.1, "current": 3.2, "powerW": 710 } }   // optional, driver-specific, never used for billing
  ] }
// Health
{ "gatewayId": "uuid", "agentVersion": "1.4.2", "configVersion": 12, "uptimeS": 86400,
  "bufferedReadings": 0, "diskFreeMb": 1800, "cpuPct": 7, "memPct": 31, "link": "ethernet",  // ethernet | wifi | lte
  "rssi": null, "meters": [ { "meterId": "uuid", "lastReadAt": "...", "status": "ok" } ] }   // ok | timeout | crc_error | not_found
// GatewayConfig
{ "version": 12, "pollIntervalS": 900, "heartbeatS": 60,
  "buses": [ { "id": "rs485-1", "type": "modbus_rtu", "device": "/dev/ttyUSB0", "baud": 9600, "parity": "none" } ],
  "meters": [
    { "meterId": "uuid", "roomCode": "A-201", "driver": "eastron_sdm120", "bus": "rs485-1", "address": 21,
      "unit": "kwh", "registerMap": "driver_default", "scale": "1" },
    { "meterId": "uuid", "roomCode": "A-201W", "driver": "pulse_counter", "bus": "gpio", "pin": 17,
      "unit": "m3", "litresPerPulse": 10, "initialRegister": "1532.040" } ] }
// Command / CommandAck
{ "cmdId": "uuid", "type": "read_now", "args": { "meterIds": ["uuid"] }, "issuedAt": "..." }
{ "cmdId": "uuid", "status": "done", "result": {}, "error": null, "finishedAt": "..." }      // accepted | done | failed
```

## 4. Semantics
- **Sequence and dedup**: `seq` is per meter, monotonic, persisted on the gateway; the cloud ignores a reading whose `(meterId, seq)` was already stored and logs a `duplicate` metric. A `seq` gap is allowed (buffer eviction) and recorded as an event.
- **Store-and-forward**: readings are appended to an on-disk queue before any publish attempt; publish in batches ≤ 200 readings; delete only on PUBACK. Buffer capacity 30 days at 15-min polling for 300 meters (~8.6 M readings; SQLite, ~1 GB); when full, evict oldest *interval* readings but never the last reading per meter per hour.
- **Pulse meters**: the gateway holds the register (`initialRegister` + pulses × litres/pulse) and persists it on every pulse batch; a power loss between persists is reported as `quality: estimated_by_gateway` for the first reading after restart; the cloud never trusts pulse registers for billing without a staff-confirmed physical read at install and at every `meter_swap` (D-033).
- **Config**: the gateway applies a config atomically, persists it, publishes `config_applied` with the version; on a failure it keeps the previous config and publishes `config_rejected` with the error. Health reports the applied version so the cloud can detect drift.
- **Commands** expire after `ttlS` (default 300 s); the gateway acks `accepted` immediately and `done|failed` on completion; the cloud retries unacked commands up to 3 times.
- **OTA**: `ota_apply` carries a manifest URL (signed, from `/v1/device/ota/manifest`); the agent verifies the signature, installs to the inactive slot, reboots, health-checks, and rolls back automatically if the new version fails to publish health within 5 min (D-131 rings).

## 5. Security
- No secrets in config payloads; broker credentials are the certificate. The agent never exposes the RS485 bus or GPIO over the network; the local status page is read-only and LAN-only.
- All payloads validated by the cloud against the schemas; an invalid payload is dropped, counted and raises `device.invalid_payload` after a threshold.
