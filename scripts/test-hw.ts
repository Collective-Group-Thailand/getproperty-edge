/**
 * `pnpm test:hw` — reads a real meter through a USB-RS485 adapter. Skipped (exit 0) unless
 * GP_HW_DEVICE is set. Never run in CI.
 *
 *   GP_HW_DEVICE=/dev/ttyUSB0 GP_HW_ADDRESS=21 [GP_HW_DRIVER=eastron_sdm120] [GP_HW_BAUD=9600]
 *   [GP_HW_PARITY=none] pnpm test:hw [--capture]
 *
 * --capture writes the exchanged frames to test/fixtures/frames/captured-<driver>-<addr>-<ts>.hex in the
 * golden-frame format, so captures from the pilot site replace the reconstructed fixtures.
 */
import { writeFileSync } from 'node:fs';

import { ModbusMaster } from '../src/drivers/modbus/master.js';
import { ModbusMeterDriver } from '../src/drivers/modbus/modbus-driver.js';
import { BUILTIN_MAPS } from '../src/drivers/modbus/register-map.js';
import { LinuxTtyTransport, type SerialTransport } from '../src/drivers/modbus/serial.js';
import type { BusParity } from '../src/protocol/types.js';
import { formatMilli } from '../src/util/decimal.js';

const device = process.env.GP_HW_DEVICE;
if (!device) {
  console.log('test:hw skipped — set GP_HW_DEVICE=/dev/ttyUSB0 and GP_HW_ADDRESS to run against a real meter');
  process.exit(0);
}
const address = Number(process.env.GP_HW_ADDRESS ?? 1);
const driverName = process.env.GP_HW_DRIVER ?? 'eastron_sdm120';
const baud = Number(process.env.GP_HW_BAUD ?? 9600);
const parity = (process.env.GP_HW_PARITY ?? 'none') as BusParity;
const map = BUILTIN_MAPS[driverName];
if (!map) throw new Error(`unknown driver ${driverName}; built-in: ${Object.keys(BUILTIN_MAPS).join(', ')}`);

const lines: string[] = [];
const hex = (b: Buffer) => b.toString('hex').toUpperCase().match(/../g)!.join(' ');
class Tap implements SerialTransport {
  constructor(private readonly inner: SerialTransport) {}
  get isOpen() {
    return this.inner.isOpen;
  }
  open() {
    return this.inner.open();
  }
  close() {
    return this.inner.close();
  }
  async write(d: Buffer) {
    lines.push(`> ${hex(d)}`);
    return this.inner.write(d);
  }
  onData(cb: (c: Buffer) => void) {
    this.inner.onData((c) => {
      lines.push(`< ${hex(c)}`);
      cb(c);
    });
  }
}

async function main() {
  const master = new ModbusMaster(new Tap(new LinuxTtyTransport({ device: device!, baud, parity })), {
    baud,
    timeoutMs: 1000,
    retries: 2,
  });
  await master.open();
  const drv = new ModbusMeterDriver(map!, master);
  const meter = {
    meterId: '00000000-0000-0000-0000-000000000000',
    roomCode: 'HW',
    driver: driverName,
    bus: 'hw',
    address,
    unit: map!.register.unit,
  };
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const r = await drv.read(meter);
    console.log(
      `read ${i + 1}: register=${formatMilli(r.registerMilli)} ${r.unit} extra=${JSON.stringify(r.extra)} (${Date.now() - t} ms)`,
    );
  }
  console.log('bus stats', master.stats);
  await master.close();
  if (process.argv.includes('--capture')) {
    // Responses may arrive in several chunks; merge consecutive '<' lines into one frame.
    const merged: string[] = [];
    for (const l of lines) {
      const prev = merged[merged.length - 1];
      if (l.startsWith('<') && prev?.startsWith('<')) merged[merged.length - 1] = `${prev} ${l.slice(2)}`;
      else merged.push(l);
    }
    const file = `test/fixtures/frames/captured-${driverName}-${address}-${Date.now()}.hex`;
    writeFileSync(
      file,
      `# captured from ${device} at ${baud} baud, ${new Date().toISOString()}\n${merged.join('\n')}\n`,
    );
    console.log(`frames written to ${file} — add an '# expect' line before committing`);
  }
}

main().catch((err: unknown) => {
  console.error(`test:hw failed: ${(err as Error).message}`);
  process.exit(1);
});
