/**
 * In-memory fixed-window rate limiter.
 *
 * Suitable for the single-instance deployment this phase targets. For
 * multi-instance production (e.g. Vercel with several lambdas) swap the Map
 * for a shared store such as Redis/Upstash — the call signature stays the same.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function prune() {
  if (buckets.size < 512) return;
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Consume one slot for `key`; limit requests per windowMs. */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  prune();
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}
