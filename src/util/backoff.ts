/** Exponential backoff with full jitter (AWS architecture blog), capped. */
export class Backoff {
  private attempt = 0;
  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly random: () => number = Math.random,
  ) {}

  next(): number {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.attempt, 30));
    this.attempt++;
    return Math.max(this.baseMs / 2, Math.floor(this.random() * ceiling));
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}
