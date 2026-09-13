import { DomainError } from './domain.js';

/** Default minimum early-exit holding period (days) when project has no override. */
export const DEFAULT_MIN_EXIT_HOLD_DAYS = 180;

export const EXIT_REQUEST_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  APPROVED_WAITING_LIQUIDITY: 'approved_waiting_liquidity',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const OPEN_EXIT_STATUSES = Object.freeze([
  EXIT_REQUEST_STATUS.SUBMITTED,
  EXIT_REQUEST_STATUS.UNDER_REVIEW,
  EXIT_REQUEST_STATUS.APPROVED_WAITING_LIQUIDITY,
  EXIT_REQUEST_STATUS.APPROVED,
]);

export const CANCELABLE_EXIT_STATUSES = Object.freeze([
  EXIT_REQUEST_STATUS.SUBMITTED,
  EXIT_REQUEST_STATUS.UNDER_REVIEW,
]);

export const REVIEWABLE_EXIT_STATUSES = Object.freeze([EXIT_REQUEST_STATUS.SUBMITTED]);

export const DECIDABLE_EXIT_STATUSES = Object.freeze([
  EXIT_REQUEST_STATUS.SUBMITTED,
  EXIT_REQUEST_STATUS.UNDER_REVIEW,
]);

export const COMPLETABLE_EXIT_STATUSES = Object.freeze([
  EXIT_REQUEST_STATUS.APPROVED,
  EXIT_REQUEST_STATUS.APPROVED_WAITING_LIQUIDITY,
]);

export const LIQUIDITY_DISCLAIMER =
  'Liquidity is not guaranteed. An approved exit request may wait until liquidity is available. Exit payment records are display-only — live payouts are not enabled.';

export const EXIT_ELIGIBILITY_DISCLAIMER =
  'Early exit is subject to the minimum holding period and liquidity review. Projections and Approved distributions do not guarantee an Exit payment.';

export function resolveMinHoldDays(projectMinimumExitDays) {
  if (projectMinimumExitDays == null || projectMinimumExitDays === '') {
    return DEFAULT_MIN_EXIT_HOLD_DAYS;
  }
  const n = Number(projectMinimumExitDays);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DomainError('INVALID_MIN_EXIT_DAYS', 'minimumExitDays must be a non-negative integer', 400);
  }
  return n;
}

export function holdDaysElapsed(activatedAt, now = new Date()) {
  if (!activatedAt) {
    throw new DomainError('ACTIVATION_REQUIRED', 'Allocation has no activation date', 409);
  }
  const start = activatedAt instanceof Date ? activatedAt : new Date(activatedAt);
  if (Number.isNaN(start.getTime())) {
    throw new DomainError('INVALID_ACTIVATED_AT', 'Allocation activated_at is invalid', 409);
  }
  const ms = now.getTime() - start.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function assertExitEligibility({
  allocationStatus,
  activatedAt,
  projectMinimumExitDays,
  now = new Date(),
}) {
  if (!['active', 'matured'].includes(allocationStatus)) {
    throw new DomainError(
      'ALLOCATION_NOT_ELIGIBLE',
      `Cannot submit exit request for allocation status ${allocationStatus}`,
      409,
    );
  }
  const minHold = resolveMinHoldDays(projectMinimumExitDays);
  const elapsed = holdDaysElapsed(activatedAt, now);
  if (elapsed < minHold) {
    throw new DomainError(
      'HOLD_PERIOD_NOT_MET',
      `Early exit requires a minimum holding period of ${minHold} days (elapsed ${elapsed})`,
      409,
    );
  }
  return { minHoldDays: minHold, holdDaysElapsed: elapsed };
}

export function optionalExitNote(value, field = 'reason') {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (text.length > 2000) {
    throw new DomainError('NOTE_TOO_LONG', `${field} must be at most 2000 characters`, 400);
  }
  return text || null;
}

export function requireDecisionReason(value, field = 'reason') {
  const text = optionalExitNote(value, field);
  if (!text || text.length < 3) {
    throw new DomainError('REASON_REQUIRED', `${field} is required (at least 3 characters)`, 400);
  }
  return text;
}

export function optionalNonNegativePoisha(value, field = 'deductionPoisha') {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new DomainError('INVALID_AMOUNT', `${field} must be a non-negative integer (poisha)`, 400);
  }
  return n;
}

