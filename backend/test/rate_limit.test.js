import test from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowRateLimiter, enforceRateLimit } from '../src/rate_limit.js';
import { DomainError } from '../src/domain.js';

test('sliding window blocks after limit and returns RATE_LIMITED', () => {
  const limiter = new SlidingWindowRateLimiter({ sweepIntervalMs: 60_000 });
  const key = `t-${Date.now()}`;
  for (let i = 0; i < 3; i += 1) {
    const r = limiter.check(key, 3, 60_000);
    assert.equal(r.allowed, true);
  }
  const blocked = limiter.check(key, 3, 60_000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);

  const k = `enforce-once-${Date.now()}`;
  enforceRateLimit(DomainError, k, { limit: 1, windowMs: 60_000 });
  try {
    enforceRateLimit(DomainError, k, { limit: 1, windowMs: 60_000 });
    assert.fail('expected rate limit');
  } catch (error) {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.httpStatus, 429);
  }
});
