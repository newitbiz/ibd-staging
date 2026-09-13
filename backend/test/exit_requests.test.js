import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIN_EXIT_HOLD_DAYS,
  resolveMinHoldDays,
  holdDaysElapsed,
  assertExitEligibility,
  estimateExitPayablePoisha,
  buildExitEligibilityPayload,
  optionalExitNote,
  requireDecisionReason,
  LIQUIDITY_DISCLAIMER,
  OPEN_EXIT_STATUSES,
} from '../src/exit_requests.js';
import { DomainError } from '../src/domain.js';

test('default min hold is 180 days; project override respected', () => {
  assert.equal(resolveMinHoldDays(null), DEFAULT_MIN_EXIT_HOLD_DAYS);
  assert.equal(resolveMinHoldDays(undefined), 180);
  assert.equal(resolveMinHoldDays(0), 0);
  assert.equal(resolveMinHoldDays(90), 90);
  assert.throws(() => resolveMinHoldDays(-1), (e) => e instanceof DomainError);
});

test('holdDaysElapsed floors whole days from activated_at', () => {
  const activated = new Date('2026-01-01T00:00:00.000Z');
  const now = new Date('2026-01-11T12:00:00.000Z');
  assert.equal(holdDaysElapsed(activated, now), 10);
});

test('assertExitEligibility rejects before min hold and wrong status', () => {
  const activated = new Date(Date.now() - 10 * 86_400_000);
  assert.throws(
    () =>
      assertExitEligibility({
        allocationStatus: 'active',
        activatedAt: activated,
        projectMinimumExitDays: 180,
      }),
    (e) => e.code === 'HOLD_PERIOD_NOT_MET',
  );
  assert.throws(
    () =>
      assertExitEligibility({
        allocationStatus: 'exited',
        activatedAt: new Date(Date.now() - 200 * 86_400_000),
        projectMinimumExitDays: 0,
      }),
    (e) => e.code === 'ALLOCATION_NOT_ELIGIBLE',
  );
  const ok = assertExitEligibility({
    allocationStatus: 'active',
    activatedAt: new Date(Date.now() - 200 * 86_400_000),
    projectMinimumExitDays: 180,
  });
  assert.equal(ok.minHoldDays, 180);
  assert.ok(ok.holdDaysElapsed >= 180);
});

test('estimateExitPayablePoisha is principal minus deduction', () => {
  assert.equal(estimateExitPayablePoisha({ investmentPoisha: 850_000, deductionPoisha: 50_000 }), 800_000);
  assert.equal(estimateExitPayablePoisha({ investmentPoisha: 100, deductionPoisha: 200 }), 0);
});

test('eligibility payload + liquidity disclaimer; no wallet language', () => {
  const payload = buildExitEligibilityPayload({
    allocationStatus: 'active',
    activatedAt: new Date(Date.now() - 5 * 86_400_000),
    projectMinimumExitDays: 180,
    investmentPoisha: 850_000,
    hasOpenExit: false,
  });
  assert.equal(payload.eligible, false);
  assert.equal(payload.liquidityGuaranteed, false);
  assert.equal(payload.payoutEnabled, false);
  assert.match(payload.liquidityDisclaimer, /not guaranteed/i);
  assert.match(LIQUIDITY_DISCLAIMER, /display-only/i);
  assert.doesNotMatch(JSON.stringify(payload).toLowerCase(), /wallet/);
  assert.ok(OPEN_EXIT_STATUSES.includes('submitted'));
});

test('note validators', () => {
  assert.equal(optionalExitNote(''), null);
  assert.equal(requireDecisionReason('Too early'), 'Too early');
  assert.throws(() => requireDecisionReason('ab'), (e) => e.code === 'REASON_REQUIRED');
});
