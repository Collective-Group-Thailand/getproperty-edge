# getproperty Device Protocol (v1) — MQTT between `getproperty-edge` and `getproperty-api`

> Owned by `getproperty-api`; identical copy in `getproperty-edge/docs/contract/device-protocol.md`. JSON Schemas of every payload are generated into `contract/device-protocol.json` by `pnpm contract:build` (from the same DTO classes the MQTT ingest worker validates with). Implements D-130, D-131, D-030, D-033, D-034.
> **Schema mapping (schema-design v2, D-151/D-152):** `gatewayId` and `meterId` are `smart.device` ids (a meter device is linked to its `core.asset_item` once installed, and to a unit or common area through `core.meter_assignment`); `roomCode` is a display label only — it carries `core.unit.unit_no` or the meter assignment's `code` for common areas, and keeps its wire name until a coordinated protocol change with `getproperty-edge`. Accepted readings land in `smart.telemetry_point` (insight) and `smart.meter_reading` (billing, D-030); dedup stays `(meterId, seq)` (D-143). The protocol itself is unchanged by the schema lock.

## 1. Transport & identity
- Broker: EMQX (managed or self-hosted), MQTT 5 over TLS 1.2+ on 8883; WebSocket 443 fallback for buildings whose network blocks 8883.
- Identity: per-gateway X.509 client certificate issued at bootstrap (`POST /v1/device/bootstrap`, HTTPS, with the one-time provisioning code printed on the gateway QR; the serial is optional). The CSR (PKCS#10, EC P-256/SHA-256) carries `CN=gw-provisioning` (or already `CN=gw-<gatewayId>`); the platform CA **sets** `CN = gw-<gatewayId>`, `extendedKeyUsage=clientAuth`, 12 months. The `201` answer carries `gatewayId`, `certificatePem`, `caChainPem` (also the trust anchor of the broker's server certificate), `mqtt.url` / `mqtt.wsUrl`, and the device JWT as `deviceToken { accessToken, expiresAt }` (plus the token pair). A second use of the code answers `401 device.provisioning_code_invalid`; any 4xx means "ask for a new code".
- Device JWT: `POST /v1/device/token` with the client certificate only (mTLS, body `{}`) → `200 { accessToken, expiresAt }` (`aud=device`); the agent refreshes one minute before `expiresAt` and never writes the token to disk. Every other `/v1/device/*` call sends `Authorization: Bearer <device JWT>`; when it also presents a client certificate, it must be the same gateway's.
- Renewal: `POST /v1/device/certificate/renew` (mTLS + bearer, `{ csrPem }` with a **new** key, `CN=gw-<gatewayId>`) → `200 { certificatePem, caChainPem, notAfter }`; due 11 calendar months after `notBefore` or 30 days before `notAfter`, whichever is first, retried hourly. The old certificate stays valid until it expires; the agent reconnects MQTT with the new one. Certificates are revoked when the gateway is retired.
- Broker ACL (from the API's device registry, `smart.mqtt_acl`, read by EMQX): a gateway may publish only to `gp/v1/<gatewayId>/+` **and** `gp/v1/<gatewayId>/cmd/ack` (two levels — listed explicitly because `+` matches one level), and subscribe only to `gp/v1/<gatewayId>/config` and `gp/v1/<gatewayId>/cmd`.
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
      "register": "12345.678", "unit": "kwh", "quality": "good",      // good | estimated_by_gateway | clock_suspect | overflow_corrected | register_decrease
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
      "unit": "m3", "litresPerPulse": 10, "initialRegister": "1532.040" },
    { "meterId": "uuid", "roomCode": "MAIN-E", "driver": "modbus_generic", "bus": "rs485-1", "address": 3,
      "unit": "kwh", "registerMap": "custom", "scale": "1",
      "customRegisterMap": { "energy": { "address": 342, "function": "input", "dataType": "float32", "wordOrder": "big_endian", "scale": "1" } } } ] }
