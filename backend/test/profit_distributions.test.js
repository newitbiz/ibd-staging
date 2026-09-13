import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyProjectedReturnPoisha,
  projectedAccruedReturnPoisha,
  buildProjectionPayload,
  parseIsoDateOnly,
  assertPeriodOrder,
  requireConfirmedProfitPoisha,
  ESTIMATE_LABEL,
  PROJECTION_DISCLAIMER,
} from '../src/profit_distributions.js';
import { calculateEstimatedProfit, DomainError } from '../src/domain.js';

test('dailyProjectedReturnPoisha uses principal × bps / 365 / 10000', () => {
  // 1_000_000 poisha @ 1200 bps → round(1000000*1200/(365*10000)) = round(328.767…) = 329
  assert.equal(dailyProjectedReturnPoisha({ investmentPoisha: 1_000_000, annualProjectedRateBps: 1200 }), 329);
  assert.equal(dailyProjectedReturnPoisha({ investmentPoisha: 0, annualProjectedRateBps: 1500 }), 0);
});

test('projectedAccruedReturnPoisha matches calculateEstimatedProfit (excludes fee)', () => {
  const args = {
    investmentPoisha: 2_550_000,
    targetProfitBps: 1800,
    elapsedDays: 30,
    projectDays: 365,
  };
  assert.equal(projectedAccruedReturnPoisha(args), calculateEstimatedProfit(args));
});

test('buildProjectionPayload separates projection from Approved distributions', () => {
  const payload = buildProjectionPayload({
    investmentPoisha: 1_000_000,
    targetProfitBps: 1200,
    elapsedDays: 10,
    projectDays: 365,
    confirmedProfitPoisha: 50_000,
    approvedDistributions: [{ id: 'x', confirmedProfitPoisha: 50_000 }],
  });
  assert.equal(payload.estimateLabel, ESTIMATE_LABEL);
  assert.match(payload.projectionDisclaimer, /not guaranteed/i);
  assert.equal(payload.withdrawable, false);
  assert.equal(payload.projectionWithdrawable, false);
  assert.equal(payload.payoutEnabled, false);
  assert.equal(payload.confirmedProfitPoisha, 50_000);
  assert.ok(payload.projectedAccruedReturnPoisha >= 0);
  assert.equal(payload.approvedDistributions.length, 1);
  assert.doesNotMatch(JSON.stringify(payload).toLowerCase(), /wallet/);
  assert.match(PROJECTION_DISCLAIMER, /never auto-convert/i);
});

test('period and amount validators', () => {
  assert.equal(parseIsoDateOnly('2026-01-01', 'periodStart'), '2026-01-01');
  assert.throws(() => parseIsoDateOnly('01-01-2026'), (e) => e instanceof DomainError);
  assert.throws(() => assertPeriodOrder('2026-02-01', '2026-01-01'), (e) => e.code === 'INVALID_PERIOD');
  assert.equal(requireConfirmedProfitPoisha(0), 0);
  assert.throws(() => requireConfirmedProfitPoisha(-1), (e) => e.code === 'INVALID_AMOUNT');
});
