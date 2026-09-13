import { DomainError } from './domain.js';
import { parseIsoDateOnly, assertPeriodOrder, optionalNote } from './profit_distributions.js';

export const PERFORMANCE_REPORT_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

export const REPORT_REVIEWABLE_STATUSES = Object.freeze([
  PERFORMANCE_REPORT_STATUS.SUBMITTED,
  PERFORMANCE_REPORT_STATUS.UNDER_REVIEW,
]);

export const REPORT_APPROVABLE_STATUSES = Object.freeze([
  PERFORMANCE_REPORT_STATUS.SUBMITTED,
  PERFORMANCE_REPORT_STATUS.UNDER_REVIEW,
]);

export const REPORT_REJECTABLE_STATUSES = Object.freeze([
  PERFORMANCE_REPORT_STATUS.SUBMITTED,
  PERFORMANCE_REPORT_STATUS.UNDER_REVIEW,
]);

export const AVAILABLE_PAYABLE_DISCLAIMER =
  'Available payable amount is the sum of legally approved amounts that have not been paid. This is not a wallet balance. Live payouts are not enabled (payoutEnabled:false). Projected returns never count toward this figure.';

export const DISTRIBUTION_RULE =
  'Pro-rata by investment_poisha across active (or matured) allocations on the project for the report period. Remainder poisha assigned to the last allocation by id to preserve exact total. Negative actual profit does not generate Approved distributions.';

export const AUDIT_ACTION_PREFIXES = Object.freeze([
  'profit_',
  'exit_',
  'referral_',
  'performance_report_',
  'payment_',
]);

export function requireNonNegativePoisha(value, field) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new DomainError('INVALID_AMOUNT', `${field} must be an integer (poisha)`, 400);
  }
  if (n < 0) {
    throw new DomainError('INVALID_AMOUNT', `${field} must be >= 0`, 400);
  }
  return n;
}

export function computeActualProfitPoisha(revenuePoisha, expensePoisha) {
  return revenuePoisha - expensePoisha;
}

export function requireRejectionReason(value) {
  const text = String(value || '').trim();
  if (text.length < 3) {
    throw new DomainError('REASON_REQUIRED', 'rejection reason is required (min 3 characters)', 400);
  }
  if (text.length > 2000) {
    throw new DomainError('REASON_TOO_LONG', 'rejection reason must be at most 2000 characters', 400);
  }
  return text;
}

export function optionalSupportingDocumentKey(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (text.length > 500) {
    throw new DomainError('DOCUMENT_KEY_TOO_LONG', 'supportingDocumentKey must be at most 500 characters', 400);
  }
  return text || null;
}

/**
 * Fair pro-rata split of totalProfitPoisha by investment_poisha.
 * Returns array of { allocationId, confirmedProfitPoisha } summing exactly to total when total >= 0.
 * When totalProfitPoisha is 0, each share is 0. Negative totals throw.
 */
export function proRataByInvestmentPoisha(allocations, totalProfitPoisha) {
  const total = Number(totalProfitPoisha);
  if (!Number.isSafeInteger(total)) {
    throw new DomainError('INVALID_AMOUNT', 'actualProfitPoisha must be an integer', 400);
  }
  if (total < 0) {
    throw new DomainError(
      'NEGATIVE_PROFIT',
      'Cannot generate Approved distributions from a negative actual profit',
      409,
    );
  }
  const rows = (allocations || [])
    .map((a) => ({
      allocationId: a.allocationId || a.id,
      investmentPoisha: Number(a.investmentPoisha ?? a.investment_poisha),
    }))
    .filter((a) => a.allocationId && Number.isSafeInteger(a.investmentPoisha) && a.investmentPoisha > 0)
    .sort((a, b) => String(a.allocationId).localeCompare(String(b.allocationId)));

  if (!rows.length) {
    throw new DomainError(
      'NO_ACTIVE_ALLOCATIONS',
      'No active allocations with investment principal on this project',
      409,
    );
  }

  const sumPrincipal = rows.reduce((s, r) => s + r.investmentPoisha, 0);
  if (sumPrincipal <= 0) {
    throw new DomainError('NO_ACTIVE_ALLOCATIONS', 'Total investment principal is zero', 409);
  }

  if (total === 0) {
    return rows.map((r) => ({ allocationId: r.allocationId, confirmedProfitPoisha: 0 }));
  }

  const out = [];
  let assigned = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    let share;
    if (i === rows.length - 1) {
      share = total - assigned;
    } else {
      share = Math.floor((total * r.investmentPoisha) / sumPrincipal);
      assigned += share;
    }
    out.push({ allocationId: r.allocationId, confirmedProfitPoisha: share });
  }
  return out;
}

