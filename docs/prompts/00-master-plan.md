# 00 — Master Plan (edge): getproperty-edge

> อ่านไฟล์นี้, `docs/decisions.md` และ `docs/contract/device-protocol.md` ก่อนทุก session แล้วเปิด prompt ของ deliverable ที่ได้รับมอบหมาย
> Repo นี้คือ agent ที่รันบน gateway ในอาคาร · cloud อยู่ที่ `getproperty-api` (ingest process) · เริ่มได้ทันทีที่ `getproperty-api` B1.1 publish `contract/device-protocol.json`

---

## 1. Role in the system
```
meters ──RS485/Modbus RTU──┐
water meters ──pulse/GPIO──┼─► getproperty-edge (this repo) ──MQTT/mTLS──► EMQX ──► getproperty-api ingest ──► readings
LoRaWAN sensors ──LNS──────┘        │ on-disk queue (SQLite)            ◄── retained /config, /cmd
                                    └─ LAN status page (read-only)
```
Hardware baseline D-132: Linux ARM64 gateway with RS485 ports (industrial gateway, or Raspberry Pi CM4 carrier for the pilot), Ethernet/Wi-Fi/4G, RTC. Pilot meters per O-003 (electric: Modbus 1-phase class 1, e.g. Eastron SDM120-class; water: pulse output).

## 2. Platform baseline
Node 24 LTS · pnpm · TypeScript 6 strict · ESLint flat + Prettier · `serialport` + `modbus-serial` (or a small in-house RTU implementation with CRC tests) · `onoff`/`libgpiod` bindings for pulses (debounce in hardware or a dedicated MCU on the carrier — decide in E1.2) · `mqtt` (MQTT 5, TLS, client certs) · `better-sqlite3` for the queue and state · pino · Vitest · a **meter simulator** (deterministic daily profiles, faults) used by `pnpm dev`, tests and `getproperty-api`'s `pnpm sim:gateway` · Node SEA build + systemd + A/B slots · GitHub Actions: lint, typecheck, test, build artefact, sign (cosign/minisign), publish release with the manifest the cloud's OTA uses.

## 3. Structure (target)
```
getproperty-edge/
├─ src/
│  ├─ main.ts                 boot: load identity → connect MQTT → fetch/apply config → start pollers → heartbeat
│  ├─ identity/               bootstrap (provisioning code → CSR → cert), renewal, key storage
│  ├─ protocol/               generated types, envelope builders, schema validation before publish
│  ├─ transport/mqtt/         client, reconnect/backoff, LWT, shared topics, PUBACK-driven queue deletion, HTTPS fallback
│  ├─ queue/                  SQLite append-only queue, seq per meter, eviction policy, metrics
│  ├─ config/                 config apply/rollback, version persistence, drift report
│  ├─ drivers/                MeterDriver interface; modbus-rtu (register maps per model), pulse-counter, lorawan (LNS webhook/MQTT), simulator
│  ├─ scheduler/              polling plan per bus (serialised per RS485 bus, retries, timeouts, backoff per meter)
│  ├─ health/                 heartbeat, meter status, disk/cpu/mem, link type/RSSI
│  ├─ commands/               read_now, restart, identify, upload_logs, set_log_level, ota_apply
│  ├─ ota/                    manifest verify, A/B slot install, health-check + rollback
│  └─ status-page/            LAN read-only page (meters, last reads, queue depth, config version, link)
├─ systemd/  scripts/ (install.sh, image build)  test/ (unit, integration with EMQX container, hw)
├─ contract/device-protocol.json (copied from the api release)  docs/
└─ .github/workflows/ci.yml  release.yml
```

## 4. Run order
| Step | Prompt | Output |
|---|---|---|
| E1 | `E1-gateway-agent.md` 1.1 → 1.4 | scaffold + protocol types + simulator + MQTT transport + queue; Modbus RTU driver + scheduler; pulse driver + health + commands + status page; OTA + packaging + install script |
| E2 (R2) | `E2-lorawan-and-locks.md` (to be written when R2 starts) | LoRaWAN water meters via an LNS, lock-gateway bridging if a vendor needs local control |

## 5. Definition of Done
- Unit + integration (EMQX Testcontainer) green; simulator-based soak test: 300 meters × 15-min for a simulated 30 days with a 2-day network outage → zero lost readings, zero duplicates accepted by a reference ingest stub; CRC/driver golden tests against captured frames.
- Memory < 200 MB RSS at 300 meters; cold start → first telemetry < 60 s; config apply < 5 s.
- Security review checklist in `docs/SECURITY.md` ticked (cert perms, no inbound ports, signed OTA).
- `docs/PROGRESS.md` entry per deliverable.
