export interface TokenBucketOptions {
  capacity: number;
  refillRatePerSecond: number;
}

export interface BucketState {
  tokens: number;
  lastRefillTime: number;
}

export class TokenBucketLimiter {
  private buckets = new Map<string, BucketState>();
  private capacity: number;
  private refillRatePerSecond: number;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillRatePerSecond = options.refillRatePerSecond;
  }

  public tryConsume(key: string, tokensToConsume = 1): { allowed: boolean; retryAfterSeconds?: number; remainingTokens: number } {
    const now = Date.now();
    let state = this.buckets.get(key);

    if (!state) {
      state = {
        tokens: this.capacity,
        lastRefillTime: now,
      };
      this.buckets.set(key, state);
    } else {
      // Refill tokens based on elapsed time
      const elapsedSeconds = (now - state.lastRefillTime) / 1000;
      const refilledTokens = elapsedSeconds * this.refillRatePerSecond;
      state.tokens = Math.min(this.capacity, state.tokens + refilledTokens);
      state.lastRefillTime = now;
    }

    if (state.tokens >= tokensToConsume) {
      state.tokens -= tokensToConsume;
      return {
        allowed: true,
        remainingTokens: Math.floor(state.tokens),
      };
    }

    const deficit = tokensToConsume - state.tokens;
    const retryAfterSeconds = Math.ceil(deficit / this.refillRatePerSecond);

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
      remainingTokens: 0,
    };
  }

  public reset(key?: string) {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }
}
