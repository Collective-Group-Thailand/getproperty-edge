import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import type { Logger } from '../util/logger.js';

/** Whether the system clock is NTP-synchronised; readings taken while it is not are `clock_suspect`. */
export interface ClockSync {
  suspect(): boolean;
}

export const alwaysSynced: ClockSync = { suspect: () => false };

/**
 * systemd: `timedatectl show -p NTPSynchronized --value`, falling back to systemd-timesyncd's
 * `/run/systemd/timesync/synchronized` marker. Refreshed every 5 min. Unknown (neither available) is
 * treated as synchronised and logged once — an RTC-backed gateway without systemd is not suspect by default.
 */
export class SystemdClockSync implements ClockSync {
  private state: boolean | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly run: (cmd: string, args: string[]) => Promise<{ stdout: string }> = promisify(execFile),
    private readonly markerExists: () => boolean = () => existsSync('/run/systemd/timesync/synchronized'),
  ) {}

  async refresh(): Promise<void> {
    try {
      const { stdout } = await this.run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']);
      this.state = stdout.trim() === 'yes';
    } catch {
      if (this.markerExists()) this.state = true;
      else if (this.state === null) {
        this.logger.warn('cannot determine NTP sync state (no timedatectl); readings not flagged clock_suspect');
        this.state = true;
      }
    }
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 300_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  suspect(): boolean {
    return this.state === false;
  }
}
