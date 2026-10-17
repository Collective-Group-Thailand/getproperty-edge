import { describe, expect, it } from 'vitest';

import { SystemdClockSync } from '../../src/scheduler/clock-sync.js';
import { silentLogger } from '../../src/util/logger.js';

describe('SystemdClockSync', () => {
  it('reads NTPSynchronized from timedatectl', async () => {
    const yes = new SystemdClockSync(silentLogger(), async () => ({ stdout: 'yes\n' }));
    await yes.refresh();
    expect(yes.suspect()).toBe(false);
    const no = new SystemdClockSync(silentLogger(), async () => ({ stdout: 'no\n' }));
    await no.refresh();
    expect(no.suspect()).toBe(true);
  });
  it('falls back to the timesyncd marker, and treats "unknown" as synced', async () => {
    const fail = async () => {
      throw new Error('ENOENT');
    };
    const marker = new SystemdClockSync(silentLogger(), fail, () => true);
    await marker.refresh();
    expect(marker.suspect()).toBe(false);
    const unknown = new SystemdClockSync(silentLogger(), fail, () => false);
    await unknown.refresh();
    expect(unknown.suspect()).toBe(false);
  });
});
