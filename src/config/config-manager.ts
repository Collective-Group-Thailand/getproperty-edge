import type { GatewayConfig } from '../protocol/types.js';
import { assertValid, SchemaError } from '../protocol/validate.js';
import type { KvStore } from '../storage/db.js';
import type { Logger } from '../util/logger.js';
import { driverCatalogue, Runtime, type RuntimeDeps } from './runtime.js';
import { semanticErrors } from './validate-config.js';

export type ApplyOutcome =
  | { status: 'applied'; version: number; durationMs: number; unreachable: string[] }
  | { status: 'unchanged'; version: number }
  | { status: 'rejected'; version: number | null; error: string };

export interface ConfigEvents {
  applied(version: number, info: { unreachable: string[]; durationMs: number }): void;
  rejected(version: number | null, error: string): void;
  /** A runtime became active (boot, apply or rollback). */
  activated(runtime: Runtime): void;
}

const KEY = 'config.applied';

/**
 * Applies the cloud's full GatewayConfig document (retained `/config`): schema + semantic validation,
 * stop the old runtime, open + probe the new one, persist, start; any failure restores the previous
 * config (rollback) and reports config_rejected. Applies are serialised.
 */
export class ConfigManager {
  private runtime: Runtime | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kv: KvStore,
    private readonly deps: RuntimeDeps,
    private readonly events: ConfigEvents,
    private readonly logger: Logger,
    private readonly probeDeadlineMs = 3000,
  ) {}

  current(): GatewayConfig | null {
    return this.runtime?.config ?? this.kv.get<GatewayConfig>(KEY) ?? null;
  }

  version(): number {
    return this.current()?.version ?? 0;
  }

  active(): Runtime | undefined {
    return this.runtime;
  }

  /** Starts the persisted config (no events); used at boot before the broker delivers /config. */
  async boot(): Promise<void> {
    const cfg = this.kv.get<GatewayConfig>(KEY);
    if (!cfg) return;
    const rt = new Runtime(cfg, this.deps);
    try {
      await rt.open();
      rt.start(true);
      this.runtime = rt;
      this.events.activated(rt);
    } catch (err) {
      await rt.stop().catch(() => undefined);
      this.logger.error({ err: (err as Error).message, version: cfg.version }, 'persisted config failed to start');
    }
  }

  apply(payload: unknown): Promise<ApplyOutcome> {
    const p = this.chain.then(() => this.applyNow(payload));
    this.chain = p.catch(() => undefined);
    return p;
  }

  async stop(): Promise<void> {
    await this.chain;
    await this.runtime?.stop();
    this.runtime = undefined;
  }

  private async applyNow(payload: unknown): Promise<ApplyOutcome> {
    const t0 = Date.now();
    let cfg: GatewayConfig;
    let version: number | null = null;
    try {
      const doc: unknown =
        typeof payload === 'string' || Buffer.isBuffer(payload) ? JSON.parse(payload.toString()) : payload;
      if (doc && typeof doc === 'object' && typeof (doc as { version?: unknown }).version === 'number')
        version = (doc as { version: number }).version;
      cfg = assertValid('GatewayConfig', doc);
      const errs = semanticErrors(cfg, driverCatalogue());
      if (errs.length) throw new Error(errs.join('; '));
    } catch (err) {
      const msg = err instanceof SchemaError ? err.message : `invalid config: ${(err as Error).message}`;
      return this.reject(version, msg);
    }
    const prev = this.current();
    if (prev && cfg.version === prev.version && this.runtime) return { status: 'unchanged', version: cfg.version };
    if (prev && cfg.version < prev.version)
      return this.reject(cfg.version, `stale config version ${cfg.version} < applied ${prev.version}`);

    const old = this.runtime;
    await old?.stop();
    this.runtime = undefined;
    const next = new Runtime(cfg, this.deps);
    let unreachable: string[];
    try {
      await next.open();
      unreachable = (await next.probe(old ? old.config : null, this.probeDeadlineMs)).unreachable;
    } catch (err) {
      await next.stop().catch(() => undefined);
      await this.rollback(old);
      return this.reject(cfg.version, `dry-run failed: ${(err as Error).message}`);
    }
    this.kv.set(KEY, cfg);
    this.runtime = next;
    next.start(true);
    this.events.activated(next);
    const durationMs = Date.now() - t0;
    this.logger.info({ version: cfg.version, meters: cfg.meters.length, durationMs }, 'config applied');
    this.events.applied(cfg.version, { unreachable, durationMs });
    return { status: 'applied', version: cfg.version, durationMs, unreachable };
  }

  private async rollback(old: Runtime | undefined): Promise<void> {
    if (!old) return;
    const again = new Runtime(old.config, this.deps);
    try {
      await again.open();
      again.start(false);
      this.runtime = again;
      this.events.activated(again);
      this.logger.warn({ version: old.config.version }, 'config rolled back');
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'rollback to previous config failed');
    }
  }

  private reject(version: number | null, error: string): ApplyOutcome {
    this.logger.error({ version, error }, 'config rejected');
    this.events.rejected(version, error);
    return { status: 'rejected', version, error };
  }
}
