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
- [x] The page exposes nothing sensitive: no keys, certificates, tokens or provisioning codes
      (`test/e2e/status-page.spec.ts` asserts it on the HTML and `/status.json`). It shows meter ids,
      room codes and registers — accepted as non-sensitive on the building LAN (no auth by design, CLAUDE.md).
- [x] The one write (`POST /provision`) exists only while the gateway is unprovisioned; afterwards 404.
- [~] Restrict `:8080` to the LAN with the gateway firewall (template in `docs/RUNBOOK-FIELD.md`).
- [x] RS485 and GPIO are never exposed over the network; the agent opens no other listening socket.
- [x] Outbound MQTT: MQTT 5 over TLS ≥ 1.2 with the client certificate, broker certificate verified
      against the CA chain from bootstrap (`rejectUnauthorized: true`); LWT on `/health`.
- [x] Outbound HTTPS only; plain HTTP is refused except for loopback dev stubs (`assertSecureUrl`).
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
