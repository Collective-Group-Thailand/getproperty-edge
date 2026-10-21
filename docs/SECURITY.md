# Security review checklist — getproperty-edge

Reviewed for E1.4 (2026-10-17); updated for device protocol 1.2 (2026-10-22, D-235, D-239, D-244). `[x]` = implemented and covered by a test; `[~]` = implemented, needs
verification on the pilot hardware; `[ ]` = open. Test references in parentheses.

## Identity and secrets on disk

- [x] The device key (ECDSA P-256) is generated on the gateway and never leaves it; the cloud only sees a
      CSR (`test/unit/identity.test.ts`, `test/int/store-and-forward.test.ts` bootstrap).
- [x] `device.key`, `device.crt`, `ca.pem`, `identity.json` are 0600 in a 0700 directory owned by the service
      user; looser permissions are tightened at every load (`identity.test.ts`).
- [x] The certificate must match the key and carry CN `gw-<gatewayId>` before it is stored, and again at every load
      (the CN is the MQTT username / client id of protocol 1.2) (`protocol-1-2.test.ts`).
- [x] No other secret is written to disk: the device JWT (HTTPS bearer and, since protocol 1.2, the MQTT password)
      lives in memory only; the provisioning code is
      kept in memory until used (env or status page) and is redacted from logs; `agent.env` holds
      non-secret settings only (`packaging.test.ts`).
- [x] Certificates renew at 11 months with a fresh key (`renewalDueAt`), CR-003.

## Network exposure

- [x] Inbound: only the LAN status page (`:8080`). Read-only (GET/HEAD), no JavaScript, CSP
      `default-src 'none'` + style hash, `X-Frame-Options: DENY`, `nosniff`, `no-store`, per-client rate
      limit, 1 KiB request bodies (`status-page.test.ts`).
