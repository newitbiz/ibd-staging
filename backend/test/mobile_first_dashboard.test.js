import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECTION_ONLY_LABEL,
  calcProjectedProfitPoisha,
  assertProjectionNotInConfirmed,
  buildProjectSharePayload,
} from '../src/mobile_first_dashboard.js';

test('projection label is exact required string', () => {
  assert.equal(PROJECTION_ONLY_LABEL, 'Projection only—not guaranteed');
});

test('calcProjectedProfitPoisha truncates toward zero (integer poisha)', () => {
  // 1_000_000 * 1200 bps * 30 / (10000*365) = 9863.013... → 9863
  const r = calcProjectedProfitPoisha({
    principalPoisha: 1_000_000,
    annualReturnBps: 1200,
    elapsedDays: 30,
  });
  assert.equal(r, 9863);
  assert.equal(Number.isSafeInteger(r), true);
});

test('projection never marked as confirmed/available/withdrawable', () => {
  const r = assertProjectionNotInConfirmed({
    confirmedPoisha: 100,
    projectedPoisha: 9999,
    availablePoisha: 50,
    withdrawnPoisha: 25,
  });
  assert.equal(r.projectionCountedAsConfirmed, false);
  assert.equal(r.projectionCountedAsAvailable, false);
  assert.equal(r.projectionCountedAsWithdrawable, false);
  assert.equal(r.projectionLabel, PROJECTION_ONLY_LABEL);
  assert.equal(r.confirmedPoisha, 100);
  assert.equal(r.projectedPoisha, 9999);
});

test('project share payload excludes owner PII and embeds referral code', () => {
  const p = buildProjectSharePayload({
    projectId: '11111111-1111-4111-8111-111111111111',
    projectTitle: 'Demo Farm',
    projectSlug: 'demo-farm',
    referralCode: 'IEC-ABCD',
    webBase: 'https://web-production-ba84bb.up.railway.app',
  });
  assert.equal(p.containsOwnerPii, false);
  assert.match(p.shareUrl, /ref=IEC-ABCD/);
  assert.doesNotMatch(p.shareText, /@|phone|\+880/i);
  assert.match(p.shareText, /Invest in Bangladesh/);
});

test('share without referral code still has no owner PII', () => {
  const p = buildProjectSharePayload({
    projectId: '11111111-1111-4111-8111-111111111111',
    projectTitle: 'Demo Farm',
    projectSlug: null,
    referralCode: null,
    webBase: 'https://example.test/',
  });
  assert.equal(p.containsOwnerPii, false);
  assert.match(p.shareUrl, /\/projects\//);
  assert.equal(p.referralCode, null);
});
