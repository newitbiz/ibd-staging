import { createHash, randomBytes } from 'node:crypto';

import { DomainError } from './domain.js';

/** Default fixed referral reward in poisha (৳500). Admin-configurable via platform_settings. */
export const DEFAULT_REFERRAL_REWARD_POISHA = 50_000;

export const REFERRAL_FUNDING_DISCLAIMER =
  'Referral rewards are a fixed BDT amount funded from platform marketing or administration revenue — never from project investment principal. Records may be display-only; live payouts are not enabled.';

export const REFERRAL_REWARD_STATUS = Object.freeze({
  PENDING: 'pending',
  ELIGIBLE: 'eligible',
  APPROVED: 'approved',
  PAID: 'paid',
  REVERSED: 'reversed',
  REJECTED: 'rejected',
});

export const APPROVABLE_REWARD_STATUSES = Object.freeze([REFERRAL_REWARD_STATUS.ELIGIBLE]);
export const REJECTABLE_REWARD_STATUSES = Object.freeze([
  REFERRAL_REWARD_STATUS.PENDING,
  REFERRAL_REWARD_STATUS.ELIGIBLE,
]);
export const REVERSIBLE_REWARD_STATUSES = Object.freeze([
  REFERRAL_REWARD_STATUS.ELIGIBLE,
  REFERRAL_REWARD_STATUS.APPROVED,
]);

/**
 * Qualifying state for reward eligibility (Phase 7 choice):
 * referred investor's application has an active allocation after payment verification.
 */
export const QUALIFYING_APPLICATION_STATUSES = Object.freeze(['active', 'matured']);

export function normalizeReferralCode(raw) {
  if (raw == null || raw === '') return null;
  const code = String(raw).trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (code.length < 4 || code.length > 32) {
    throw new DomainError('INVALID_REFERRAL_CODE', 'Referral code must be 4–32 characters', 400);
  }
  return code;
}

export function generateReferralCode(userId) {
  const suffix = createHash('sha256')
    .update(String(userId) + randomBytes(4).toString('hex'))
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `GB-${suffix}`;
}

export function requirePositiveRewardPoisha(value, field = 'rewardPoisha') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new DomainError('INVALID_REWARD', `${field} must be a positive integer (poisha)`, 400);
  }
  return n;
}

export function optionalReferralNote(value, field = 'reason') {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (text.length > 2000) {
    throw new DomainError('NOTE_TOO_LONG', `${field} must be at most 2000 characters`, 400);
  }
  return text || null;
}

export function requireReferralReason(value, field = 'reason') {
  const text = optionalReferralNote(value, field);
  if (!text || text.length < 3) {
    throw new DomainError('REASON_REQUIRED', `${field} is required (at least 3 characters)`, 400);
  }
  return text;
}

export function assertNotSelfReferral(referrerId, referredUserId) {
  if (!referrerId || !referredUserId) {
    throw new DomainError('INVALID_REFERRAL', 'Referrer and referred user are required', 400);
  }
  if (referrerId === referredUserId) {
    throw new DomainError('SELF_REFERRAL_FORBIDDEN', 'You cannot refer yourself', 409);
  }
}

export function mapReferral(row) {
  if (!row) return null;
  return {
    id: row.id,
    referrerId: row.referrer_id,
    referredUserId: row.referred_user_id,
    referralCode: row.referral_code,
    createdAt: row.created_at,
  };
}

export function mapReferralReward(row) {
  if (!row) return null;
  return {
    id: row.id,
    referralId: row.referral_id,
    qualifyingApplicationId: row.qualifying_application_id,
    rewardPoisha: Number(row.reward_poisha),
    status: row.status,
    eligibleAt: row.eligible_at || null,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    paidAt: row.paid_at || null,
    rejectionReason: row.rejection_reason || null,
    payoutId: row.payout_id || null,
    decidedBy: row.decided_by || null,
    reversedAt: row.reversed_at || null,
    rejectedAt: row.rejected_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    fundingDisclaimer: REFERRAL_FUNDING_DISCLAIMER,
    payoutEnabled: false,
    fundsMoved: false,
    label: 'Referral reward',
  };
}

export function mapReferralPayout(row) {
  if (!row) return null;
  return {
    id: row.id,
    allocationId: row.allocation_id || null,
    investorId: row.investor_id,
    payoutType: row.payout_type,
    amountPoisha: Number(row.amount_poisha),
    status: row.status,
    destinationReference: row.destination_reference,
    providerReference: row.provider_reference || null,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    paidAt: row.paid_at || null,
    createdAt: row.created_at,
    label: 'Referral reward',
    payoutEnabled: false,
    fundsMoved: false,
    note: 'Display-only Referral reward record — live payouts are not enabled. Funded from platform marketing/admin revenue, never from project investment principal.',
  };
}

export function parseRewardPoishaSetting(valueJson) {
  if (valueJson == null) return DEFAULT_REFERRAL_REWARD_POISHA;
  const raw = typeof valueJson === 'object' && valueJson !== null && 'value' in valueJson
    ? valueJson.value
    : valueJson;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_REFERRAL_REWARD_POISHA;
  return n;
}
