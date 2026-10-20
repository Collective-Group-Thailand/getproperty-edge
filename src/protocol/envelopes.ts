import { randomUUID } from 'node:crypto';

import type {
  CommandAck,
  CommandAckStatus,
  DeviceEvent,
  DeviceEventSeverity,
  DeviceEventType,
  Health,
  Reading,
  TelemetryBatch,
  TopicSuffix,
} from './types.js';
import { LWT_PAYLOAD } from './types.js';
import { assertValid } from './validate.js';

export const topic = (gatewayId: string, suffix: TopicSuffix): string => `gp/v1/${gatewayId}/${suffix}`;

export const lwtPayload = (): string => JSON.stringify(LWT_PAYLOAD);

export function buildTelemetryBatch(
  gatewayId: string,
  configVersion: number,
  sentAt: string,
  readings: Reading[],
  /** Protocol 1.1 (D-227): the sequence space of the readings' seqs (`ReadingQueue.seqEpoch`). */
  seqEpoch?: string,
): TelemetryBatch {
  const seen = new Set<string>();
  for (const r of readings) {
    const k = `${r.meterId}:${r.seq}`;
    if (seen.has(k)) throw new Error(`duplicate (meterId, seq) in batch: ${k}`);
    seen.add(k);
  }
  return assertValid('TelemetryBatch', {
    gatewayId,
    configVersion,
    sentAt,
    ...(seqEpoch ? { seqEpoch } : {}),
    readings,
  });
}

export function buildEvent(
  gatewayId: string,
  type: DeviceEventType,
  severity: DeviceEventSeverity,
  occurredAt: string,
  extra: { meterId?: string; message?: string; data?: Record<string, unknown>; configVersion?: string } = {},
): DeviceEvent {
  const ev: DeviceEvent = { eventId: randomUUID(), gatewayId, type, severity, occurredAt };
  if (extra.meterId) ev.meterId = extra.meterId;
  if (extra.message) ev.message = extra.message.slice(0, 500);
  if (extra.data) ev.data = extra.data;
  if (extra.configVersion !== undefined) ev.configVersion = extra.configVersion;
  return assertValid('DeviceEvent', ev);
}

export function buildAck(
  cmdId: string,
  status: CommandAckStatus,
  at: string,
  opts: { result?: Record<string, unknown>; error?: string | null } = {},
): CommandAck {
  const ack: CommandAck = { cmdId, status, error: opts.error ? opts.error.slice(0, 500) : null };
  if (status !== 'accepted') ack.finishedAt = at;
  if (opts.result && status === 'done') ack.result = opts.result;
  return assertValid('CommandAck', ack);
}

export function buildHealth(h: Health): Health {
  return assertValid('Health', h);
}
