import { calculateEstimatedProfit, DomainError } from './domain.js';

export const PROFIT_CONFIRMATION_STATUS = Object.freeze({
  APPROVED: 'approved',
  CANCELLED: 'cancelled',
});

export const PROJECTION_DISCLAIMER =
  'Projected return — not guaranteed. Actual profit depends on project performance and approved accounts. Projections are never withdrawable and never auto-convert into Approved distributions.';

export const ESTIMATE_LABEL = 'Projected return — not guaranteed';

/**
 * Daily projected accrual in integer poisha (non-guaranteed estimate).
 * Formula: round(principal × annual_bps / 365 / 10000)
 * Principal = investment_poisha (excludes admin fee).
 */
export function dailyProjectedReturnPoisha({ investmentPoisha, annualProjectedRateBps }) {
  const principal = Number(investmentPoisha);
  const bps = Number(annualProjectedRateBps);
  if (!Number.isSafeInteger(principal) || principal < 0) {
    throw new DomainError('INVALID_PRINCIPAL', 'investmentPoisha must be a non-negative integer', 400);
  }
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) {
    throw new DomainError('INVALID_RATE_BPS', 'annualProjectedRateBps must be an integer 0–10000', 400);
  }
  return Math.round((principal * bps) / (365 * 10_000));
}

/**
 * Accrued projected return for elapsed days using existing domain helper.
 * principal × rate × eligibleDays / (period × 10000)
 */
export function projectedAccruedReturnPoisha({
  investmentPoisha,
  targetProfitBps,
  elapsedDays,
  projectDays,
}) {
  return calculateEstimatedProfit({
    investmentPoisha,
    targetProfitBps,
    elapsedDays,
    projectDays,
  });
}

export function parseIsoDateOnly(value, field = 'date') {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new DomainError('INVALID_DATE', `${field} must be YYYY-MM-DD`, 400);
  }
  const d = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new DomainError('INVALID_DATE', `${field} is not a valid calendar date`, 400);
  }
  return text;
}

export function assertPeriodOrder(periodStart, periodEnd) {
  if (periodEnd < periodStart) {
    throw new DomainError('INVALID_PERIOD', 'periodEnd must be on or after periodStart', 400);
  }
}

export function requireConfirmedProfitPoisha(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new DomainError('INVALID_AMOUNT', 'confirmedProfitPoisha must be an integer (poisha)', 400);
  }
  if (n < 0) {
    throw new DomainError('INVALID_AMOUNT', 'confirmedProfitPoisha must be >= 0', 400);
  }
  return n;
}

export function optionalNote(value, field = 'notes') {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (text.length > 2000) {
    throw new DomainError('NOTE_TOO_LONG', `${field} must be at most 2000 characters`, 400);
  }
  return text || null;
}

export function mapProfitConfirmation(row) {
  if (!row) return null;
  const confirmed = Number(row.confirmed_profit_poisha);
  const status = row.status || PROFIT_CONFIRMATION_STATUS.APPROVED;
  const available =
    row.available_payable_poisha == null
      ? status === PROFIT_CONFIRMATION_STATUS.APPROVED
        ? confirmed
        : 0
      : Number(row.available_payable_poisha);
  return {
    id: row.id,
    allocationId: row.allocation_id,
    periodStart: row.period_start instanceof Date
      ? row.period_start.toISOString().slice(0, 10)
      : String(row.period_start).slice(0, 10),
    periodEnd: row.period_end instanceof Date
      ? row.period_end.toISOString().slice(0, 10)
      : String(row.period_end).slice(0, 10),
    confirmedProfitPoisha: confirmed,
    availablePayablePoisha: status === PROFIT_CONFIRMATION_STATUS.APPROVED ? available : 0,
    status,
    notes: row.notes || null,
    declarationNote: row.declaration_note || null,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    sourceReportId: row.source_report_id || null,
    createdAt: row.created_at || row.approved_at,
    label: 'Approved distribution',
    withdrawable: false,
    payoutEnabled: false,
  };
}

export function buildProjectionPayload({
  investmentPoisha,
  targetProfitBps,
  elapsedDays,
  projectDays,
  confirmedProfitPoisha = 0,
  approvedDistributions = [],
}) {
  const projected = projectedAccruedReturnPoisha({
    investmentPoisha,
    targetProfitBps,
    elapsedDays,
    projectDays,
  });
  const daily = dailyProjectedReturnPoisha({
    investmentPoisha,
    annualProjectedRateBps: targetProfitBps,
  });
  const confirmed = Number(confirmedProfitPoisha) || 0;
  return {
    projectedAccruedReturnPoisha: projected,
    estimatedProfitPoisha: projected,
    confirmedProfitPoisha: confirmed,
    approvedDistributionsTotalPoisha: confirmed,
    approvedDistributions,
    estimateLabel: ESTIMATE_LABEL,
    projectionDisclaimer: PROJECTION_DISCLAIMER,
    dailyProjectedReturnPoisha: daily,
    dailyProjectedRateFormula: 'round(investment_poisha × annual_bps / 365 / 10000)',
    withdrawable: false,
    projectionWithdrawable: false,
    payoutEnabled: false,
    estimatedAsOf: new Date().toISOString(),
  };
}
