# Security review checklist — getproperty-edge

Reviewed for E1.4 (2026-10-17). `[x]` = implemented and covered by a test; `[~]` = implemented, needs
verification on the pilot hardware; `[ ]` = open. Test references in parentheses.

## Identity and secrets on disk

- [x] The device key (ECDSA P-256) is generated on the gateway and never leaves it; the cloud only sees a
      CSR (`test/unit/identity.test.ts`, `test/int/store-and-forward.test.ts` bootstrap).
- [x] `device.key`, `device.crt`, `ca.pem`, `identity.json` are 0600 in a 0700 directory owned by the service
      user; looser permissions are tightened at every load (`identity.test.ts`).
- [x] The certificate must match the key and carry CN `gw-<gatewayId>` before it is stored.
- [x] No other secret is written to disk: the device JWT lives in memory only; the provisioning code is
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
- [x] Outbound HTTPS only; plain HTTP is refused except for loopback dev stubs (`assertSecureUrl`, also at boot for
      `GP_API_URL`). `GP_API_CA_FILE` adds a CA to the system roots (it no longer replaces them).
- [x] Device credentials (client certificate, device JWT) go only to the configured device host: cloud-supplied URLs
      with a `/v1/device/*` path are routed there, any other origin is fetched anonymously (`deviceRoute`, CR-012).
- [x] **No silent downgrade (O-012)**: the WSS-on-443 fallback is off unless `GP_MQTT_WS_FALLBACK=on`, and then it is
      held to the 8883 rules (bootstrap-CA server certificate, client certificate), so a TLS-terminating proxy with a
      public certificate fails closed. During an 8883 outage readings go over the HTTPS fallback on the device host
      (mTLS + bearer) after `GP_HTTPS_FALLBACK_AFTER_S`.

## Cloud endpoints on Collective's platform (D-230)

getproperty-api runs on Collective's shared AWS platform (collective-infra branch `getproperty/r1-platform`,
api `docs/deployment.md` §4–§5). What the gateway talks to:

| Endpoint                                                                                                          | Default / source                                                            | Authentication                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device host `https://device.getproperty.co` (`GP_API_URL`, Caddy `DEVICE_HOST`, public Let's Encrypt certificate) | `DEFAULT_DEVICE_API_URL` in `src/env.ts`, `install.sh --api-url`            | Caddy `client_auth verify_if_given` against the device CA → forwards only the certificate SHA-256 (`X-Client-Cert-Sha256`, api `DEVICE_MTLS_SOURCE=sha256_header`); bootstrap without a certificate (one-time code), everything else with it + device JWT. Only `/v1/device/*` and `/health` are routed. |
| Broker `mqtts://mqtt.getproperty.co:8883` (EMQX `ssl:default`)                                                    | bootstrap `mqtt.url` (`MQTT_PUBLIC_URL`); `GP_MQTT_URL` overrides for tests | mutual TLS: server certificate from the device CA (`pnpm device:broker-cert --host <MQTT_HOST>`), `verify_peer` + `fail_if_no_peer_cert`, username and client id = certificate CN `gw-<gatewayId>`, ACL from `smart.mqtt_acl` (`deny_action = disconnect`)                                               |
| WSS on 443                                                                                                        | bootstrap `mqtt.wsUrl`                                                      | **not available in R1** (O-012) — ignored unless `GP_MQTT_WS_FALLBACK=on`                                                                                                                                                                                                                                |

- [~] Verify on the first UAT deploy (D-230 is UNVERIFIED until then): bootstrap through `DEVICE_HOST`, an MQTT session
  on 8883 with the device-CA broker certificate, telemetry/health/events/acks accepted by the ACL, the HTTPS
  fallback through Caddy's client-certificate check, OTA manifest fetch through the device host.
- [ ] Broker certificate renewal (397 days, LAUNCH-CHECKLIST §5): gateways keep working across it as long as the new
      certificate is issued from the same device CA; a device-CA rotation needs a CA bundle (old + new) in
      `caChainPem` before the switch.
- [x] Broker ACL confines a gateway to `gp/v1/<own id>/…` (in-process broker enforces the protocol §1
      ACL in tests; EMQX ACL needs `…/cmd/ack`, CR-006).

## Payloads

- [x] Every outgoing envelope is validated against the contract schema before it leaves; a corrupted
      queued reading is dropped and counted, never published (`forwarder.test.ts`).
- [x] Incoming config and commands are schema-validated; configs semantically validated; commands expire
      (`ttlS`) and a cmdId never executes twice (`commands.test.ts`).
- [x] Logs redact `provisioningCode`, `accessToken`, `privateKey`, `authorization`; `upload_logs`
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