export function parseReportPeriod(input = {}) {
  const periodStart = parseIsoDateOnly(input.periodStart, 'periodStart');
  const periodEnd = parseIsoDateOnly(input.periodEnd, 'periodEnd');
  assertPeriodOrder(periodStart, periodEnd);
  return { periodStart, periodEnd };
}

export function mapPerformanceReport(row) {
  if (!row) return null;
  const revenue = Number(row.revenue_poisha);
  const expense = Number(row.expense_poisha);
  const actual = Number(row.actual_profit_poisha);
  return {
    id: row.id,
    projectId: row.project_id,
    projectTitle: row.project_title || null,
    projectCode: row.project_code || null,
    periodStart:
      row.period_start instanceof Date
        ? row.period_start.toISOString().slice(0, 10)
        : String(row.period_start).slice(0, 10),
    periodEnd:
      row.period_end instanceof Date
        ? row.period_end.toISOString().slice(0, 10)
        : String(row.period_end).slice(0, 10),
    revenuePoisha: revenue,
    expensePoisha: expense,
    actualProfitPoisha: actual,
    supportingDocumentKey: row.supporting_document_key || null,
    status: row.status,
    submittedBy: row.submitted_by,
    approvedBy: row.approved_by || null,
    decidedBy: row.decided_by || null,
    rejectionReason: row.rejection_reason || null,
    reviewNote: row.review_note || null,
    submittedAt: row.submitted_at,
    underReviewAt: row.under_review_at || null,
    approvedAt: row.approved_at || null,
    rejectedAt: row.rejected_at || null,
    updatedAt: row.updated_at || null,
    distributionsGeneratedAt: row.distributions_generated_at || null,
    distributionsGeneratedCount:
      row.distributions_generated_count == null ? null : Number(row.distributions_generated_count),
    label: 'Performance report',
    payoutEnabled: false,
    fundsMoved: false,
    distributionRule: DISTRIBUTION_RULE,
  };
}

export function mapAuditLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    actorId: row.actor_id || null,
    actorEmail: row.actor_email || null,
    action: row.action,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    reason: row.reason || null,
    before: row.before_json ?? null,
    after: row.after_json ?? null,
    ipAddress: row.ip_address || null,
    userAgent: row.user_agent || null,
    occurredAt: row.occurred_at,
  };
}

export function normalizeAuditPrefixes(raw) {
  if (raw == null || raw === '' || raw === 'all') {
    return [...AUDIT_ACTION_PREFIXES];
  }
  const list = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  const allowed = new Set(AUDIT_ACTION_PREFIXES);
  const out = [];
  for (const item of list) {
    const p = item.endsWith('_') ? item : `${item}_`;
    if (allowed.has(p)) {
      out.push(p);
      continue;
    }
    const found = AUDIT_ACTION_PREFIXES.find((a) => a.startsWith(item) || item.startsWith(a.replace(/_$/, '')));
    if (!found && !allowed.has(item)) {
      throw new DomainError(
        'INVALID_AUDIT_PREFIX',
        `prefix must be one of: ${AUDIT_ACTION_PREFIXES.join(', ')}`,
        400,
      );
    }
    out.push(found || p);
  }
  return out.length ? [...new Set(out)] : [...AUDIT_ACTION_PREFIXES];
}

export { parseIsoDateOnly, assertPeriodOrder, optionalNote };
