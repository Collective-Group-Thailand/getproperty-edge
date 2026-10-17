import { promises as fsp } from 'node:fs';

/** Status LED on the carrier (identify pattern). */
export interface Led {
  set(on: boolean): Promise<void>;
}

/** `/sys/class/leds/<name>/brightness` (works with the gpio-leds overlay; no trigger juggling needed). */
export class SysfsLed implements Led {
  constructor(private readonly name: string) {}
  async set(on: boolean): Promise<void> {
    await fsp.writeFile(`/sys/class/leds/${this.name}/brightness`, on ? '1' : '0');
  }
}

export class SimLed implements Led {
  readonly transitions: boolean[] = [];
  async set(on: boolean): Promise<void> {
    this.transitions.push(on);
  }
}

/** Identify pattern: 3 short + 1 long blink, repeated for `durationS` (installer finds the box). */
export async function blinkIdentify(
  led: Led,
  durationS: number,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  const pattern = [150, 150, 150, 150, 150, 150, 600, 600];
  const end = Date.now() + durationS * 1000;
  let cycles = 0;
  do {
    for (let i = 0; i < pattern.length; i++) {
      await led.set(i % 2 === 0);
      await wait(pattern[i]!);
    }
    cycles++;
  } while (Date.now() < end);
  await led.set(false);
  return cycles;
}
