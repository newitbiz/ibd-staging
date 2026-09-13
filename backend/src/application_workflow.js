import { calculateAmounts, DomainError } from './domain.js';

export const APPLICATION_WORKFLOW_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED_PAYMENT_PENDING: 'approved_payment_pending',
  PAYMENT_VERIFICATION_PENDING: 'payment_verification_pending',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  PAYMENT_REJECTED: 'payment_rejected',
  MATURED: 'matured',
  EXIT_REQUESTED: 'exit_requested',
  EXIT_PROCESSING: 'exit_processing',
  EXITED: 'exited',
  DEFAULTED: 'defaulted',
});

const S = APPLICATION_WORKFLOW_STATUS;

/** Review-queue statuses shown to admin by default */
export const APPLICATION_REVIEW_QUEUE_STATUSES = Object.freeze([
  S.SUBMITTED,
  S.UNDER_REVIEW,
  S.CHANGES_REQUESTED,
]);

export const APPLICATION_TERMINAL_REVIEW_STATUSES = Object.freeze([
  S.REJECTED,
  S.EXPIRED,
  S.CANCELLED,
]);

/** Investor-cancellable before payment reservation */
export const APPLICATION_CANCELABLE_STATUSES = Object.freeze([
  S.DRAFT,
  S.SUBMITTED,
  S.UNDER_REVIEW,
  S.CHANGES_REQUESTED,
]);

/** Statuses from which admin may approve (reserve units) */
export const APPLICATION_APPROVABLE_STATUSES = Object.freeze([
  S.SUBMITTED,
  S.UNDER_REVIEW,
]);

export const APPLICATION_REJECTABLE_STATUSES = Object.freeze([
  S.SUBMITTED,
  S.UNDER_REVIEW,
  S.CHANGES_REQUESTED,
]);

export const APPLICATION_CHANGES_REQUESTABLE_STATUSES = Object.freeze([
  S.SUBMITTED,
  S.UNDER_REVIEW,
]);

export const APPLICATION_RESUBMITTABLE_STATUSES = Object.freeze([
  S.CHANGES_REQUESTED,
]);

/**
 * Controlled transitions for the application review machine (payment/active flow remains separate).
 */
export const APPLICATION_TRANSITIONS = Object.freeze({
  [S.DRAFT]: [S.SUBMITTED, S.CANCELLED],
  [S.SUBMITTED]: [S.UNDER_REVIEW, S.APPROVED_PAYMENT_PENDING, S.CHANGES_REQUESTED, S.REJECTED, S.CANCELLED, S.EXPIRED],
  [S.UNDER_REVIEW]: [S.APPROVED_PAYMENT_PENDING, S.CHANGES_REQUESTED, S.REJECTED, S.CANCELLED, S.EXPIRED],
  [S.CHANGES_REQUESTED]: [S.SUBMITTED, S.REJECTED, S.CANCELLED, S.EXPIRED],
  [S.APPROVED_PAYMENT_PENDING]: [S.PAYMENT_VERIFICATION_PENDING, S.CANCELLED, S.EXPIRED],
  [S.PAYMENT_VERIFICATION_PENDING]: [S.ACTIVE, S.PAYMENT_REJECTED],
  [S.PAYMENT_REJECTED]: [S.APPROVED_PAYMENT_PENDING, S.CANCELLED],
  [S.ACTIVE]: [S.MATURED, S.EXIT_REQUESTED, S.DEFAULTED],
  [S.MATURED]: [S.EXIT_REQUESTED, S.EXITED],
  [S.EXIT_REQUESTED]: [S.EXIT_PROCESSING, S.CANCELLED],
  [S.EXIT_PROCESSING]: [S.EXITED],
  [S.REJECTED]: [],
  [S.EXPIRED]: [],
  [S.CANCELLED]: [],
  [S.EXITED]: [],
  [S.DEFAULTED]: [],
});

export function assertApplicationTransition(from, to) {
  const allowed = APPLICATION_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new DomainError(
      'INVALID_STATUS_TRANSITION',
      `Cannot transition application from ${from} to ${to}`,
      409,
    );
  }
  return true;
}

export function requireReason(reason, field = 'reason') {
  const text = String(reason || '').trim();
  if (text.length < 3) {
    throw new DomainError('REASON_REQUIRED', `${field} must be at least 3 characters`, 400);
  }
  if (text.length > 2000) {
    throw new DomainError('REASON_TOO_LONG', `${field} must be at most 2000 characters`, 400);
  }
  return text;
}

/**
 * Pure investment calculation preview (integer poisha + bps only).
 * Example: 3 × 850000 poisha, 1500 bps → investment 2550000, fee 382500, total 2932500.
 */
export function previewInvestmentCalculation({
  unitInvestmentPoisha,
  administrationFeeBps,
  units,
  availableUnits = null,
  projectedReturnMinBps = null,
  projectedReturnMaxBps = null,
  selectedRateBps = null,
  termDays = null,
}) {
  const amounts = calculateAmounts({ unitInvestmentPoisha, administrationFeeBps, units });
  if (availableUnits != null && Number.isSafeInteger(availableUnits) && units > availableUnits) {
    throw new DomainError('INSUFFICIENT_UNITS', `Only ${availableUnits} units are available`, 409);
  }
  return {
    units,
    unitInvestmentPoisha,
    administrationFeeBps,
    investmentPoisha: amounts.investmentPoisha,
    administrationFeePoisha: amounts.administrationFeePoisha,
    totalPayablePoisha: amounts.totalPayablePoisha,
    administrationFeePoishaPerUnit: Math.round((unitInvestmentPoisha * administrationFeeBps) / 10_000),
    totalPayablePoishaPerUnit: unitInvestmentPoisha + Math.round((unitInvestmentPoisha * administrationFeeBps) / 10_000),
    availableUnits: availableUnits == null ? null : availableUnits,
    projectedReturnMinBps,
    projectedReturnMaxBps,
    selectedRateBps,
    termDays,
    projectedReturnDisclaimer:
      'Projected return — not guaranteed. Actual profit depends on project performance and approved accounts.',
    withdrawable: false,
  };
}

export function mapApplicationDetail(row, extras = {}) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    investorId: row.investor_id,
    units: Number(row.units),
    unitInvestmentPoisha: Number(row.unit_investment_poisha),
    investmentPoisha: Number(row.investment_poisha),
    administrationFeePoisha: Number(row.administration_fee_poisha),
    totalPayablePoisha: Number(row.total_payable_poisha),
    termsVersion: Number(row.terms_version),
    projectVersionNumber: row.project_version_number == null ? null : Number(row.project_version_number),
    status: row.status,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    activatedAt: row.activated_at,
    changesRequestedReason: row.changes_requested_reason || null,
    rejectionReason: row.rejection_reason || null,
    reviewNote: row.review_note || null,
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    underReviewAt: row.under_review_at || null,
    underReviewBy: row.under_review_by || null,
    cancelledAt: row.cancelled_at || null,
    cancelledBy: row.cancelled_by || null,
    expiresAt: row.expires_at || null,
    resubmittedAt: row.resubmitted_at || null,
    createdAt: row.created_at,
    ...extras,
  };
}
