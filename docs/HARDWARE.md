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

## Pulse inputs (water meters) — carrier design (decided in E1.3)

**Decision**: debounce and isolation **in hardware on the carrier**, counting by the Linux agent through the
GPIO character device (`gpiomon`, libgpiod) — no dedicated MCU for the pilot. Software debounce (30 ms
default) stays on as the second line. Rationale: water meters with reed/open-collector outputs produce
≤ 1 pulse/s even at full flow (10 L/pulse at 3 m³/h ≈ 0.08 Hz), far inside what the kernel edge-event
queue handles; an MCU adds firmware to maintain and a second failure point. Revisit with an MCU or a
counter IC (e.g. a battery-backed counter) only if a site needs counting across long power cuts
without the gateway (the agent already flags the first reading after an unclean restart
`estimated_by_gateway`, D-033).

Per channel (up to **16 channels**, the agent refuses more):

1. Meter output (reed contact / open collector) → 2-wire cable, max ~50 m.
2. Optocoupler (e.g. PC817 / LTV-817) with a 12 V wetting supply and 2.2 kΩ series resistor — isolates
   the cable from the SoC and gives the reed enough wetting current.
3. RC low-pass (10 kΩ / 1 µF, τ = 10 ms) + Schmitt-trigger buffer (74HC14) — removes contact bounce and
   cable noise; pulses ≥ 50 ms (all common water meters) pass.
4. GPIO input with the falling edge counted (pull-up on the carrier).
5. TVS diode on each input pair; channel LED for the installer.

For more than the free GPIOs of the module, the same front end feeds an **MCP23017** I²C expander (16
inputs, interrupt line to one GPIO); the expander backend is a driver addition behind `PulseSource`, not
a protocol change. Pilot (Raspberry Pi CM4 carrier): GPIO 17, 27, 22, 23, 24, 25, 5, 6, 12, 13, 16, 19,
20, 21, 26, 4 on `gpiochip0`.

The agent persists the pulse count every 10 pulses and every 30 s, before each reading and on shutdown;
the register is `initialRegister + pulses × litresPerPulse`. A new staff-confirmed `initialRegister`
re-baselines the counter; a changed `litresPerPulse` re-baselines at the current register.

`gpiomon` must be installed (`apt install gpiod`); the service user needs access to `/dev/gpiochip*`
(`gpio` group, set by `scripts/install.sh`). libgpiod v1 (Debian bookworm / Raspberry Pi OS) and v2
(trixie) are both supported (version detected at start). UNVERIFIED on the carrier until the pilot build.

## Status LED

`GP_LED=<name>` drives `/sys/class/leds/<name>/brightness` (gpio-leds overlay) for the `identify` command
(3 short + 1 long blinks, repeated for `durationS`, default 30 s).

## Image build and install

1. `pnpm build:sea` produces `dist/getproperty-edge-<version>-linux-x64` (smoke-tested with `--version`).
2. For the ARM64 gateway, download the official Node 24 linux-arm64 tarball, verify it against
   `SHASUMS256.txt` (signed by the Node.js release keys), and inject the same SEA blob:
   `pnpm build:sea --arch arm64 --node ./node-v24.x-linux-arm64/bin/node` (the blob has no snapshot or
   code cache, so it is architecture-independent). Smoke-test on the gateway: `./getproperty-edge --version`.
3. `pnpm image` signs a release (`OTA_SIGNING_KEY_FILE`, `OTA_KEY_ID`, `--channel canary|pilot|all`,
   `--base-url`): `dist/release/<version>/` holds the binary, `manifest-<arch>.json` (ed25519-signed),
   `SHA256SUMS`, `install.sh`, `ota-guard.sh` and the systemd unit. The api's OTA rollout serves the
   manifest at `/v1/device/ota/manifest` (CR-011).
4. On a fresh gateway (Raspberry Pi OS Lite 64-bit / Debian 12 arm64, `apt install gpiod`):
   `sudo ./install.sh --binary ./getproperty-edge-<version>-linux-arm64 --api-url https://api.getproperty.co`.
   It creates `gpedge`, `/var/lib/getproperty-edge` (0700), `/opt/getproperty-edge/slots/{a,b}` + `current`,
   the root-owned OTA guard, the systemd unit, udev rules (RS485 adapters → `dialout` + `/dev/getproperty-rs485-N`,
   gpiochip → `gpio`, LED brightness), NTP (th.pool.ntp.org) and the hardware watchdog (`RuntimeWatchdogSec=30`).
5. For a fleet image: run the installer in the image build (chroot), leave `/var/lib/getproperty-edge`
   empty — every gateway generates its own key at first boot.

Budgets measured (`pnpm test:soak`, x64 dev host): agent RSS peak 170 MB while draining a 2-day backlog
of 57,600 readings with 300 meters; steady-state CPU 0.3 % at 60-s polling (15× the production rate).
