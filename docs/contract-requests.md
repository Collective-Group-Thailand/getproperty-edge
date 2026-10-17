# Contract requests from getproperty-edge → getproperty-api

`docs/contract/*` and `docs/decisions.md` are owned by getproperty-api and synced here; this file lists
what the edge agent needs from the api contract that is not (yet) in `contract/openapi.json` /
`contract/device-protocol.json`. The agent is coded against the shapes below; each entry says what the
agent does today. Status: **open** until the api publishes it, then **done (api commit)**. All of CR-001…CR-011 were closed
by getproperty-api in `13be5a7` (A, contract requests for B1–B3) and `e00cfae` (B3 metering & IoT); triage in
`getproperty-api/docs/contract-requests-triage.md`, protocol §1/§3/§4/§6. Re-synced here on 2026-10-17
(`protocol.lock.json` sha256 `70f75936…`).

| #      | Need                                                                                                          | Agent behaviour today                                                                                                                                                                                                                         | Status                                |
| ------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| CR-001 | `POST /v1/device/bootstrap` (public, rate-limited, one-time provisioning code)                                | implemented (`src/identity/bootstrap.ts`); a reused code answers **401** (not 422) — any 4xx already meant "ask for a new code"                                                                                                               | done (api A `13be5a7`)                |
| CR-002 | `POST /v1/device/token` (mTLS) → short-lived device JWT                                                       | used for every `deviceBearer` call (`src/identity/token.ts`); token never written to disk                                                                                                                                                     | done (api A `13be5a7`)                |
| CR-003 | `POST /v1/device/certificate/renew` (mTLS + bearer) with a new CSR                                            | renewal at 11 months (`src/identity/renewal.ts`); the answer's `notAfter` is informational (validity is read from the certificate)                                                                                                            | done (api A `13be5a7`)                |
| CR-004 | `POST /v1/device/logs/presign` response shape                                                                 | `upload_logs` (`src/commands/log-upload.ts`); bundle ≤ 50 MB; the ack result carries the api's `fileId`                                                                                                                                       | done (api A `13be5a7`)                |
| CR-005 | `MeterConfig.registerMap = "custom"` has no field carrying the map                                            | `customRegisterMap` → in-memory register map per meter (`mapFromCustom`, per-register holding/input function, word order, uint16…float64, decimal scale); `energy` = register, `voltage`/`current`/`power` → `extra`                          | done (api A `13be5a7` / B3 `e00cfae`) |
| CR-006 | Broker ACL: `gp/v1/<gatewayId>/+` does not match `gp/v1/<gatewayId>/cmd/ack` (two levels)                     | publishes acks on `…/cmd/ack`; the ACL grants it explicitly (protocol §1); the test broker mirrors it                                                                                                                                         | done (api A `13be5a7`)                |
| CR-007 | A reading whose register **decreased** has no quality value                                                   | the reading is sent unchanged with `quality: register_decrease` (highest precedence) and a `tamper` event (warning, `data.reason = "register_decrease"`) is still raised                                                                      | done (api A `13be5a7` / B3 `e00cfae`) |
| CR-008 | Protocol §4 says 30 days × 300 meters × 15 min ≈ "8.6 M readings"; the product is 864,000                     | default capacity 1,000,000 readings (`GP_QUEUE_CAPACITY`), eviction per §4; §4 now says 864,000                                                                                                                                               | done (api A `13be5a7`)                |
| CR-009 | `POST /v1/device/readings/batch` (fallback, api-conventions §7) response and idempotency                      | body = `TelemetryBatch`; any 2xx = durable (rows deleted); `200 { accepted, duplicates, rejected[] }` — rejected readings are logged (dead-lettered by the api, never re-sent); `Idempotency-Key` still sent (accepted and ignored, D-185)    | done (api B3 `e00cfae`)               |
| CR-011 | `GET /v1/device/ota/manifest` body = the signed OTA manifest below; `ota_apply.args.manifestUrl` points at it | implemented (`src/ota/`); channel `stable/beta/canary`, arch `arm64/x64/armv7` (unknown values refused); `manifestUrl` `…/ota/manifest?releaseId=` (relative URLs resolve against the API); `ota_failed`/`ota_rolled_back` carry `data.error` | done (api B3 `e00cfae`)               |
| CR-010 | `DeviceEvent.configVersion` is a string, `GatewayConfig.version` / `Health.configVersion` are integers        | the agent sends `String(version)`                                                                                                                                                                                                             | done (api A `13be5a7`, info)          |

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
- The code is single-use: the second use answers `401 device.provisioning_code_invalid` (problem+json; the request said 422);
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
→ `200 { "certificatePem": "…", "caChainPem": "…", "notAfter": "<ISO>" }`. The old certificate stays valid until it expires; the
agent reconnects MQTT with the new one. Due 11 calendar months after `notBefore`, or 30 days before
`notAfter`, whichever is first; retried hourly on failure.

## CR-004 `POST /v1/device/logs/presign`

mTLS + bearer; body `{ "contentType": "application/gzip", "sizeBytes": 18234, "sha256": "<hex>" }` →
`200 { "fileId": "<uuid>", "uploadUrl": "https://…", "method": "PUT", "headers": { "x-goog-…": "…" }, "expiresAt": "<ISO>" }`.
The agent PUTs the gzip bundle (journal of the last N hours + in-memory log ring; no secrets) and acks
`upload_logs` with `{ "bytes": …, "sha256": "…" }`.

## CR-011 OTA manifest (`GET /v1/device/ota/manifest`, mTLS + bearer)

```json
{
  "schema": 1,
  "version": "0.2.0",
  "channel": "canary",
  "arch": "arm64",
  "artifact": {
    "url": "https://releases.getproperty.co/edge/0.2.0/getproperty-edge-0.2.0-linux-arm64",
    "sha256": "<hex>",
    "size": 129240256
  },
  "minAgentVersion": "0.1.0",
  "releasedAt": "2026-11-01T00:00:00Z",
  "signature": { "alg": "ed25519", "keyId": "gp-ota-2026", "value": "<base64>" }
}
```

- Produced by `pnpm image` in this repo; the api stores and serves it per fleet ring (D-131) and sends
  `ota_apply` with `{ "manifestUrl": "<api>/v1/device/ota/manifest?…" }`.
- Signature: ed25519 over the canonical JSON of the manifest without `signature` (keys sorted
  recursively, no whitespace). The agent trusts only key ids baked into its build; it refuses
  non-HTTPS artefacts, downgrades, other architectures and agents older than `minAgentVersion`.
- Events: `ota_started` (download begins), `ota_failed` (verification/download/integrity),
  `ota_applied` (the new version published health within 5 min), `ota_rolled_back` (health gate missed or
  the binary failed to start 3 times), each with `data.version`/`fromVersion`.
- If the artefact URL is on the API origin the agent presents its client certificate + bearer; other
  origins (CDN, signed GCS URL) are fetched without credentials.
