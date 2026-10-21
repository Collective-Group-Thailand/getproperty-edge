# Contract requests from getproperty-edge → getproperty-api

`docs/contract/*` and `docs/decisions.md` are owned by getproperty-api and synced here; this file lists
what the edge agent needs from the api contract that is not (yet) in `contract/openapi.json` /
`contract/device-protocol.json`. The agent is coded against the shapes below; each entry says what the
agent does today. Status: **open** until the api publishes it, then **done (api commit)**. All of CR-001…CR-011 were closed
by getproperty-api in `13be5a7` (A, contract requests for B1–B3) and `e00cfae` (B3 metering & IoT); triage in
`getproperty-api/docs/contract-requests-triage.md`, protocol §1/§3/§4/§6. CR-012 and CR-013 were closed by
getproperty-api `5d4fe67` (D-231, triage F10). CR-014 (device protocol 1.2, triage F11-1…F11-3) is implemented against
api `74bdcdc`; CR-015 (current MQTT endpoints on every token refresh) and CR-016 (no change: meter status derived by the api)
were closed by api `a21e2b3` (D-249, triage F12; `protocol.lock.json` sha256 `5e4481de…`, re-pinned 2026-10-22 — still revision 1.2).

| #      | Need                                                                                                                                                                                                                                                                                        | Agent behaviour today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| CR-001 | `POST /v1/device/bootstrap` (public, rate-limited, one-time provisioning code)                                                                                                                                                                                                              | implemented (`src/identity/bootstrap.ts`); a reused code answers **401** (not 422) — any 4xx already meant "ask for a new code"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | done (api A `13be5a7`)                    |
| CR-002 | `POST /v1/device/token` (mTLS) → short-lived device JWT                                                                                                                                                                                                                                     | used for every `deviceBearer` call (`src/identity/token.ts`); token never written to disk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | done (api A `13be5a7`)                    |
| CR-003 | `POST /v1/device/certificate/renew` (mTLS + bearer) with a new CSR                                                                                                                                                                                                                          | renewal at 11 months (`src/identity/renewal.ts`); the answer's `notAfter` is informational (validity is read from the certificate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | done (api A `13be5a7`)                    |
| CR-004 | `POST /v1/device/logs/presign` response shape                                                                                                                                                                                                                                               | `upload_logs` (`src/commands/log-upload.ts`); bundle ≤ 50 MB; the ack result carries the api's `fileId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | done (api A `13be5a7`)                    |
| CR-005 | `MeterConfig.registerMap = "custom"` has no field carrying the map                                                                                                                                                                                                                          | `customRegisterMap` → in-memory register map per meter (`mapFromCustom`, per-register holding/input function, word order, uint16…float64, decimal scale); `energy` = register, `voltage`/`current`/`power` → `extra`                                                                                                                                                                                                                                                                                                                                                                                                        | done (api A `13be5a7` / B3 `e00cfae`)     |
| CR-006 | Broker ACL: `gp/v1/<gatewayId>/+` does not match `gp/v1/<gatewayId>/cmd/ack` (two levels)                                                                                                                                                                                                   | publishes acks on `…/cmd/ack`; the ACL grants it explicitly (protocol §1); the test broker mirrors it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | done (api A `13be5a7`)                    |
| CR-007 | A reading whose register **decreased** has no quality value                                                                                                                                                                                                                                 | the reading is sent unchanged with `quality: register_decrease` (highest precedence) and a `tamper` event (warning, `data.reason = "register_decrease"`) is still raised                                                                                                                                                                                                                                                                                                                                                                                                                                                    | done (api A `13be5a7` / B3 `e00cfae`)     |
| CR-008 | Protocol §4 says 30 days × 300 meters × 15 min ≈ "8.6 M readings"; the product is 864,000                                                                                                                                                                                                   | default capacity 1,000,000 readings (`GP_QUEUE_CAPACITY`), eviction per §4; §4 now says 864,000                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | done (api A `13be5a7`)                    |
| CR-009 | `POST /v1/device/readings/batch` (fallback, api-conventions §7) response and idempotency                                                                                                                                                                                                    | body = `TelemetryBatch`; any 2xx = durable (rows deleted); `200 { accepted, duplicates, rejected[] }` — rejected readings are logged (dead-lettered by the api, never re-sent); `Idempotency-Key` still sent (accepted and ignored, D-185)                                                                                                                                                                                                                                                                                                                                                                                  | done (api B3 `e00cfae`)                   |
| CR-011 | `GET /v1/device/ota/manifest` body = the signed OTA manifest below; `ota_apply.args.manifestUrl` points at it                                                                                                                                                                               | implemented (`src/ota/`); channel `stable/beta/canary`, arch `arm64/x64/armv7` (unknown values refused); `manifestUrl` `…/ota/manifest?releaseId=` (relative URLs resolve against the API); `ota_failed`/`ota_rolled_back` carry `data.error`                                                                                                                                                                                                                                                                                                                                                                               | done (api B3 `e00cfae`)                   |
| CR-010 | `DeviceEvent.configVersion` is a string, `GatewayConfig.version` / `Health.configVersion` are integers                                                                                                                                                                                      | the agent sends `String(version)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | done (api A `13be5a7`, info)              |
| CR-012 | `ota_apply.args.manifestUrl` is built on `PUBLIC_API_BASE_URL` (public API host strips client certificates, D-230)                                                                                                                                                                          | a `/v1/device/*` URL on any origin is fetched from the agent's device host (`GP_API_URL` = `DEVICE_HOST`) with mTLS + bearer; credentials never go to another origin                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **done (api `5d4fe67`, D-231)**           |
| CR-013 | Bootstrap `mqtt.wsUrl` is always sent (`MQTT_PUBLIC_WS_URL`) although the platform has no mTLS WSS endpoint (O-012)                                                                                                                                                                         | stored but **not used** unless `GP_MQTT_WS_FALLBACK=on`; even then held to the 8883 rules (device-CA server certificate, client certificate) — fails closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **done (api `5d4fe67`, D-231)**           |
| CR-014 | **Device protocol 1.2** (api D-235, D-244, D-239; triage F11-1…F11-3): MQTT username = client id = `gw-<gatewayId>`, password = device JWT; bootstrap `mqtt.password` (`MqttPasswordMode`), explicit `mqtt.acl`; `mqtt.wsUrl` only for a gateway whose fallback the admin enabled           | implemented: JWT before every (re)connect (reused with ≥ 5 min left), new token on a refused CONNECT, rotation before expiry with a graceful DISCONNECT, publish/subscribe limited to `x-acl` ∩ bootstrap ACL, WSS only with `wsUrl` **and** `GP_MQTT_WS_FALLBACK=on` (device-CA certificate, no client certificate, JWT alone); `Health.meters[]` kept (required by the contract)                                                                                                                                                                                                                                          | **done (api `74bdcdc`; edge 2026-10-22)** |
| CR-015 | Current MQTT connection info after bootstrap — `mqtt { url, wsUrl? }` in the `POST /v1/device/token` answer                                                                                                                                                                                 | implemented (`mqttEndpointsOf` / `DeviceTokenCache.onMqttEndpoints`, `Agent.applyMqttEndpoints`, `MqttLink.setWsUrl`): every fetched token's `mqtt` block is compared with `identity.json`; a `wsUrl` added or removed by the platform admin is stored (identity.json only, 0600) and handed to the link for its next connect — still only with `GP_MQTT_WS_FALLBACK=on` and the device-CA server-certificate check (fail closed); a non-TLS URL is refused and the stored one kept; a missing / malformed block changes nothing; a different `url` is logged, not applied (moving the 8883 broker stays a re-provisioning) | **done (api `a21e2b3`, D-249)**           |
| CR-016 | Meter status changes on the wire: triage F11-5 / T-13 said health samples no longer carry `meters[]` and status changes are `meter_status_changed` events, while `contract/device-protocol.json` 1.2 still **requires** `Health.meters` and `DeviceEventType` has no `meter_status_changed` | **no protocol change** (api triage F12, D-249): the api derives `meter_status_changed` from `Health.meters[]` itself and stores health samples without the array — F11-5 meant the _stored_ samples. The agent keeps sending `meters[]` in every heartbeat and never emits `meter_status_changed`; a 1.3 revision (gateway-side events, optional `meters`) only if heartbeat size becomes a measured problem                                                                                                                                                                                                                | **done (api `a21e2b3`, closed — info)**   |

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
  "mqtt": { "url": "mqtts://mqtt.getproperty.co:8883", "wsUrl": "wss://mqtt.getproperty.co/mqtt" },
  "deviceToken": { "accessToken": "<JWT aud=device>", "expiresAt": "2026-11-01T00:30:00+07:00" }
}
```

The agent checks that the certificate matches its key and that the CN is `gw-<gatewayId>`, then stores
`device.key`, `device.crt`, `ca.pem` (0600) and `identity.json` (gatewayId, broker URLs). `caChainPem` is
also the **only** trust anchor for the broker's server certificate (no system roots): on Collective's platform
(D-230) EMQX's 8883 listener presents a certificate issued from the device CA by `pnpm device:broker-cert --host
<MQTT_HOST>` (CN and SAN dNSName = the MQTT host, serverAuth), and the agent verifies the host name against that SAN.
EMQX takes username and client id from the client-certificate CN (`gw-<gatewayId>`, the agent's own client id;
no username or password is sent) and authorizes from `smart.mqtt_acl` with `deny_action = disconnect` — the agent
publishes only `…/telemetry|events|health` and `…/cmd/ack` and subscribes only `…/config` and `…/cmd`
(`test/int/platform-tls.test.ts`). `wsUrl`: see CR-013.

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
`200 { "fileId": "<uuid>", "uploadUrl": "https://<bucket>.s3.ap-southeast-7.amazonaws.com/…", "method": "PUT", "headers": { "content-type": "application/gzip", … }, "expiresAt": "<ISO>" }`
(S3 V4 presigned PUT on the platform, D-230; the agent sends exactly the returned headers, without its certificate).
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
    "url": "https://device.getproperty.co/v1/device/ota/artifacts/0.2.0/getproperty-edge-0.2.0-linux-arm64",
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
- If the artefact URL is a `/v1/device/*` path (any origin, CR-012) or on the device-host origin the agent presents its
  client certificate + bearer to the device host; other origins (CDN, presigned S3 URL) are fetched without
  credentials.

## CR-012 `manifestUrl` must reach the device host

On the platform (D-230, api `docs/deployment.md` §4) `/v1/device/*` calls that need the gateway certificate only work
through Caddy's `DEVICE_HOST` (`client_auth verify_if_given` → `X-Client-Cert-Sha256`); `API_HOST` strips that header.
The api's OTA rollout issues `manifestUrl = ${PUBLIC_API_BASE_URL}/v1/device/ota/manifest?releaseId=…` — the public
API host. Agent behaviour (`deviceRoute`, `src/transport/https/device-api.ts`): any URL whose path starts with
`/v1/device/` is fetched from `GP_API_URL` (the device host) with mTLS + bearer, so OTA works with today's api; no
credential is ever sent to a host other than the configured device host. Request: issue the relative form
(`/v1/device/ota/manifest?releaseId=…`, protocol §6 already allows it) or a `DEVICE_PUBLIC_BASE_URL`.

**Done (api `5d4fe67`, D-231)**: `manifestUrl` is now the relative `/v1/device/ota/manifest?releaseId=…` (absolute on
`DEVICE_PUBLIC_BASE_URL` only when that is set); the older absolute form keeps working. OTA artefacts are served by
the api on the device host too: `GET /v1/device/ota/artifacts/<version>/<file>` streams `releases/edge/<version>/<file>`
of the private product bucket to the authenticated gateway, and `pnpm image --base-url` defaults to
`https://device.getproperty.co/v1/device/ota/artifacts` (`test/int/ota-and-boot.test.ts` downloads through it with
mTLS).

## CR-013 No WSS URL while O-012 is open

The bootstrap answer always carries `mqtt.wsUrl` (`MQTT_PUBLIC_WS_URL`, default `wss://mqtt.getproperty.invalid/mqtt`).
On the platform Caddy terminates TLS for `/mqtt`, so a WSS session would reach EMQX without the gateway certificate
(O-012). The agent therefore ignores `wsUrl` unless the installer sets `GP_MQTT_WS_FALLBACK=on`, and even then it
verifies the WSS server against the bootstrap CA only and presents its client certificate — a Caddy endpoint with a
public certificate fails closed, never an unauthenticated fallback. Outages are covered by the HTTPS readings fallback
on the device host. Request: omit `wsUrl` (or send `null`) until O-012 picks an option; option (a) of O-012 also needs
the WSS host to present a certificate from the device CA (the gateway does not trust public roots for the broker).

**Done (api `5d4fe67`, D-231)**: `MQTT_PUBLIC_WS_URL` is unset by default and the bootstrap answer then omits
`mqtt.wsUrl` (OpenAPI: optional); api `docs/deployment.md` §3 documents it as unset on the platform until O-012 is
decided. The agent's handling is unchanged (optional field, `GP_MQTT_WS_FALLBACK` off).

## CR-015 MQTT endpoints on every token refresh (api D-249)

`POST /v1/device/token` (mTLS, body `{}`) →
`200 { "accessToken": "<JWT>", "expiresAt": "<ISO>", "mqtt": { "url": "mqtts://mqtt.getproperty.co:8883", "wsUrl": "wss://mqtt.getproperty.co/mqtt" } }`
— `wsUrl` only while the platform admin has this gateway's WebSocket fallback on (`set-mqtt-transport`) and the platform
publishes one; absent otherwise. The bootstrap answer follows the same rule. The agent (`src/agent.ts`
`applyMqttEndpoints`):

- `wsUrl` appeared → stored in `identity.json`, given to the link when `GP_MQTT_WS_FALLBACK=on`; 8883 stays primary, the
  link fails over to WSS after 3 failed 8883 attempts (as with a bootstrap `wsUrl`), certificate verified against the
  bootstrap CA.
- `wsUrl` disappeared → removed from `identity.json` and the link; the next connect goes to 8883 only (a refused
  WebSocket login fetches a fresh token at once, so a switched-off fallback is dropped on the first refusal).
- A token answer without `mqtt` (an api before D-249) or with a malformed block changes nothing; a non-TLS `wsUrl` is
  refused (logged, stored value kept). A different `url` is logged only.
