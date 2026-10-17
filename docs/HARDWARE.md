# Gateway hardware

Baseline D-132: Linux ARM64 gateway with RS485, Ethernet/Wi-Fi/4G and an RTC. Pilot meters per O-003
(electric: Modbus RTU 1-phase class 1, Eastron SDM120/SDM230-class; water: pulse output).

## RS485 / Modbus RTU

- **Adapter**: an isolated USB-RS485 adapter (FTDI FT232R or CH340 + automatic DE/RE direction control)
  or the gateway's native RS485 port. The agent opens the tty through `stty` + plain reads, so any
  adapter that appears as `/dev/ttyUSB*` / `/dev/ttyAMA*` / `/dev/ttyS*` works; direction switching must
  be automatic (all common adapters do it in hardware).
- **Stable names**: `scripts/install.sh` installs a udev rule that links the first adapter to
  `/dev/getproperty-rs485-1` (the cloud config's `device` should use these names).
- **Wiring**: daisy chain (no stars), A→A, B→B, shield/GND to the adapter's GND at one end only,
  120 Ω termination at both ends of long runs (> 50 m), max 32 unit loads per segment (SDM120 = 1/4 UL
  → plenty), keep ≤ 247 addresses per bus. Split buildings over several buses (one per floor riser) so a
  cut cable silences only one floor.
- **Line settings**: 9600 8N2 by default (Modbus RTU: 2 stop bits without parity, 1 with parity); set
  each meter's address and baud on its front panel before installation (`docs/RUNBOOK-FIELD.md`).
- **Timing**: one request in flight per bus; response timeout 500 ms, 2 retries, ≥ t3.5 silent gap
  (4 ms at 9600) between frames. Two blocks per SDM120 read (registers 0–13 and 70–73, function 04)
  ≈ 2 × 40 ms on the wire → 300 meters on one bus poll in ≈ 30 s, well inside 15 min.

### Register maps

Built-in maps live in `src/drivers/modbus/maps/*.json` (`eastron_sdm120`, `eastron_sdm230`). A new
meter model is a new JSON map (function code, word order, register + extras with type/scale, probe
block, optional `rolloverAt`) plus golden frames in `test/fixtures/frames/` — never a protocol change (D-013).

### `pnpm test:hw` (real adapter, never in CI)

```sh
GP_HW_DEVICE=/dev/ttyUSB0 GP_HW_ADDRESS=21 GP_HW_DRIVER=eastron_sdm120 GP_HW_BAUD=9600 pnpm test:hw --capture
```

Reads the meter three times, prints the register, extras, round-trip time and bus statistics, and with
`--capture` writes the frames as `test/fixtures/frames/captured-*.hex` (add an `# expect` line and commit
them so the golden tests run against real captures). Without `GP_HW_DEVICE` it prints "skipped" and exits 0.
