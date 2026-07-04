/**
 * rate-limit — a token-bucket rate limiter (Sprint 1 operability).
 *
 * Per-key (principal / tenant / IP) token bucket: `rate` tokens/sec, up to `burst`. Pure and
 * deterministic given a clock, so it's testable without timers. Used to throttle /query and
 * /admit on the super-peer (429 on refusal). Buckets are lazily created and pruned by GC of
 * the Map on process restart; for a long-lived service, call `sweep` periodically.
 */

interface Bucket { tokens: number; last: number }

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    /** Cap on tracked keys — bounds memory against a flood of unique keys/tokens (DoS). When
     *  exceeded, the least-recently-used bucket is evicted (a fresh key just gets a full burst,
     *  so eviction cannot grant an attacker extra allowance). */
    private readonly maxKeys = 100_000,
  ) {
    if (ratePerSec <= 0 || burst <= 0) throw new Error('rate and burst must be > 0')
    if (maxKeys <= 0) throw new Error('maxKeys must be > 0')
  }

  /** Consume one token for `key`; true if allowed, false if the bucket is empty. */
  allow(key: string, now: number = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.burst, last: now }
    const refill = ((now - b.last) / 1000) * this.ratePerSec
    b.tokens = Math.min(this.burst, b.tokens + Math.max(0, refill))
    b.last = now
    const ok = b.tokens >= 1
    if (ok) b.tokens -= 1
    // Re-insertion moves the key to the end → Map iteration order gives us LRU for free.
    this.buckets.delete(key)
    this.buckets.set(key, b)
    if (this.buckets.size > this.maxKeys) {
      const lru = this.buckets.keys().next().value
      if (lru !== undefined) this.buckets.delete(lru)
    }
    return ok
  }

  /** Drop buckets idle longer than `maxIdleMs` (call periodically in a long-lived service). */
  sweep(maxIdleMs: number, now: number = Date.now()): void {
    for (const [k, b] of this.buckets) if (now - b.last > maxIdleMs) this.buckets.delete(k)
  }
}
