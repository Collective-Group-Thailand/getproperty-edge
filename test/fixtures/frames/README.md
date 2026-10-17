# Modbus RTU golden frames

One exchange per file: `>` = request ADU (master → meter), `<` = response ADU, `!` = a response that
must be rejected, `#` comments. `# expect` lines give the decoded values the driver must produce.

- `crc-reference.hex` — published CRC-16/MODBUS vectors (Modbus over Serial Line V1.02 §6.2.2 example
  `11 03 00 6B 00 03 76 87`, plus the widely quoted `01 03 00 00 00 0A C5 CD` and the Eastron
  `01 04 00 00 00 02 71 CB` voltage request); checked against an independent bitwise implementation.
- `sdm120-*.hex` — Eastron SDM120 input-register reads (function 04, float32 big-endian) **reconstructed
  from the Eastron protocol document**, not yet captured from a live meter (UNVERIFIED). `pnpm test:hw
  --capture` writes real captures here (`captured-*.hex`); replace these files with them after the
  pilot site survey (O-003).
