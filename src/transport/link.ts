import type { EventEmitter } from 'node:events';

import type { TopicSuffix } from '../protocol/types.js';

/**
 * What the forwarder, health reporter and command dispatcher need from the broker connection.
 * `publish` resolves on PUBACK (QoS 1) and rejects on a PUBACK error or when the link drops.
 * Events: `connect`, `close`, `message` (suffix, payload Buffer).
 */
export interface Link extends EventEmitter {
  readonly connected: boolean;
  publish(suffix: TopicSuffix, payload: string): Promise<void>;
  /** WebSocket fallback URL announced after bootstrap (CR-015); links without a fallback ignore it. */
  setWsUrl?(wsUrl: string | undefined): void;
}
