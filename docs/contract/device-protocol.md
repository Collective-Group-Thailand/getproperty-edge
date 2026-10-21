# getproperty Device Protocol (v1, revision 1.2) — MQTT between `getproperty-edge` and `getproperty-api`

> Owned by `getproperty-api`; identical copy in `getproperty-edge/docs/contract/device-protocol.md`. JSON Schemas of every payload are generated into `contract/device-protocol.json` by `pnpm contract:build` (from the same DTO classes the MQTT ingest worker validates with). Implements D-130, D-131, D-030, D-033, D-034.
> **Schema mapping (schema-design v2, D-151/D-152):** `gatewayId` and `meterId` are `smart.device` ids (a meter device is linked to its `core.asset_item` once installed, and to a unit or common area through `core.meter_assignment`); `roomCode` is a display label only — it carries `core.unit.unit_no` or the meter assignment's `code` for common areas, and keeps its wire name until a coordinated protocol change with `getproperty-edge`. Accepted readings land in `smart.telemetry_point` (insight) and `smart.meter_reading` (billing, D-030); dedup is `(gatewayId, seqEpoch, meterId, seq)` since protocol 1.1 (D-143, D-227).
> **Protocol 1.2 (2026-10-22, D-235, D-239, D-244 — additive for payloads):** the MQTT **password is a device JWT** of the gateway (`POST /v1/device/token`, ≤ 1 h), fetched before every (re)connect — on 8883 together with the client certificate (required while the platform setting `mqtt.authn.require_device_jwt` is on, the default; agents before 1.2 send none and are refused then), on the WebSocket fallback alone; a gateway publishes only its **four explicit topics** (`telemetry`, `health`, `events`, `cmd/ack`) — the former `gp/v1/<id>/+` grant is gone; the bootstrap answer carries `mqtt.password = "device_jwt"` and `mqtt.wsUrl` only for a gateway whose WebSocket fallback the platform admin enabled. `contract/device-protocol.json`: `x-protocol-version`, `x-mqtt-auth`, `x-acl`.
> **Protocol 1.1 (2026-10-21, D-227, release review #4 — additive):** `TelemetryBatch.seqEpoch` (optional, `^[A-Za-z0-9-]{8,64}$`): the id of the gateway's sequence space, created by the agent together with its state database. A batch without it (agents before 1.1) belongs to the epoch `-` of its gateway.

## 1. Transport & identity
- Broker: the Collective platform's shared EMQX 5.8 (D-233, D-235), MQTT 5 over TLS 1.2+ on 8883 (mutual TLS; 1883 is internal to the platform); **WebSocket fallback** `wss://<MQTT_HOST>/mqtt` (443, TLS ending at the platform's Caddy, EMQX ws listener behind it) for a building whose network blocks 8883 — **per gateway, off by default**, enabled by the platform admin; on that path the gateway has no client certificate and authenticates with its device JWT alone (D-239).
- Identity: per-gateway X.509 client certificate issued at bootstrap (`POST /v1/device/bootstrap`, HTTPS, with the one-time provisioning code printed on the gateway QR; the serial is optional). The CSR (PKCS#10, EC P-256/SHA-256) carries `CN=gw-provisioning` (or already `CN=gw-<gatewayId>`); the platform CA **sets** `CN = gw-<gatewayId>`, `extendedKeyUsage=clientAuth`, 12 months. The `201` answer carries `gatewayId`, `certificatePem`, `caChainPem` (also the trust anchor of the broker's server certificate), `mqtt.url` (and `mqtt.wsUrl` only for a gateway whose WebSocket fallback the platform admin enabled — D-239), `mqtt.password = "device_jwt"` (1.2), and the device JWT as `deviceToken { accessToken, expiresAt }` (plus the token pair). A second use of the code answers `401 device.provisioning_code_invalid`; any 4xx means "ask for a new code".
- Device JWT: `POST /v1/device/token` with the client certificate only (mTLS, body `{}`) → `200 { accessToken, expiresAt }` (`aud=device`); the agent refreshes one minute before `expiresAt` and never writes the token to disk. Every other `/v1/device/*` call sends `Authorization: Bearer <device JWT>`; when it also presents a client certificate, it must be the same gateway's.
- Renewal: `POST /v1/device/certificate/renew` (mTLS + bearer, `{ csrPem }` with a **new** key, `CN=gw-<gatewayId>`) → `200 { certificatePem, caChainPem, notAfter }`; due 11 calendar months after `notBefore` or 30 days before `notAfter`, whichever is first, retried hourly. The old certificate stays valid until it expires; the agent reconnects MQTT with the new one. Certificates are revoked when the gateway is retired.
- MQTT login (1.2, D-244): client id = username = `gw-<gatewayId>` (= the certificate CN on 8883), password = a device JWT of this gateway obtained just before connecting (`POST /v1/device/token`); on a refused CONNECT (bad username/password, not authorised) the agent fetches a new token and retries with back-off, keeping readings in its store.
- Broker ACL (from the API's device registry, `smart.mqtt_acl`, answered by the API's EMQX HTTP authz — §1a): a gateway may publish only to `gp/v1/<gatewayId>/telemetry`, `…/health` (also its LWT), `…/events` and `…/cmd/ack` (QoS ≤ 1, never retained), and subscribe only to `gp/v1/<gatewayId>/config` and `gp/v1/<gatewayId>/cmd`. Anything else disconnects the gateway (EMQX `deny_action = disconnect`).
- Clock: the gateway syncs NTP; readings carry the gateway clock; the cloud records `receivedAt` and flags readings whose `readAt` is > 10 min ahead of receipt (`quality: clock_suspect`).

## 1a. Broker → API (internal; not part of the OpenAPI contract)

EMQX asks getproperty-api over the platform's docker network (D-244; collective-infra `platform/docker-compose.yml`).
Every call carries `x-emqx-auth-token` (= `EMQX_AUTH_TOKEN`; empty token = everything refused) and is answered `200`
with `{"result": "allow" | "deny" | "ignore"}` (`allow` also carries `"is_superuser": false`); a missing / wrong token is
`403`, a caller outside `EMQX_HTTP_ALLOWED_CIDRS` `404`.

| Endpoint | Body (EMQX placeholders) | Rule |
|---|---|---|
| `POST /internal/emqx/authn` | `transport` (`mtls` from the 8883 listener, `ws` from the WebSocket listener), `clientid`, `username`, `password`, `cert_common_name`, `cert_subject`, `peerhost` | not `gw-*` → `ignore`; `gw-<uuid>` of a provisioned, non-retired gateway with client id = username: `mtls` → CN = username, a current certificate, and a valid device JWT of that gateway (`aud=device`, `sub`, unexpired, session not revoked) — the JWT may be absent only while `mqtt.authn.require_device_jwt` is off; `ws` → only with the gateway's fallback enabled, always with a valid JWT; anything else `deny` |
| `POST /internal/emqx/authz` | `username`, `clientid`, `topic`, `action` (`publish` \| `subscribe`), `qos`, `retain`, `peerhost` | gateway → `allow` only for its live ACL rows (exact topic; QoS ≤ 1; publishes not retained), else `deny`; getproperty's service users → `allow` below `gp/v1/` (shared subscriptions `$share/<group>/…` included), `ignore` elsewhere; anyone else → `deny` inside `gp/v1/`, `ignore` outside |

Every `deny` of a gateway is audited (`mqtt.authn_denied` / `mqtt.authz_denied`), never with the password.

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
  "seqEpoch": "3f0c9a52-6d1e-4b8a-9a43-0d7c2b1e5f60",                 // 1.1: the sequence space of this gateway's state (D-227)
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
- **Sequence and dedup** (D-143, D-227): `seq` is per meter, monotonic and persisted **in the gateway's state database**; that database carries a random `seqEpoch` created with it and sent on every `TelemetryBatch`. The cloud ignores a reading whose `(gatewayId, seqEpoch, meterId, seq)` was already stored (90-day window, then the unique keys of `smart.telemetry_point` / `smart.meter_reading`) and logs a `duplicate` metric. A replaced or re-flashed gateway (new state database → new epoch, `seq` from 1) and a meter re-bound to another gateway (another `gatewayId`) therefore never collide with the readings of the old sequence space. The agent never reuses an epoch after its state was lost and never resets `seq` within an epoch. A `seq` gap is allowed (buffer eviction) and recorded as an event.
- **Store-and-forward**: readings are appended to an on-disk queue before any publish attempt; publish in batches ≤ 200 readings; delete only on PUBACK. Buffer capacity 30 days at 15-min polling for 300 meters (30 × 96 × 300 = 864,000 readings; the agent's default capacity is 1,000,000, SQLite ≈ 1 GB); when full, evict oldest *interval* readings but never the last reading per meter per hour.
- **Pulse meters**: the gateway holds the register (`initialRegister` + pulses × litres/pulse) and persists it on every pulse batch; a power loss between persists is reported as `quality: estimated_by_gateway` for the first reading after restart; the cloud never trusts pulse registers for billing without a staff-confirmed physical read at install and at every `meter_swap` (D-033).
- **Config**: the gateway applies a config atomically, persists it, publishes `config_applied` with the version; on a failure it keeps the previous config and publishes `config_rejected` with the error. Health reports the applied version so the cloud can detect drift.
- **Commands** expire after `ttlS` (default 300 s); the gateway acks `accepted` immediately and `done|failed` on completion; the cloud retries unacked commands up to 3 times.
- **OTA**: `ota_apply` carries a manifest URL (signed, from `/v1/device/ota/manifest`; a relative `/v1/device/…` path or a URL on the device host, D-231); the agent verifies the signature, installs to the inactive slot, reboots, health-checks, and rolls back automatically if the new version fails to publish health within 5 min (D-131 rings).

## 5. Security
- No secrets in config payloads; broker credentials are the certificate. The agent never exposes the RS485 bus or GPIO over the network; the local status page is read-only and LAN-only.
- All payloads validated by the cloud against the schemas; an invalid payload is dropped, counted and raises `device.invalid_payload` after a threshold.

## 6. Cloud behaviour (getproperty-api B3, D-183–D-188)
- **HTTPS endpoints** (device JWT; a presented client certificate must be the same gateway's):
  - `GET /v1/device/config` → the latest compiled `GatewayConfig` (the document retained on `gp/v1/<gatewayId>/config`), for a cold start without MQTT (compiled on demand when none exists yet).
  - `GET /v1/device/ota/manifest?releaseId=<uuid>` → the signed manifest below, for the gateway's architecture only (`404` otherwise); without `releaseId` the release of the newest rollout that targeted the gateway.
  - `GET /v1/device/ota/artifacts/<version>/<file>` → the release artefact (`application/octet-stream`, `Content-Length` = signed size, `ETag` = sha256), streamed from the platform's private release store, only for a registered non-deprecated release of the gateway's architecture whose `artifact.url` is this path (`404` otherwise; no range requests) — D-231.
  - These endpoints live on the **device host** (client certificates); every URL the cloud hands a gateway for them is a relative `/v1/device/…` path or an absolute URL on the device host, never the public API host (D-231, edge CR-012). The agent fetches any `/v1/device/…` path from its device host with mTLS + bearer, and other origins without credentials.
  - `POST /v1/device/readings/batch` — body = `TelemetryBatch` of the calling gateway (another `gatewayId` → `422 device.invalid_payload`); same pipeline as MQTT; `200 { accepted, duplicates, rejected: [{ meterId, seq, reason }] }`. Any 2xx means durable; replays are harmless (dedup `(gatewayId, seqEpoch, meterId, seq)`, D-227); an `Idempotency-Key` header is accepted and ignored (CR-009).
- **OTA manifest** (edge CR-011; `ota_apply.args.manifestUrl` = `/v1/device/ota/manifest?releaseId=<uuid>`):
  ```jsonc
  { "schema": 1, "version": "0.4.0", "channel": "stable",              // stable | beta | canary
    "arch": "arm64",                                                      // arm64 | x64 | armv7
    "artifact": { "url": "https://<device host>/v1/device/ota/artifacts/0.4.0/getproperty-edge-0.4.0-linux-arm64",
                  "sha256": "<64 hex>", "size": 48211234 },
    "minAgentVersion": "0.3.0", "releasedAt": "2026-10-15T09:00:00Z",
    "signature": { "alg": "ed25519", "keyId": "gp-ota-2026", "value": "<base64>" } }
  ```
  The signature covers the canonical JSON of the manifest **without** `signature` (keys sorted recursively, no whitespace). The API refuses a release whose signature does not verify against `OTA_SIGNING_PUBLIC_KEYS`, and one whose device-surface artefact is not yet stored with the signed size (`ota.artifact_missing`); the agent verifies again with its baked-in keys. The agent reports `ota_started`, `ota_applied` (`data.version`), `ota_failed` / `ota_rolled_back` (`data.error`) on `…/events`; `ota_applied` sets the gateway's firmware version.
- **Authorisation of readings**: a reading is stored only when the meter channel `(gatewayId, meterId)` is open at its `readAt`; otherwise it is refused (audited, `unbound_meter` device event), never re-attributed.
- **Refused payloads** (malformed JSON, schema violation, unknown topic, unknown/retired gateway, topic ≠ `gatewayId`, more than 200 readings → also a `batch_too_large` event) are kept as dead letters for an admin replay; messages that still fail after retries are dead-lettered as `processing_error` (QoS 1 is acknowledged on receipt).
- **Billing candidates**: the first stored reading of each 60-minute interval per meter (`readings.iot_promotion_minutes`) becomes a `smart.meter_reading` (`source: iot`); `register_decrease` goes to the owner review queue, `clock_suspect` / `estimated_by_gateway` / `overflow_corrected` are accepted with a lower confidence. Every point stays in telemetry for the usage charts.
- **Presence**: `online` on the next `Health` after `provisioned`/`offline` (telemetry refreshes `lastSeenAt`), `degraded` while `Health.meters[]` reports a non-`ok` meter, `offline` on the LWT or after 5 missed heartbeats (`health.gateway_missed_heartbeats` × `heartbeatS`).
- **Config drift**: a gateway whose `Health.configVersion` / `config_applied` lags the latest compiled version for more than 15 min (`health.config_drift_minutes`) is flagged once per version (`config_drift` device event, `driftFlaggedAt` in the device views); the config is never re-published unless its content changed.
- **Commands**: re-sent every 60 s while unacknowledged, at most 3 times, then `expired`; `ttlS` 300 (`ota_apply` 3,600).
