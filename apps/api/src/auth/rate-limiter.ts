export interface RateLimitConfiguration {
  maxRequests: number;
  windowMs: number;
  maxTrackedKeys?: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly maxTrackedKeys: number;
  private readonly now: () => number;

  constructor(private readonly configuration: RateLimitConfiguration) {
    this.maxTrackedKeys = configuration.maxTrackedKeys ?? 10_000;
    this.now = configuration.now ?? Date.now;
  }

  consume(key: string): RateLimitDecision {
    const currentTime = this.now();
    let bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= currentTime) {
      this.buckets.delete(key);
      this.removeExpiredBuckets(currentTime);
      this.ensureCapacity();
      bucket = { count: 0, resetAt: currentTime + this.configuration.windowMs };
      this.buckets.set(key, bucket);
    } else {
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }

    if (bucket.count >= this.configuration.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000)),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.configuration.maxRequests - bucket.count,
      retryAfterSeconds: 0,
    };
  }

  private removeExpiredBuckets(currentTime: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= currentTime) this.buckets.delete(key);
    }
  }

  private ensureCapacity(): void {
    while (this.buckets.size >= this.maxTrackedKeys) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) return;
      this.buckets.delete(oldestKey);
    }
  }
}
