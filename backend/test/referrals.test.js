import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REFERRAL_REWARD_POISHA,
  REFERRAL_FUNDING_DISCLAIMER,
  REFERRAL_REWARD_STATUS,
  APPROVABLE_REWARD_STATUSES,
  normalizeReferralCode,
  generateReferralCode,
  requirePositiveRewardPoisha,
  requireReferralReason,
  assertNotSelfReferral,
  mapReferralReward,
  mapReferralPayout,
  parseRewardPoishaSetting,
  QUALIFYING_APPLICATION_STATUSES,
} from '../src/referrals.js';
import { DomainError } from '../src/domain.js';

test('default fixed reward is positive poisha integer (not percent)', () => {
  assert.equal(DEFAULT_REFERRAL_REWARD_POISHA, 50_000);
  assert.ok(Number.isSafeInteger(DEFAULT_REFERRAL_REWARD_POISHA));
});

test('normalizeReferralCode uppercases and validates length', () => {
  assert.equal(normalizeReferralCode('gb-abcd12'), 'GB-ABCD12');
  assert.equal(normalizeReferralCode(null), null);
  assert.throws(() => normalizeReferralCode('ab'), (e) => e instanceof DomainError && e.code === 'INVALID_REFERRAL_CODE');
});

test('generateReferralCode is GB-prefixed and stable-ish length', () => {
  const code = generateReferralCode('user-1');
  assert.match(code, /^GB-[A-F0-9]{8}$/);
});

test('self-referral forbidden', () => {
  assert.throws(
    () => assertNotSelfReferral('u1', 'u1'),
    (e) => e.code === 'SELF_REFERRAL_FORBIDDEN',
  );
  assert.doesNotThrow(() => assertNotSelfReferral('u1', 'u2'));
});

test('reward poisha validators', () => {
  assert.equal(requirePositiveRewardPoisha(25000), 25000);
  assert.throws(() => requirePositiveRewardPoisha(0), (e) => e.code === 'INVALID_REWARD');
  assert.throws(() => requirePositiveRewardPoisha(-1), (e) => e.code === 'INVALID_REWARD');
  assert.equal(requireReferralReason('abuse flag'), 'abuse flag');
  assert.throws(() => requireReferralReason('x'), (e) => e.code === 'REASON_REQUIRED');
});

test('funding disclaimer never mentions wallet; says not from principal', () => {
  assert.match(REFERRAL_FUNDING_DISCLAIMER, /fixed BDT/i);
  assert.match(REFERRAL_FUNDING_DISCLAIMER, /never from project investment principal/i);
  assert.match(REFERRAL_FUNDING_DISCLAIMER, /marketing|administration/i);
  assert.doesNotMatch(REFERRAL_FUNDING_DISCLAIMER.toLowerCase(), /wallet/);
});

test('qualifying rule prefers allocation active after payment verified', () => {
  assert.ok(QUALIFYING_APPLICATION_STATUSES.includes('active'));
  assert.ok(APPROVABLE_REWARD_STATUSES.includes(REFERRAL_REWARD_STATUS.ELIGIBLE));
});

test('mappers are display-only and avoid wallet language', () => {
  const reward = mapReferralReward({
    id: 'r1',
    referral_id: 'ref1',
    qualifying_application_id: 'app1',
    reward_poisha: 50000,
    status: 'eligible',
    eligible_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
  assert.equal(reward.payoutEnabled, false);
  assert.equal(reward.fundsMoved, false);
  assert.equal(reward.label, 'Referral reward');
  assert.doesNotMatch(JSON.stringify(reward).toLowerCase(), /wallet/);

  const payout = mapReferralPayout({
    id: 'p1',
    investor_id: 'u1',
    payout_type: 'referral_reward',
    amount_poisha: 50000,
    status: 'approved',
    destination_reference: 'referral-reward:r1:display-only',
    created_at: new Date().toISOString(),
  });
  assert.equal(payout.fundsMoved, false);
  assert.equal(payout.payoutEnabled, false);
  assert.match(payout.note, /display-only/i);
  assert.match(payout.note, /never from project investment principal/i);
  assert.doesNotMatch(JSON.stringify(payout).toLowerCase(), /wallet/);
});

test('parseRewardPoishaSetting falls back to default', () => {
  assert.equal(parseRewardPoishaSetting(75000), 75000);
  assert.equal(parseRewardPoishaSetting({ value: 1000 }), 1000);
  assert.equal(parseRewardPoishaSetting(null), DEFAULT_REFERRAL_REWARD_POISHA);
  assert.equal(parseRewardPoishaSetting(-5), DEFAULT_REFERRAL_REWARD_POISHA);
});