- [x] The page exposes no keys, certificates, tokens or provisioning codes (`test/e2e/status-page.spec.ts`
      asserts it on the HTML and `/status.json`). Its per-room registers and last-read times **are** personal
      data (they reveal whether a room is occupied — release review #12, PDPA): the page binds to `127.0.0.1` by
      default (`GP_STATUS_HOST`), and a LAN binding requires the **local admin token** for every request except
      `/healthz` (HTTP Basic with the token as password, or `Authorization: Bearer`; constant-time compare) —
      `GP_STATUS_TOKEN`, else a random token generated into `<stateDir>/status-token` (0600). Loopback clients (an SSH
      session on the gateway) need none (`status-page.test.ts`).
- [x] The one write (`POST /provision`) exists only while the gateway is unprovisioned (afterwards 404) and, from
      the LAN, needs the local admin token like every other request (no CSRF from another host on the network).
- [~] Restrict `:8080` to the LAN with the gateway firewall (template in `docs/RUNBOOK-FIELD.md`).
- [x] RS485 and GPIO are never exposed over the network; the agent opens no other listening socket.
- [x] Outbound MQTT: MQTT 5 over TLS ≥ 1.2 with the client certificate, broker certificate verified
      against the CA chain from bootstrap only — no system roots — including the host name against the certificate
      SAN (`rejectUnauthorized: true`); LWT on `/health`. Plain `mqtt://` / `ws://` broker URLs are refused except
      for a loopback dev broker (`assertSecureBrokerUrl`; `platform.test.ts`, `platform-tls.test.ts`).
- [x] **Protocol 1.2 login** (D-235, D-244): client id = username = `gw-<gatewayId>` (= the certificate CN) and the
      password is a **device JWT** of this gateway (`POST /v1/device/token` over mTLS, ≤ 1 h), taken before every
      (re)connect with ≥ 5 min of validity left, else freshly issued. A refused CONNECT (0x86 / 0x87 / 0x8C) makes the
      agent drop the cached token and log in again with a new one under back-off; without a token the agent does not
      connect at all (no certificate-only attempt). The password is redacted from logs (`password`, `*.password`) and
      is only sent after the broker certificate verified — a foreign broker never sees it (`platform-tls.test.ts`).
- [x] **Token rotation**: the broker checks the password only at CONNECT, so the agent fetches a new JWT shortly
      before the current one expires (5 min lead, ≤ ¼ of the lifetime, plus up to 2 min jitter across the fleet) and
      only then reconnects with it — DISCONNECT (normal) first, so the broker publishes no LWT and the API sees no
      offline flap; unacknowledged publishes are re-sent from the disk queue. If the token endpoint is down the live
      session is kept and the refresh retried (`platform-tls.test.ts`: rotation, outage at rotation time).
- [x] **Exact ACL** (protocol 1.2): the link publishes only to `telemetry`, `health`, `events`, `cmd/ack` (QoS 1,
      never retained) and subscribes only to `config`, `cmd` — the contract's `x-acl`, narrowed by the bootstrap
      `mqtt.acl` stored with the identity; any other topic is refused locally before it reaches the broker (where it
      would disconnect the gateway, `deny_action = disconnect`) (`protocol-1-2.test.ts`, `platform-tls.test.ts`).
- [x] Outbound HTTPS only; plain HTTP is refused except for loopback dev stubs (`assertSecureUrl`, also at boot for
      `GP_API_URL`). `GP_API_CA_FILE` adds a CA to the system roots (it no longer replaces them).
- [x] Device credentials (client certificate, device JWT) go only to the configured device host: cloud-supplied URLs
      with a `/v1/device/*` path are routed there, any other origin is fetched anonymously (`deviceRoute`, CR-012). The
      api sends `manifestUrl` relative and serves OTA artefacts itself on the device host
      (`/v1/device/ota/artifacts/<version>/<file>`, from the private bucket, api D-231), so a gateway needs only two
      egress destinations: `DEVICE_HOST:443` and `MQTT_HOST:8883`. Artefacts are still verified by ed25519 manifest
      signature + size + sha256 before install.
- [x] **No silent downgrade (D-239, O-012 resolved)**: the WebSocket fallback `wss://<MQTT_HOST>/mqtt` is used only when
      **both** the platform admin enabled it for this gateway (the bootstrap answer then carries `mqtt.wsUrl` — the URL
      is never derived from the 8883 one) **and** the gateway runs with `GP_MQTT_WS_FALLBACK=on` (`install.sh
--mqtt-ws-fallback on`); then only after 3 consecutive transport failures on 8883 (a refused login on 8883 never
      switches), with a `warn` log on every switch, and the status page shows _(WebSocket fallback)_. On that path
      TLS ends at the platform's Caddy, whose certificate must chain to the bootstrap `caChainPem` with the host name
      verified — a proxy with a public certificate fails closed before the JWT is sent; no client certificate is
      presented and the **device JWT is the only credential** (accepted risk, api ADR-0015: a stolen JWT connects as
      that gateway for ≤ 1 h, confined to its topics). Refused WebSocket logins (fallback switched off) send the agent
      back to 8883; while on WebSocket it re-tries 8883 at a token rotation at most once an hour. During an outage of
      both, readings go over the HTTPS fallback on the device host (mTLS + bearer) after `GP_HTTPS_FALLBACK_AFTER_S`.

## Cloud endpoints on Collective's platform (D-230)

getproperty-api runs on Collective's shared AWS platform (collective-infra branch `getproperty/r1-platform`,
api `docs/deployment.md` §4–§5). What the gateway talks to:

