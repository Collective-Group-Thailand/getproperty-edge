import type { StatementSync } from 'node:sqlite';

import { buildAck } from '../protocol/envelopes.js';
import type { Command, CommandAck, CommandType } from '../protocol/types.js';
import { assertValid } from '../protocol/validate.js';
import type { Db } from '../storage/db.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import { isoWithOffset } from '../util/time.js';

export type CommandHandler = (args: Record<string, unknown>, cmd: Command) => Promise<Record<string, unknown>>;

export interface DispatcherOptions {
  db: Db;
  clock: Clock;
  timeZone: string;
  logger: Logger;
  /** Persists the ack in the outbox (delivered on PUBACK, survives offline periods). */
  sendAck: (ack: CommandAck) => void;
  handlers: Partial<Record<CommandType, CommandHandler>>;
  defaultTtlS?: number;
}

/**
 * `/cmd` handling (protocol §4): validate, drop expired (`issuedAt + ttlS`), ack `accepted` at once,
 * then `done | failed`. A redelivered or retried cmdId (the cloud retries unacked commands up to 3×)
 * is never executed twice — the last ack is sent again instead.
 */
export class CommandDispatcher {
  private readonly stmt: { get: StatementSync; put: StatementSync; purge: StatementSync };
  invalid = 0;

  constructor(private readonly o: DispatcherOptions) {
    this.stmt = {
      get: o.db.prepare('SELECT status, ack FROM commands WHERE cmd_id = ?'),
      put: o.db.prepare(
        `INSERT INTO commands (cmd_id, type, status, ack, received_at_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cmd_id) DO UPDATE SET status = excluded.status, ack = excluded.ack`,
      ),
      purge: o.db.prepare('DELETE FROM commands WHERE received_at_ms < ?'),
    };
  }

  addHandler(type: CommandType, handler: CommandHandler): void {
    this.o.handlers[type] = handler;
  }

  async handle(payload: Buffer | string): Promise<CommandAck | null> {
    let cmd: Command;
    try {
      cmd = assertValid('Command', JSON.parse(payload.toString()));
    } catch (err) {
      this.invalid++;
      this.o.logger.warn({ err: (err as Error).message }, 'invalid command dropped');
      return null;
    }
    const now = this.o.clock.now();
    const at = isoWithOffset(now, this.o.timeZone);
    this.stmt.purge.run(now - 7 * 86_400_000);

    const seen = this.stmt.get.get(cmd.cmdId) as { status: string; ack: string } | undefined;
    if (seen) {
      const ack = JSON.parse(seen.ack) as CommandAck;
      this.o.sendAck(ack);
      return ack;
    }
    const ttl = (cmd.ttlS ?? this.o.defaultTtlS ?? 300) * 1000;
    if (Date.parse(cmd.issuedAt) + ttl < now)
      return this.finish(cmd, buildAck(cmd.cmdId, 'failed', at, { error: 'expired' }));

    const handler = this.o.handlers[cmd.type];
    if (!handler)
      return this.finish(cmd, buildAck(cmd.cmdId, 'failed', at, { error: `unsupported command ${cmd.type}` }));

    const accepted = buildAck(cmd.cmdId, 'accepted', at);
    this.stmt.put.run(cmd.cmdId, cmd.type, 'accepted', JSON.stringify(accepted), now);
    this.o.sendAck(accepted);
    try {
      const result = await handler(cmd.args ?? {}, cmd);
      return this.finish(
        cmd,
        buildAck(cmd.cmdId, 'done', isoWithOffset(this.o.clock.now(), this.o.timeZone), { result }),
      );
    } catch (err) {
      return this.finish(
        cmd,
        buildAck(cmd.cmdId, 'failed', isoWithOffset(this.o.clock.now(), this.o.timeZone), {
          error: (err as Error).message,
        }),
      );
    }
  }

  private finish(cmd: Command, ack: CommandAck): CommandAck {
    this.stmt.put.run(cmd.cmdId, cmd.type, ack.status, JSON.stringify(ack), this.o.clock.now());
    this.o.sendAck(ack);
    return ack;
  }
}
