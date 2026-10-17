import type { DeviceEventSeverity, DeviceEventType } from '../protocol/types.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import { type OtaManifest, OtaVerifyError, verifyManifest } from './manifest.js';
import type { AbSlots } from './slots.js';

export interface OtaDeps {
  slots: AbSlots;
  trustedKeys: Record<string, string>;
  currentVersion: string;
  arch: string;
  fetchManifest: (url: string) => Promise<unknown>;
  download: (url: string) => Promise<AsyncIterable<Buffer>>;
  clock: Clock;
  logger: Logger;
  event: (type: DeviceEventType, severity: DeviceEventSeverity, message: string, data: Record<string, unknown>) => void;
  /** Ends the process so systemd starts `current` (the new slot, or the previous one after a rollback). */
  requestRestart: () => void;
  /** Resolves after the first heartbeat PUBACK of this process. */
  firstHealthAck: () => Promise<void>;
  /** Post-boot health gate (protocol §4: 5 min). */
  gateMs?: number;
  /** Time allowed between the switch and the new process starting. */
  restartAllowanceMs?: number;
}

/**
 * OTA (D-131, protocol §4): verify the signed manifest, download into the inactive slot, check
 * integrity, switch, restart; after the restart the new version must publish health within 5 min or
 * `current` goes back to the previous slot (and `scripts/ota-guard.sh` rolls back a binary that
 * cannot even start). Events: ota_started, ota_failed, ota_applied, ota_rolled_back.
 */
export class OtaUpdater {
  private busy = false;

  constructor(private readonly d: OtaDeps) {}

  async apply(manifestUrl: string): Promise<Record<string, unknown>> {
    if (this.busy) throw new Error('an update is already in progress');
    if (await this.d.slots.pending()) throw new Error('an update is waiting for its health gate');
    this.busy = true;
    let manifest: OtaManifest | undefined;
    try {
      manifest = verifyManifest(await this.d.fetchManifest(manifestUrl), this.d.trustedKeys, {
        currentVersion: this.d.currentVersion,
        arch: this.d.arch,
      });
      const from = this.d.currentVersion;
      const active = await this.d.slots.active();
      const target = await this.d.slots.inactive();
      this.d.event('ota_started', 'info', `installing ${manifest.version} into slot ${target}`, {
        version: manifest.version,
        fromVersion: from,
        slot: target,
        channel: manifest.channel,
      });
      await this.d.slots.install(target, await this.d.download(manifest.artifact.url), manifest.artifact);
      const deadline = Math.floor(
        (this.d.clock.now() + (this.d.gateMs ?? 300_000) + (this.d.restartAllowanceMs ?? 120_000)) / 1000,
      );
      await this.d.slots.switchTo({
        slot: target,
        previous: active,
        version: manifest.version,
        fromVersion: from,
        deadline,
        attempts: 0,
      });
      this.d.logger.info({ version: manifest.version, slot: target }, 'OTA installed; restarting into the new slot');
      this.d.requestRestart();
      return { version: manifest.version, slot: target, restarting: true };
    } catch (err) {
      const msg = (err as Error).message;
      this.d.event('ota_failed', err instanceof OtaVerifyError ? 'critical' : 'warning', msg, {
        ...(manifest ? { version: manifest.version } : {}),
        manifestUrl,
      });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** At start: report a rollback done before this process, and run the health gate of a trial. */
  async onBoot(): Promise<'none' | 'committed' | 'rolled_back' | 'cleared'> {
    const rb = await this.d.slots.takeRolledBack();
    if (rb)
      this.d.event('ota_rolled_back', 'critical', `version ${rb.version} rolled back (${rb.reason})`, {
        version: rb.version,
        fromVersion: rb.fromVersion,
        reason: rb.reason,
      });
    const p = await this.d.slots.pending();
    if (!p) return 'none';
    if (p.version !== this.d.currentVersion || (await this.d.slots.active()) !== p.slot) {
      // A trial that is not us (e.g. the switch happened but this is the old binary): forget it.
      await this.d.slots.commit();
      return 'cleared';
    }
    const gateMs = Math.max(0, Math.min(this.d.gateMs ?? 300_000, p.deadline * 1000 - this.d.clock.now()));
    const passed = await new Promise<boolean>((resolve) => {
      const timer = this.d.clock.setTimeout(() => resolve(false), gateMs);
      this.d.firstHealthAck().then(
        () => {
          this.d.clock.clearTimeout(timer);
          resolve(true);
        },
        () => resolve(false),
      );
    });
    if (passed) {
      await this.d.slots.commit();
      this.d.event('ota_applied', 'info', `version ${p.version} passed the health gate`, {
        version: p.version,
        fromVersion: p.fromVersion,
        slot: p.slot,
      });
      return 'committed';
    }
    this.d.logger.error({ version: p.version }, 'no health published within the gate — rolling back');
    await this.d.slots.rollback('health_gate_timeout');
    this.d.requestRestart();
    return 'rolled_back';
  }
}