| Endpoint                                                                                                          | Default / source                                                                              | Authentication                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device host `https://device.getproperty.co` (`GP_API_URL`, Caddy `DEVICE_HOST`, public Let's Encrypt certificate) | `DEFAULT_DEVICE_API_URL` in `src/env.ts`, `install.sh --api-url`                              | Caddy `client_auth verify_if_given` against the device CA → forwards only the certificate SHA-256 (`X-Client-Cert-Sha256`, api `DEVICE_MTLS_SOURCE=sha256_header`); bootstrap without a certificate (one-time code), everything else with it + device JWT. Only `/v1/device/*` and `/health` are routed.                                                                        |
| Broker `mqtts://mqtt.getproperty.co:8883` (EMQX `ssl:default`)                                                    | bootstrap `mqtt.url` (`MQTT_PUBLIC_URL`); `GP_MQTT_URL` overrides for tests                   | mutual TLS: server certificate from the device CA (`pnpm device:broker-cert --host <MQTT_HOST>`), `verify_peer` + `fail_if_no_peer_cert`; HTTP authn by getproperty-api (D-244): certificate CN `gw-<gatewayId>` = username = client id + the gateway's own **device JWT as password** (`mqtt.authn.require_device_jwt`, on by default); exact ACL (`deny_action = disconnect`) |
| WebSocket fallback `wss://mqtt.getproperty.co/mqtt` (Caddy → EMQX `ws:default` 8083)                              | bootstrap `mqtt.wsUrl` — only for a gateway whose fallback the platform admin enabled (D-239) | TLS ends at Caddy (certificate from the device CA, verified against `caChainPem`); **no client certificate**, username = client id = `gw-<gatewayId>`, device JWT alone; agent uses it only with `GP_MQTT_WS_FALLBACK=on` and after 3 failed 8883 attempts                                                                                                                      |

- [~] Verify on the first UAT deploy (D-230 is UNVERIFIED until then): bootstrap through `DEVICE_HOST`, an MQTT session
  on 8883 with the device-CA broker certificate, telemetry/health/events/acks accepted by the ACL, the HTTPS
  fallback through Caddy's client-certificate check, OTA manifest and artefact fetch through the device host.
- [ ] Broker certificate renewal (397 days, LAUNCH-CHECKLIST §5): gateways keep working across it as long as the new
      certificate is issued from the same device CA; a device-CA rotation needs a CA bundle (old + new) in
      `caChainPem` before the switch.
- [x] Broker ACL confines a gateway to its four publish and two subscribe topics (in-process broker enforces the
      protocol 1.2 ACL, the device-JWT login and the WebSocket rules in tests — `tools/test-broker.ts`; EMQX asks
      getproperty-api `POST /internal/emqx/authn|authz`, D-244).
- [~] Verify protocol 1.2 against the live EMQX on the first UAT deploy: CONNECT with the JWT on 8883, refusal of an
  agent without one, the ACL disconnect on a fifth topic, and — for one test gateway with the fallback on — the WSS
  path through Caddy with the device-CA certificate on `MQTT_HOST`.

## Payloads

- [x] Every outgoing envelope is validated against the contract schema before it leaves; a corrupted
      queued reading is dropped and counted, never published (`forwarder.test.ts`).
- [x] Incoming config and commands are schema-validated; configs semantically validated; commands expire
      (`ttlS`) and a cmdId never executes twice (`commands.test.ts`).
- [x] Logs redact `provisioningCode`, `accessToken`, `password`, `privateKey`, `authorization`; `upload_logs`
      bundles carry no key material (`agent-ops.test.ts`).

## Updates (OTA)

- [x] Manifests are signed with ed25519 over canonical JSON; only key ids baked into the build are
      trusted; a build without keys refuses every update (fail closed) (`ota.test.ts`).
- [x] Artefact integrity: exact size + sha256 while streaming into the inactive slot; HTTPS only; no
      downgrade or same version; architecture and `minAgentVersion` checked.
- [x] A/B slots with a post-boot health gate (health PUBACK within 5 min or roll back) and
      `ota-guard.sh` (ExecStartPre) rolling back a binary that cannot start three times
      (`ota.test.ts`, `ota-and-boot.test.ts`).
- [x] The guard script and `/opt/getproperty-edge` are root-owned; only `slots/` is writable by the agent.
- [ ] Signing-key custody: the ed25519 private key lives offline / in the release pipeline's secret
      store (GitHub Actions secret `OTA_SIGNING_KEY`); rotation = bake the new key id next to the old one
      for one release, then drop the old one. Owner: platform admin (to be confirmed).
- Accepted risk: the service user can write its own slots (needed for self-update). Mitigation: only
  signature-verified artefacts are installed, the unit is sandboxed, and the guard is outside its reach.

## Process hardening (systemd unit)

- [x] Unprivileged `gpedge` user (groups `dialout`, `gpio`), `NoNewPrivileges`, empty capability set,
      `ProtectSystem=strict` with write access only to the state dir and `slots/`, `ProtectHome`,
      `PrivateTmp`, kernel/cgroup/clock protection, `RestrictAddressFamilies`, `DevicePolicy=closed`
      with only tty/gpiochip devices, `UMask=0077`, `MemoryMax=320M` (`packaging.test.ts`).
- [x] `Restart=always` + in-process event-loop watchdog (SIGKILL on a stalled loop, `watchdog.test.ts`) + systemd hardware watchdog `RuntimeWatchdogSec=30` (install.sh).
- [~] Verify the sandbox does not block LED/serial/GPIO access on the pilot carrier.
