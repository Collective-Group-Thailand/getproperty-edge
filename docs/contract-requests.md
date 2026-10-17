# Contract requests from getproperty-edge → getproperty-api

`docs/contract/*` and `docs/decisions.md` are owned by getproperty-api and synced here; this file lists
what the edge agent needs from the api contract that is not (yet) in `contract/openapi.json` /
`contract/device-protocol.json`. The agent is coded against the shapes below; each entry says what the
agent does today. Status: **open** until the api publishes it, then **done (api vX.Y)**.

| #      | Need                                                                                                   | Agent behaviour today                                                                                                                                                                                                          | Status |
| ------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| CR-001 | `POST /v1/device/bootstrap` (public, rate-limited, one-time provisioning code)                         | implemented against the shape below (`src/identity/bootstrap.ts`)                                                                                                                                                              | open   |
| CR-002 | `POST /v1/device/token` (mTLS) → short-lived device JWT                                                | used for every `deviceBearer` call (`src/identity/token.ts`); token never written to disk                                                                                                                                      | open   |
| CR-003 | `POST /v1/device/certificate/renew` (mTLS + bearer) with a new CSR                                     | renewal at 11 months (`src/identity/renewal.ts`)                                                                                                                                                                               | open   |
| CR-004 | `POST /v1/device/logs/presign` response shape                                                          | `upload_logs` command (`src/commands/log-upload.ts`)                                                                                                                                                                           | open   |
| CR-005 | `MeterConfig.registerMap = "custom"` has no field carrying the map                                     | the agent **rejects** a config with `custom` (config_rejected); new models ship as built-in JSON maps (D-013)                                                                                                                  | open   |
| CR-006 | Broker ACL: `gp/v1/<gatewayId>/+` does not match `gp/v1/<gatewayId>/cmd/ack` (two levels)              | the agent publishes acks on `…/cmd/ack` as the topic table says; EMQX ACL must allow it explicitly                                                                                                                             | open   |
| CR-007 | A reading whose register **decreased** has no quality value                                            | the reading is sent unchanged (never dropped) and a `tamper` event (warning) carries `data.reason = "register_decrease"`, `previous`, `current`; request: `ReadingQuality.register_decrease` or event type `register_decrease` | open   |
| CR-008 | Protocol §4 says 30 days × 300 meters × 15 min ≈ "8.6 M readings"; the product is 864,000              | default capacity 1,000,000 readings (`GP_QUEUE_CAPACITY`), eviction per §4; please correct the figure                                                                                                                          | open   |
| CR-009 | `POST /v1/device/readings/batch` (fallback, api-conventions §7) response and idempotency               | body = `TelemetryBatch`; any 2xx = durable (rows deleted); `Idempotency-Key: <meterId>:<seq>:<count>` of the first reading; dedup stays `(meterId, seq)`                                                                       | open   |
| CR-010 | `DeviceEvent.configVersion` is a string, `GatewayConfig.version` / `Health.configVersion` are integers | the agent sends `String(version)`                                                                                                                                                                                              | info   |

## CR-001 `POST /v1/device/bootstrap`

No client certificate (the gateway has none yet). Request:

```json
{
  "provisioningCode": "GP7K-Q2MX-9TZ4",
  "csrPem": "-----BEGIN CERTIFICATE REQUEST-----\n…",
  "agentVersion": "0.1.0",
  "hardware": { "arch": "arm64", "hostname": "gw-pilot-01", "serial": "10000000abcdef01" }
}
```

- The CSR is PKCS#10, ECDSA P-256 / SHA-256, subject `CN=gw-provisioning`; the CA **sets** `CN=gw-<gatewayId>`
  and `extendedKeyUsage=clientAuth`; validity 12 months (protocol §1).
- The code is single-use: the second use answers `422 device.provisioning_code_invalid` (problem+json);
  any 4xx makes the agent ask for a new code on the status page; 5xx/network errors are retried.

`201` response:

```json
{
  "gatewayId": "0192a000-0000-7000-8000-00000000aaaa",
  "certificatePem": "-----BEGIN CERTIFICATE-----\n…",
  "caChainPem": "-----BEGIN CERTIFICATE-----\n…",
  "mqtt": { "url": "mqtts://broker.getproperty.co:8883", "wsUrl": "wss://broker.getproperty.co/mqtt" },
  "deviceToken": { "accessToken": "<JWT aud=device>", "expiresAt": "2026-11-01T00:30:00+07:00" }
}
```

The agent checks that the certificate matches its key and that the CN is `gw-<gatewayId>`, then stores
`device.key`, `device.crt`, `ca.pem` (0600) and `identity.json` (gatewayId, broker URLs). `caChainPem` is
also the trust anchor for the broker's server certificate.

## CR-002 `POST /v1/device/token`

mTLS with the device certificate, empty JSON body `{}` → `200 { "accessToken": "<JWT>", "expiresAt": "<ISO>" }`.
The agent refreshes one minute before `expiresAt`.

## CR-003 `POST /v1/device/certificate/renew`

mTLS + `Authorization: Bearer <device JWT>`; body `{ "csrPem": "…" }` with a **new** key (CN `gw-<gatewayId>`)
→ `200 { "certificatePem": "…", "caChainPem": "…" }`. The old certificate stays valid until it expires; the
agent reconnects MQTT with the new one. Due 11 calendar months after `notBefore`, or 30 days before
`notAfter`, whichever is first; retried hourly on failure.

## CR-004 `POST /v1/device/logs/presign`

mTLS + bearer; body `{ "contentType": "application/gzip", "sizeBytes": 18234, "sha256": "<hex>" }` →
`200 { "uploadUrl": "https://…", "method": "PUT", "headers": { "x-goog-…": "…" }, "expiresAt": "<ISO>" }`.
The agent PUTs the gzip bundle (journal of the last N hours + in-memory log ring; no secrets) and acks
`upload_logs` with `{ "bytes": …, "sha256": "…" }`.