// Command / CommandAck
{ "cmdId": "uuid", "type": "read_now", "args": { "meterIds": ["uuid"] }, "issuedAt": "..." }
{ "cmdId": "uuid", "status": "done", "result": {}, "error": null, "finishedAt": "..." }      // accepted | done | failed
```

- `registerMap: "custom"` comes with `customRegisterMap` (`energy` required: address, `function` holding|input, `dataType`, `wordOrder`, decimal `scale`; `voltage`/`current`/`power` optional and only for `extra`). A model with a built-in driver map keeps `driver_default` (D-013).
- `DeviceEvent.configVersion` is a **string** (`String(version)`), while `GatewayConfig.version` and `Health.configVersion` are integers; the cloud parses it (CR-010).
- A reading whose register **decreased** without a swap is sent unchanged with `quality: "register_decrease"` (never dropped); the agent may also raise a `tamper` event with `data.reason = "register_decrease"`. The cloud stores it as telemetry and sends the reading to the owner's review queue (D-035), never to billing as is.

## 4. Semantics
- **Sequence and dedup**: `seq` is per meter, monotonic, persisted on the gateway; the cloud ignores a reading whose `(meterId, seq)` was already stored and logs a `duplicate` metric. A `seq` gap is allowed (buffer eviction) and recorded as an event.
- **Store-and-forward**: readings are appended to an on-disk queue before any publish attempt; publish in batches ≤ 200 readings; delete only on PUBACK. Buffer capacity 30 days at 15-min polling for 300 meters (30 × 96 × 300 = 864,000 readings; the agent's default capacity is 1,000,000, SQLite ≈ 1 GB); when full, evict oldest *interval* readings but never the last reading per meter per hour.
- **Pulse meters**: the gateway holds the register (`initialRegister` + pulses × litres/pulse) and persists it on every pulse batch; a power loss between persists is reported as `quality: estimated_by_gateway` for the first reading after restart; the cloud never trusts pulse registers for billing without a staff-confirmed physical read at install and at every `meter_swap` (D-033).
- **Config**: the gateway applies a config atomically, persists it, publishes `config_applied` with the version; on a failure it keeps the previous config and publishes `config_rejected` with the error. Health reports the applied version so the cloud can detect drift.
- **Commands** expire after `ttlS` (default 300 s); the gateway acks `accepted` immediately and `done|failed` on completion; the cloud retries unacked commands up to 3 times.
- **OTA**: `ota_apply` carries a manifest URL (signed, from `/v1/device/ota/manifest`); the agent verifies the signature, installs to the inactive slot, reboots, health-checks, and rolls back automatically if the new version fails to publish health within 5 min (D-131 rings).

## 5. Security
- No secrets in config payloads; broker credentials are the certificate. The agent never exposes the RS485 bus or GPIO over the network; the local status page is read-only and LAN-only.
- All payloads validated by the cloud against the schemas; an invalid payload is dropped, counted and raises `device.invalid_payload` after a threshold.

## 6. Cloud behaviour (getproperty-api B3, D-183–D-188)
- **HTTPS endpoints** (device JWT; a presented client certificate must be the same gateway's):
  - `GET /v1/device/config` → the latest compiled `GatewayConfig` (the document retained on `gp/v1/<gatewayId>/config`), for a cold start without MQTT (compiled on demand when none exists yet).
  - `GET /v1/device/ota/manifest?releaseId=<uuid>` → the signed manifest below, for the gateway's architecture only (`404` otherwise); without `releaseId` the release of the newest rollout that targeted the gateway.
  - `POST /v1/device/readings/batch` — body = `TelemetryBatch` of the calling gateway (another `gatewayId` → `422 device.invalid_payload`); same pipeline as MQTT; `200 { accepted, duplicates, rejected: [{ meterId, seq, reason }] }`. Any 2xx means durable; replays are harmless (dedup `(meterId, seq)`); an `Idempotency-Key` header is accepted and ignored (CR-009).
- **OTA manifest** (edge CR-011; `ota_apply.args.manifestUrl` points at the endpoint above):
  ```jsonc
  { "schema": 1, "version": "0.4.0", "channel": "stable",              // stable | beta | canary
    "arch": "arm64",                                                      // arm64 | x64 | armv7
    "artifact": { "url": "https://…/arm64.tar.zst", "sha256": "<64 hex>", "size": 48211234 },
    "minAgentVersion": "0.3.0", "releasedAt": "2026-10-15T09:00:00Z",
    "signature": { "alg": "ed25519", "keyId": "gp-ota-2026", "value": "<base64>" } }
  ```
  The signature covers the canonical JSON of the manifest **without** `signature` (keys sorted recursively, no whitespace). The API refuses a release whose signature does not verify against `OTA_SIGNING_PUBLIC_KEYS`; the agent verifies again with its baked-in keys. The agent reports `ota_started`, `ota_applied` (`data.version`), `ota_failed` / `ota_rolled_back` (`data.error`) on `…/events`; `ota_applied` sets the gateway's firmware version.
- **Authorisation of readings**: a reading is stored only when the meter channel `(gatewayId, meterId)` is open at its `readAt`; otherwise it is refused (audited, `unbound_meter` device event), never re-attributed.
- **Refused payloads** (malformed JSON, schema violation, unknown topic, unknown/retired gateway, topic ≠ `gatewayId`, more than 200 readings → also a `batch_too_large` event) are kept as dead letters for an admin replay; messages that still fail after retries are dead-lettered as `processing_error` (QoS 1 is acknowledged on receipt).
- **Billing candidates**: the first stored reading of each 60-minute interval per meter (`readings.iot_promotion_minutes`) becomes a `smart.meter_reading` (`source: iot`); `register_decrease` goes to the owner review queue, `clock_suspect` / `estimated_by_gateway` / `overflow_corrected` are accepted with a lower confidence. Every point stays in telemetry for the usage charts.
- **Presence**: `online` on the next `Health` after `provisioned`/`offline` (telemetry refreshes `lastSeenAt`), `degraded` while `Health.meters[]` reports a non-`ok` meter, `offline` on the LWT or after 5 missed heartbeats (`health.gateway_missed_heartbeats` × `heartbeatS`).
- **Config drift**: a gateway whose `Health.configVersion` / `config_applied` lags the latest compiled version for more than 15 min (`health.config_drift_minutes`) is flagged once per version (`config_drift` device event, `driftFlaggedAt` in the device views); the config is never re-published unless its content changed.
- **Commands**: re-sent every 60 s while unacknowledged, at most 3 times, then `expired`; `ttlS` 300 (`ota_apply` 3,600).
