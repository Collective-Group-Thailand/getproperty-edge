import { createHash } from 'node:crypto';

/** Deterministic PRNG (mulberry32) seeded from a string — used by the simulator and jitter in tests. */
export function seededRandom(seed: string | number): () => number {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0);
}
