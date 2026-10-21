# CLAUDE.md — getproperty-edge

**getproperty — บิลทำเอง เก็บเงินเอง ถูกกฎหมาย** · operated by Collective Group (Thailand)
The gateway agent that runs inside each building on a Linux ARM64 gateway (D-132): polls electric meters over Modbus RTU (RS485), counts water-meter pulses (GPIO) or receives LoRaWAN uplinks, stores readings on disk, and forwards them to `getproperty-api` over MQTT (mTLS + device JWT, protocol 1.2) per `docs/contract/device-protocol.md`. It never computes invoices and never talks to residents. Meters and gateways are `core.asset_item` rows bound to units through `core.meter_assignment` on the cloud side (D-151); readings land in `smart.meter_reading` (D-162: portable telemetry storage). The wire field `roomCode` keeps its name and maps to `unit_no`.

## Read before every task
1. `docs/prompts/00-master-plan.md` — architecture, conventions, run order, Definition of Done.
2. `docs/decisions.md` — decisions D-013, D-030, D-033, D-034, D-130–D-132, D-151 (naming), D-157 (no breaker cut-off), D-162 (telemetry storage), D-230 (cloud on Collective's shared AWS platform), D-231 (device-host URLs, OTA on the device host), D-235 + D-244 (device protocol 1.2: EMQX HTTP authn/authz, device JWT as MQTT password, exact ACL) and D-239 (per-gateway WebSocket fallback, resolves O-012; api ADR-0015) are the ones that bind this repo.
3. **`docs/contract/device-protocol.md`** — the MQTT contract (identical copy owned by `getproperty-api`); payload types are generated from `contract/device-protocol.json` by `pnpm gen:protocol` into `src/protocol/types.ts` — never hand-write them.
4. The prompt you were asked to execute (`docs/prompts/E*.md`) — only that deliverable.
5. `docs/PROGRESS.md` (latest entries).

## Hard rules
- **Readings are cumulative registers** read from the meter (or maintained for pulse meters) with a persisted per-meter `seq`; never send interval deltas as readings (D-030).
- **Persist before publish**: every reading is appended to the on-disk queue before any network attempt; delete only on PUBACK; 30-day buffer with the eviction rule in the protocol §4.
- Config comes only from the cloud (retained `/config`), applied atomically with rollback; no local edits of bindings except through the LAN status page's read-only view.
- Drivers are isolated behind `MeterDriver` (`read(address) → { register, unit, extra }`) with a simulator driver for tests; a new meter model is a driver, never a protocol change (D-013).
- No secrets on disk except the device certificate/key (0600, owned by the service user); no inbound network services except the status page, which binds to localhost by default and requires the local admin token when exposed on the LAN (D-227 review fix #12; see SECURITY.md).
- Single binary (Node 24 SEA or pkg) + systemd unit + A/B update slots; must run on 512 MB RAM; CPU budget < 10 % average on a Cortex-A53 at 300 meters / 15-min polling.
- Cloud endpoints (D-230, `docs/SECURITY.md`): HTTPS only to the **device host** (`GP_API_URL`, default `https://device.getproperty.co`, Caddy client-certificate check); MQTT only to the bootstrap's `mqtts://<MQTT_HOST>:8883` with the bootstrap CA as the sole trust anchor; the WebSocket fallback `wss://<MQTT_HOST>/mqtt` only when the bootstrap answer carried `mqtt.wsUrl` (platform admin enabled it for this gateway) **and** `GP_MQTT_WS_FALLBACK=on`, its certificate verified against the same CA (D-239); never a plaintext or credential-less fallback.
- **Device protocol 1.2** (D-235, D-244): MQTT client id = username = `gw-<gatewayId>` (= certificate CN), password = a device JWT (`DeviceTokenCache.mqttPassword`, memory only) before every (re)connect, rotated before expiry with a graceful DISCONNECT (no LWT); a refused CONNECT → new token + back-off; publish only `telemetry`, `health`, `events`, `cmd/ack`, subscribe only `config`, `cmd` (`MQTT_ACL`, generated from `x-acl`) — a new topic is a contract change in getproperty-api first.
- Plan Mode first for each deliverable; small slices; Conventional Commits; CI green. Ambiguity → `docs/PROGRESS.md` + the conservative option.

## Commands
`pnpm dev:local` (whole loop on one machine: in-process mTLS broker, API stub, simulator) · `pnpm dev` (agent only; `GP_DRIVER_MODE=simulator`, point `GP_API_URL` at a running getproperty-api) · `pnpm gen:protocol` / `pnpm gen:protocol:check` · `pnpm lint` · `pnpm format:check` · `pnpm typecheck` · `pnpm test` (unit) · `pnpm test:int` · `pnpm test:soak` · `pnpm test:e2e` (Playwright) · `pnpm test:hw` (needs a real RS485 adapter; skipped in CI) · `pnpm build` · `pnpm build:sea` · `pnpm image` (OTA artefact + signature)
