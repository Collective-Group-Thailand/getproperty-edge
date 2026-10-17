# Meter simulator

The simulator driver (`src/drivers/simulator/`) answers for every meter of the cloud config when the agent
runs with `GP_DRIVER_MODE=simulator` (`pnpm dev`, the tests, the soak run, and getproperty-api's
`pnpm sim:gateway`). Registers are **cumulative and deterministic**: the same seed, meter id and instant
always give the same value on every machine.

## Profile

- Occupancy per meter from the seed (`occupancyRate`, default 0.85) unless set per meter.
- Daily total = `dailyMean` (electric 4–12 kWh/day, water 0.15–0.40 m³/day, seeded) × 1.2 on Saturday/Sunday
  × a per-day factor 0.75–1.25 seeded by meter + day; vacant units: standby 0.15–0.25 kWh/day, no water.
- Within the day the total follows a residential hourly shape (night base, morning bump, evening peak);
  `extra` carries `voltage`, `current`, `powerW` (electric) or `flowLpm` (water).
- Before `epoch` (default `2026-01-01T00:00:00+07:00`) the register equals `initialRegister`
  (per meter, else the config's `initialRegister`, else seeded 100–9100).

## Faults

```json
{
  "seed": "pilot-a",
  "occupancyRate": 0.85,
  "latencyMs": 40,
  "defaults": { "faults": [{ "type": "timeout", "probability": 0.01 }] },
  "meters": {
    "<meterId>": {
      "occupied": true,
      "dailyMean": 9.5,
      "initialRegister": "1532.040",
      "faults": [
        { "type": "timeout", "from": "2026-11-01T02:00:00+07:00", "to": "2026-11-01T03:00:00+07:00" },
        { "type": "crc_error", "probability": 0.05 },
        { "type": "not_found" },
        { "type": "stuck", "from": "2026-11-03T00:00:00+07:00", "to": "2026-11-04T00:00:00+07:00" },
        { "type": "rollover", "at": "100000" },
        { "type": "swap", "at": "2026-11-10T10:00:00+07:00", "newInitialRegister": "0.000" }
      ]
    }
  }
}
```

| Fault                               | Effect                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `timeout`, `crc_error`, `not_found` | the read fails with that status (window and/or `probability`, seeded per read)                               |
| `stuck`                             | the register freezes at its value at `from` until `to`                                                       |
| `rollover`                          | the register wraps to 0 at `at` (the driver declares `rolloverAt`, so the agent sends `overflow_corrected`)  |
| `swap`                              | from `at` the register continues from `newInitialRegister` (a decrease → `tamper` event, reading still sent) |

Pass the JSON inline or as a file path in `GP_SIM_CONFIG`.

## Running a simulated gateway

- Against getproperty-api's compose EMQX: `GP_DRIVER_MODE=simulator GP_API_URL=http://localhost:3000 GP_PROVISIONING_CODE=<code> pnpm dev`.
