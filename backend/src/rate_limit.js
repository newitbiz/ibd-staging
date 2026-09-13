/**
 * Redis-free in-memory sliding-window rate limiter for single-replica staging.
 * Keys are arbitrary strings (e.g. "register:ip:1.2.3.4").
 */
export class SlidingWindowRateLimiter {
  constructor({ sweepIntervalMs = 60_000 } = {}) {
    /** @type {Map<string, number[]>} */
    this.buckets = new Map();
    this._timer = setInterval(() => this.#sweep(), sweepIntervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /**
   * @param {string} key
   * @param {number} limit max events in window
   * @param {number} windowMs sliding window length
   * @returns {{ allowed: boolean, remaining: number, retryAfterSeconds: number }}
   */
  check(key, limit, windowMs) {
    const now = Date.now();
    const prior = this.buckets.get(key) || [];
    const timestamps = prior.filter((t) => now - t < windowMs);
    if (timestamps.length >= limit) {
      this.buckets.set(key, timestamps);
      const retryAfterMs = Math.max(0, windowMs - (now - timestamps[0]));
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }
    timestamps.push(now);
    this.buckets.set(key, timestamps);
    return {
      allowed: true,
      remaining: Math.max(0, limit - timestamps.length),
      retryAfterSeconds: 0,
    };
  }

  /** Test helper: clear all buckets. */
  reset() {
    this.buckets.clear();
  }

  #sweep() {
    const now = Date.now();
    const maxAge = 3_600_000;
    for (const [key, timestamps] of this.buckets) {
      const kept = timestamps.filter((t) => now - t < maxAge);
      if (!kept.length) this.buckets.delete(key);
      else this.buckets.set(key, kept);
    }
  }
}

export const authRateLimiter = new SlidingWindowRateLimiter();

/** Reasonable staging defaults (per-IP unless noted). */
export const AUTH_RATE_LIMITS = {
  register: { limit: Number(process.env.RATE_LIMIT_REGISTER_PER_HOUR || 5), windowMs: 60 * 60 * 1000 },
  login: { limit: Number(process.env.RATE_LIMIT_LOGIN_PER_15M || 20), windowMs: 15 * 60 * 1000 },
  otpVerify: { limit: Number(process.env.RATE_LIMIT_OTP_VERIFY_PER_15M || 10), windowMs: 15 * 60 * 1000 },
  otpRequest: { limit: Number(process.env.RATE_LIMIT_OTP_REQUEST_PER_15M || 10), windowMs: 15 * 60 * 1000 },
  accountSoft: { limit: Number(process.env.RATE_LIMIT_ACCOUNT_SOFT_PER_15M || 30), windowMs: 15 * 60 * 1000 },
  emailVerify: {
    limit: Number(process.env.RATE_LIMIT_EMAIL_VERIFY_PER_15M || 10),
    windowMs: 15 * 60 * 1000,
  },
  /** Max 3 resends per hour per account/IP (requirement). */
  emailResend: {
    limit: Number(process.env.RATE_LIMIT_EMAIL_RESEND_PER_HOUR || 3),
    windowMs: 60 * 60 * 1000,
  },
  /** Max referral code attach attempts per hour per account/IP. */
  referralAttach: {
    limit: Number(process.env.RATE_LIMIT_REFERRAL_ATTACH_PER_HOUR || 10),
    windowMs: 60 * 60 * 1000,
  },
};

/**
 * Enforce a limit; throws DomainError with code RATE_LIMITED.
 */
export function enforceRateLimit(DomainError, key, { limit, windowMs }) {
  const result = authRateLimiter.check(key, limit, windowMs);
  if (!result.allowed) {
    const err = new DomainError(
      'RATE_LIMITED',
      `Too many requests. Try again in about ${result.retryAfterSeconds}s.`,
      429,
    );
    err.retryAfterSeconds = result.retryAfterSeconds;
    throw err;
  }
  return result;
}