export function estimateExitPayablePoisha({ investmentPoisha, deductionPoisha = 0 }) {
  const principal = Number(investmentPoisha);
  const ded = Number(deductionPoisha) || 0;
  if (!Number.isSafeInteger(principal) || principal < 0) {
    throw new DomainError('INVALID_PRINCIPAL', 'investmentPoisha must be a non-negative integer', 400);
  }
  if (!Number.isSafeInteger(ded) || ded < 0) {
    throw new DomainError('INVALID_AMOUNT', 'deductionPoisha must be a non-negative integer', 400);
  }
  return Math.max(0, principal - ded);
}

export function mapExitRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    allocationId: row.allocation_id,
    investorId: row.investor_id,
    reason: row.reason || null,
    status: row.status,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    decisionNote: row.decision_note || null,
    deductionPoisha: row.deduction_poisha == null ? null : Number(row.deduction_poisha),
    estimatedPayablePoisha:
      row.estimated_payable_poisha == null ? null : Number(row.estimated_payable_poisha),
    liquidityNote: row.liquidity_note || null,
    minHoldDays: row.min_hold_days == null ? null : Number(row.min_hold_days),
    holdDaysElapsed: row.hold_days_elapsed == null ? null : Number(row.hold_days_elapsed),
    payoutId: row.payout_id || null,
    updatedAt: row.updated_at || row.decided_at || row.requested_at,
    liquidityGuaranteed: false,
    liquidityDisclaimer: LIQUIDITY_DISCLAIMER,
    payoutEnabled: false,
    label: 'Exit request',
  };
}

export function mapExitPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    allocationId: row.allocation_id,
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
    label: 'Exit payment',
    payoutEnabled: false,
    fundsMoved: false,
    note: 'Display-only Exit payment record — live payouts are not enabled.',
  };
}

export function buildExitEligibilityPayload({
  allocationStatus,
  activatedAt,
  projectMinimumExitDays,
  investmentPoisha,
  hasOpenExit = false,
  now = new Date(),
}) {
  const minHoldDays = resolveMinHoldDays(projectMinimumExitDays);
  const elapsed = activatedAt ? holdDaysElapsed(activatedAt, now) : 0;
  const eligibleStatus = ['active', 'matured'].includes(allocationStatus);
  const holdMet = elapsed >= minHoldDays;
  const eligible = eligibleStatus && holdMet && !hasOpenExit;
  let blockingReason = null;
  if (!eligibleStatus) blockingReason = `Allocation status ${allocationStatus} is not eligible`;
  else if (hasOpenExit) blockingReason = 'An open exit request already exists for this share holding';
  else if (!holdMet) {
    blockingReason = `Minimum holding period of ${minHoldDays} days not met (elapsed ${elapsed})`;
  }
  return {
    eligible,
    blockingReason,
    minHoldDays,
    holdDaysElapsed: elapsed,
    daysRemaining: Math.max(0, minHoldDays - elapsed),
    allocationStatus,
    hasOpenExit: Boolean(hasOpenExit),
    estimatedPayablePoisha: estimateExitPayablePoisha({
      investmentPoisha,
      deductionPoisha: 0,
    }),
    liquidityGuaranteed: false,
    liquidityDisclaimer: LIQUIDITY_DISCLAIMER,
    eligibilityDisclaimer: EXIT_ELIGIBILITY_DISCLAIMER,
    payoutEnabled: false,
  };
}
