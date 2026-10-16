# E1 — Gateway agent

> อ่าน `CLAUDE.md`, `00-master-plan.md`, `docs/decisions.md`, `docs/contract/device-protocol.md` ก่อน · ทำทีละ Deliverable (1.1 → 1.4) ต่อ 1 session · Plan Mode ทุกครั้ง
> ต้องมี `contract/device-protocol.json` จาก `getproperty-api` release (B1.1) · ทดสอบกับ EMQX ใน `../getproperty-api/docker-compose.yml`

---

You are a senior embedded/IoT engineer building **`getproperty-edge`**, the Node 24 gateway agent of getproperty.

## Deliverable 1.1 — Scaffold, protocol types, simulator, MQTT transport, on-disk queue
1. pnpm + TS 6 strict + ESLint/Prettier + Vitest; `pnpm gen:protocol` (reads `PROTOCOL_SOURCE`, default `../getproperty-api/contract/device-protocol.json`, pinned sha in `protocol.lock.json`) → `src/protocol/types.ts` + runtime validators (ajv) used before every publish.
2. **Identity**: bootstrap flow (`POST /v1/device/bootstrap` with the provisioning code from `GP_PROVISIONING_CODE` env or the status page's one-time entry; CSR generated locally; cert + CA chain stored 0600), renewal at 11 months, device JWT cache for HTTPS calls.
3. **Queue** (`better-sqlite3`, WAL): `readings(id, meter_id, seq, read_at, register, unit, quality, extra, published_at)`; per-meter `seq` counter table; append → publish batches ≤ 200 → delete on PUBACK; eviction per protocol §4; metrics (depth, oldest, evicted).
4. **MQTT transport**: MQTT 5 over TLS with client cert, keepalive 30 s, LWT on `/health`, exponential backoff with jitter, offline detection, subscribe `/config` (retained) and `/cmd`; HTTPS batch fallback after N minutes without a broker (configurable); envelope builders with validation.
5. **Simulator driver**: deterministic per-meter daily profiles (occupied/vacant, weekday/weekend), faults (timeout, CRC error, stuck register, rollover, swap), controllable through env/JSON for tests and for `getproperty-api`'s `pnpm sim:gateway`.
6. Acceptance: integration test with EMQX container: 10 simulated meters, broker killed for 10 min, restored → all readings delivered once in order; schema-invalid envelope never leaves the agent (test); bootstrap against the api's fake CA (or a local test CA).

## Deliverable 1.2 — Modbus RTU driver & scheduler
1. `MeterDriver` interface; **Modbus RTU** driver with per-model register maps (start with Eastron SDM120/SDM230-class: total active energy import register, voltage/current/power extras; add a generic map format so a new model is JSON + tests), CRC-16 with golden frames, timeouts, retries, inter-frame gaps; bus serialisation (one request in flight per RS485 bus), per-meter backoff on repeated failures, `status: timeout | crc_error | not_found` into health.
2. **Scheduler**: polling plan from config (`pollIntervalS`, per-bus), jittered start, reads aligned to the wall clock (:00/:15/:30/:45 local) so cut-off readings exist (D-031 window), `read_now` command support, clock-suspect flag when NTP is unsynced.
3. Register maths: scaling per driver, rollover detection (`overflow_corrected` quality), monotonic sanity before enqueue (a decrease is still sent, flagged, never silently dropped — the cloud decides).
4. Acceptance: driver golden tests from captured frames (`test/fixtures/frames/*.hex`); scheduler test proves alignment and serialisation; `pnpm test:hw` script documented for a real adapter.

## Deliverable 1.3 — Pulse counter driver, health, commands, status page
1. **Pulse driver**: GPIO edge counting with debounce (software + documented hardware recommendation), persisted register (`initialRegister + pulses × litresPerPulse`) flushed to SQLite every N pulses / seconds and on shutdown; first reading after an unclean restart flagged `estimated_by_gateway`; overflow event; multi-channel (up to 16 pins or an I²C expander) — decide the carrier design in `docs/HARDWARE.md`.
2. **Health**: 60-s heartbeat with the protocol fields (agent version, applied config version, uptime, queue depth, disk, cpu/mem, link type, RSSI via `nmcli`/modem AT where present, per-meter status).
3. **Config apply**: full-document replace with validation, dry-run of drivers (open buses, probe addresses), atomic swap, persist, `config_applied`/`config_rejected` events, rollback on failure.
4. **Commands**: `read_now`, `restart`, `identify` (LED pattern through a `Led` abstraction), `upload_logs` (bundle → presign → PUT), `set_log_level`, TTL and ack semantics.
5. **LAN status page**: read-only HTML on `:8080` (meters, last reads, queue depth, config version, link state, agent version, provisioning entry when not yet bootstrapped); no secrets; rate-limited.
6. Acceptance: pulse simulation test (power-cut scenario); health snapshot test; config rollback test; status page e2e with Playwright (headless).

## Deliverable 1.4 — OTA, packaging, install, soak
1. **OTA**: manifest fetch (`/v1/device/ota/manifest`), signature verification (minisign/cosign public key baked in), download to the inactive slot, integrity check, switch + reboot, post-boot health gate (publish health within 5 min or roll back), `ota_*` events.
2. **Packaging**: Node SEA (or pkg) ARM64 binary, systemd unit (restart always, watchdog), `scripts/install.sh` (user, dirs, perms, udev rule for the RS485 adapter, NTP), image build notes for the chosen gateway (`docs/HARDWARE.md`), `pnpm image` → signed artefact + manifest for the api's OTA rollout.
3. **Soak**: simulator run 300 meters × 15-min × 30 simulated days with network chaos (outages, broker restarts, DNS failure) against the api's ingest in compose; resource budgets from the master plan §5 asserted.
4. `docs/SECURITY.md` checklist, `docs/RUNBOOK-FIELD.md` (installer steps: mount, wire RS485 A/B, address meters, scan QR, verify on the status page and in the staff PWA), `docs/PROGRESS.md`.
