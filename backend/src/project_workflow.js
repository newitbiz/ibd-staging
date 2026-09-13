import { DomainError } from './domain.js';

/** Canonical Phase-2 project workflow statuses (API + DB text). */
export const PROJECT_WORKFLOW_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED_FOR_REVIEW: 'submitted_for_review',
  CHANGES_REQUESTED: 'changes_requested',
  RESUBMITTED: 'resubmitted',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  PAUSED: 'paused',
  FUNDING_CLOSED: 'funding_closed',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  ARCHIVED: 'archived',
});

const S = PROJECT_WORKFLOW_STATUS;

/** Controlled transitions: from → allowed next statuses. */
export const PROJECT_TRANSITIONS = Object.freeze({
  [S.DRAFT]: [S.SUBMITTED_FOR_REVIEW, S.CANCELLED, S.ARCHIVED],
  [S.SUBMITTED_FOR_REVIEW]: [S.CHANGES_REQUESTED, S.APPROVED, S.REJECTED, S.CANCELLED],
  [S.CHANGES_REQUESTED]: [S.RESUBMITTED, S.CANCELLED, S.REJECTED],
  [S.RESUBMITTED]: [S.CHANGES_REQUESTED, S.APPROVED, S.REJECTED, S.CANCELLED],
  [S.APPROVED]: [S.PUBLISHED, S.CANCELLED, S.ARCHIVED],
  [S.PUBLISHED]: [S.PAUSED, S.FUNDING_CLOSED, S.ARCHIVED],
  [S.PAUSED]: [S.PUBLISHED, S.FUNDING_CLOSED, S.ARCHIVED],
  [S.FUNDING_CLOSED]: [S.ACTIVE, S.ARCHIVED],
  [S.ACTIVE]: [S.COMPLETED, S.ARCHIVED],
  [S.COMPLETED]: [S.ARCHIVED],
  [S.REJECTED]: [S.ARCHIVED],
  [S.CANCELLED]: [S.ARCHIVED],
  [S.ARCHIVED]: [],
});

export const OWNER_EDITABLE_STATUSES = new Set([S.DRAFT, S.CHANGES_REQUESTED]);
export const ADMIN_EDITABLE_STATUSES = new Set([
  S.DRAFT,
  S.SUBMITTED_FOR_REVIEW,
  S.CHANGES_REQUESTED,
  S.RESUBMITTED,
  S.APPROVED,
]);
export const REVIEW_QUEUE_STATUSES = [S.SUBMITTED_FOR_REVIEW, S.RESUBMITTED, S.CHANGES_REQUESTED];
export const PUBLIC_VISIBLE_STATUSES = new Set([S.PUBLISHED, S.PAUSED, S.FUNDING_CLOSED, S.ACTIVE]);
/** Investor browse/list — pause removes from browse; detail may still show pause notice for linked records. */
export const INVESTOR_BROWSE_STATUSES = new Set([S.PUBLISHED, S.FUNDING_CLOSED, S.ACTIVE]);

/** Admin-safe administration fee range (bps). Override with env. */
export function feeBpsRange() {
  const min = Number.parseInt(process.env.PROJECT_FEE_BPS_MIN || '0', 10);
  const max = Number.parseInt(process.env.PROJECT_FEE_BPS_MAX || '2500', 10);
  return {
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 2500,
  };
}

export function assertTransition(fromStatus, toStatus) {
  const allowed = PROJECT_TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new DomainError(
      'INVALID_STATUS_TRANSITION',
      `Cannot transition project from ${fromStatus} to ${toStatus}`,
      409,
    );
  }
}

export function assertSafeInteger(value, name, minimum = 0, { allowNull = false } = {}) {
  if (value == null || value === '') {
    if (allowNull) return null;
    throw new DomainError('INVALID_INTEGER', `${name} is required`, 400);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < minimum) {
    throw new DomainError('INVALID_INTEGER', `${name} must be an integer of at least ${minimum}`, 400);
  }
  return n;
}

export function slugifyTitle(title) {
  const base = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'project';
}

export function buildProjectCode(id, createdAt = new Date()) {
  const year = new Date(createdAt).getUTCFullYear();
  const short = String(id).replace(/-/g, '').slice(0, 6).toUpperCase();
  return `GB-${year}-${short}`;
}

/** Fields that force a version bump when changed after approval. */
export const MATERIAL_FINANCIAL_FIELDS = Object.freeze([
  'unitInvestmentPoisha',
  'administrationFeeBps',
  'totalUnits',
  'fundingTargetPoisha',
  'fundingTargetException',
  'projectedReturnMinBps',
  'projectedReturnMaxBps',
  'selectedRateBps',
  'durationDays',
  'minimumExitDays',
  'exitPolicy',
  'termsText',
]);

export function materialSnapshot(projectLike) {
  return {
    title: projectLike.title,
    categoryId: projectLike.categoryId ?? projectLike.category_id,
    unitInvestmentPoisha: Number(projectLike.unitInvestmentPoisha ?? projectLike.unit_investment_poisha),
    administrationFeeBps: Number(projectLike.administrationFeeBps ?? projectLike.administration_fee_bps),
    totalUnits: Number(projectLike.totalUnits ?? projectLike.total_units),
    fundingTargetPoisha: Number(projectLike.fundingTargetPoisha ?? projectLike.funding_target_poisha),
    fundingTargetException: Boolean(
      projectLike.fundingTargetException ?? projectLike.funding_target_exception,
    ),
    projectedReturnMinBps: Number(
      projectLike.projectedReturnMinBps ?? projectLike.projected_return_min_bps,
    ),
    projectedReturnMaxBps: Number(
      projectLike.projectedReturnMaxBps ?? projectLike.projected_return_max_bps,
    ),
    selectedRateBps: Number(projectLike.selectedRateBps ?? projectLike.selected_rate_bps),
    durationDays: Number(projectLike.durationDays ?? projectLike.duration_days),
    minimumExitDays: Number(projectLike.minimumExitDays ?? projectLike.minimum_exit_days ?? 0),
    riskDisclosure: projectLike.riskDisclosure ?? projectLike.risk_disclosure ?? null,
    termsText: projectLike.termsText ?? projectLike.terms_text ?? null,
    exitPolicy: projectLike.exitPolicy ?? projectLike.exit_policy ?? null,
  };
}

export function hasMaterialChange(before, after) {
  const a = materialSnapshot(before);
  const b = materialSnapshot(after);
  return MATERIAL_FINANCIAL_FIELDS.some((key) => {
    const camel = key;
    return String(a[camel] ?? '') !== String(b[camel] ?? '');
  });
}

/**
 * Validate project fields.
 * @param {'draft'|'submit'|'approve'|'publish'} level
 */
export function validateProjectPayload(input, level = 'draft') {
  const errors = [];
  const feeRange = feeBpsRange();

  const requireInt = (value, name, min = 1) => {
    try {
      return assertSafeInteger(value, name, min);
    } catch (err) {
      errors.push(err.message);
      return null;
    }
  };

  if (level !== 'draft' || input.categoryId != null || input.category != null) {
    if (!input.categoryId && !(typeof input.category === 'string' && input.category.trim())) {
      if (level !== 'draft') errors.push('Active category is required');
    }
  }

  const unitPrice =
    input.unitInvestmentPoisha != null
      ? requireInt(input.unitInvestmentPoisha, 'unitInvestmentPoisha', 1)
      : null;
  const totalUnits = input.totalUnits != null ? requireInt(input.totalUnits, 'totalUnits', 1) : null;
  const feeBps =
    input.administrationFeeBps != null
      ? requireInt(input.administrationFeeBps, 'administrationFeeBps', 0)
      : null;
  if (feeBps != null && (feeBps < feeRange.min || feeBps > feeRange.max)) {
    errors.push(`administrationFeeBps must be between ${feeRange.min} and ${feeRange.max}`);
  }

  if (input.availableUnits != null && totalUnits != null) {
    const available = requireInt(input.availableUnits, 'availableUnits', 0);
    if (available != null && available > totalUnits) {
      errors.push('availableUnits must be <= totalUnits');
    }
  }

  const fundingTarget =
    input.fundingTargetPoisha != null
      ? requireInt(input.fundingTargetPoisha, 'fundingTargetPoisha', 1)
      : null;
  if (unitPrice != null && totalUnits != null) {
    const expected = unitPrice * totalUnits;
    if (fundingTarget != null && fundingTarget !== expected) {
      if (!input.fundingTargetException) {
        errors.push(
          'fundingTargetPoisha must equal unitInvestmentPoisha × totalUnits unless fundingTargetException is recorded',
        );
      } else if (!String(input.fundingTargetExceptionReason || '').trim()) {
        errors.push('fundingTargetExceptionReason is required when funding target differs');
      }
    }
  }

  const minBps =
    input.projectedReturnMinBps != null
      ? requireInt(input.projectedReturnMinBps, 'projectedReturnMinBps', 0)
      : null;
  const maxBps =
    input.projectedReturnMaxBps != null
      ? requireInt(input.projectedReturnMaxBps, 'projectedReturnMaxBps', 0)
      : null;
  const selected =
    input.selectedRateBps != null
      ? requireInt(input.selectedRateBps, 'selectedRateBps', 0)
      : input.targetProfitBps != null
        ? requireInt(input.targetProfitBps, 'targetProfitBps', 0)
        : null;
  if (minBps != null && maxBps != null && minBps > maxBps) {
    errors.push('projectedReturnMinBps must be <= projectedReturnMaxBps');
  }
  if (selected != null && minBps != null && maxBps != null) {
    if (selected < minBps || selected > maxBps) {
      errors.push('selectedRateBps must be within projected return range');
    }
  }

  let duration =
    input.durationDays != null ? requireInt(input.durationDays, 'durationDays', 1) : null;
  if (input.investmentYears != null && input.investmentYears !== '') {
    const y = requireInt(input.investmentYears, 'investmentYears', 1);
    if (y != null && (y < 1 || y > 5)) errors.push('investmentYears must be between 1 and 5');
    if (y != null && duration == null) duration = y * 365;
  }
  if (level !== 'draft' && duration == null) {
    errors.push('Positive term (durationDays) is required');
  }

  const openAt = input.fundingOpensAt ? new Date(input.fundingOpensAt) : null;
  const closeAt = input.fundingClosesAt ? new Date(input.fundingClosesAt) : null;
  if (openAt && closeAt && !(closeAt > openAt)) {
    errors.push('fundingClosesAt must be after fundingOpensAt');
  }
  const startAt = input.projectStartsAt ? new Date(input.projectStartsAt) : null;
  const endAt = input.projectEndsAt ? new Date(input.projectEndsAt) : null;
  if (startAt && endAt && !(endAt > startAt)) {
    errors.push('projectEndsAt must be after projectStartsAt');
  }

  if (level === 'approve' || level === 'publish') {
    if (!String(input.riskDisclosure || '').trim()) errors.push('riskDisclosure is required');
    if (!String(input.termsText || '').trim()) errors.push('termsText is required');
    if (!String(input.exitPolicy || '').trim()) errors.push('exitPolicy is required');
    if (unitPrice == null) errors.push('unitInvestmentPoisha is required');
    if (totalUnits == null) errors.push('totalUnits is required');
    if (feeBps == null) errors.push('administrationFeeBps is required');
    if (selected == null) errors.push('selectedRateBps is required');
    if (duration == null) errors.push('durationDays is required');
  }

  if (level === 'submit') {
    if (unitPrice == null || totalUnits == null || feeBps == null || selected == null || duration == null) {
      errors.push('Commercial terms (unit price, units, fee, rate, term) are required before submit');
    }
    if (!String(input.title || '').trim() || String(input.title).trim().length < 5) {
      errors.push('title must be at least 5 characters');
    }
    if (!String(input.summary || '').trim()) errors.push('summary is required');
    if (!String(input.locationAddress || input.location_address || '').trim()) {
      errors.push('locationAddress is required before submit');
    }
    if (!String(input.badLossSummary || input.bad_loss_summary || '').trim()) {
      errors.push('badLossSummary (recovery + negative info) is required before submit');
    }
    if (!String(input.ownerExperience || input.owner_experience || '').trim()) {
      errors.push('ownerExperience is required before submit');
    }
    if (!String(input.educationalBackground || input.educational_background || '').trim()) {
      errors.push('educationalBackground is required before submit');
    }
  }

  if (errors.length) {
    throw new DomainError('PROJECT_VALIDATION_FAILED', errors.join('; '), 400);
  }
  return true;
}

export function mapProjectRow(row) {
  if (!row) return null;
  const totalUnits = Number(row.total_units);
  const reservedUnits = Number(row.reserved_units);
  const activeUnits = Number(row.active_units);
  const unitInvestmentPoisha = Number(row.unit_investment_poisha);
  const administrationFeeBps = Number(row.administration_fee_bps);
  const feePoishaPerUnit = Math.round((unitInvestmentPoisha * administrationFeeBps) / 10_000);
  return {
    id: row.id,
    businessId: row.business_id,
    ownerUserId: row.owner_user_id ?? undefined,
    businessName: row.business_legal_name || row.business_name || null,
    ownerDisplayName: row.owner_display_name || null,
    title: row.title,
    category: row.category,
    categoryId: row.category_id,
    categoryName: row.category_name || row.category,
    categorySlug: row.category_slug || null,
    slug: row.slug,
    projectCode: row.project_code,
    summary: row.summary,
    status: row.status,
    versionNumber: Number(row.version_number || 1),
    totalUnits,
    reservedUnits,
    activeUnits,
    availableUnits: totalUnits - reservedUnits - activeUnits,
    unitInvestmentPoisha,
    unitPricePoisha: unitInvestmentPoisha,
    administrationFeeBps,
    administrationFeePoishaPerUnit: feePoishaPerUnit,
    totalPayablePoishaPerUnit: unitInvestmentPoisha + feePoishaPerUnit,
    targetProfitBps: Number(row.target_profit_bps),
    selectedRateBps: Number(row.selected_rate_bps ?? row.target_profit_bps),
    projectedReturnMinBps: row.projected_return_min_bps == null ? null : Number(row.projected_return_min_bps),
    projectedReturnMaxBps: row.projected_return_max_bps == null ? null : Number(row.projected_return_max_bps),
    fundingTargetPoisha: row.funding_target_poisha == null ? null : Number(row.funding_target_poisha),
    fundingTargetException: Boolean(row.funding_target_exception),
    fundingTargetExceptionReason: row.funding_target_exception_reason || null,
    durationDays: Number(row.duration_days),
    termDays: Number(row.duration_days),
    minimumExitDays: row.minimum_exit_days,
    fundingOpensAt: row.funding_opens_at,
    fundingClosesAt: row.funding_closes_at,
    projectStartsAt: row.project_starts_at,
    projectEndsAt: row.project_ends_at,
    riskDisclosure: row.risk_disclosure,
    termsText: row.terms_text,
    exitPolicy: row.exit_policy,
    changeRequestReason: row.change_request_reason,
    rejectionReason: row.rejection_reason,
    publishedTermsVersion: row.published_terms_version,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    pausedAt: row.paused_at,
    pausedBy: row.paused_by,
    fundingClosedAt: row.funding_closed_at,
    fundingClosedBy: row.funding_closed_by,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    archivedAt: row.archived_at,
    archivedBy: row.archived_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectedReturnDisclaimer:
      'Projected return — not guaranteed. Actual profit depends on project performance and approved accounts.',
    withdrawable: false,
    locationAddress: row.location_address || null,
    photoUrls: (() => {
      const raw = row.photo_urls;
      if (Array.isArray(raw)) return raw.filter((u) => typeof u === 'string' && u.trim());
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string' && u.trim()) : [];
        } catch {
          return [];
        }
      }
      return [];
    })(),
    photoDocumentIds: (() => {
      const raw = row.photo_document_ids;
      if (Array.isArray(raw)) return raw.map(String).filter(Boolean).slice(0, 10);
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(0, 10) : [];
        } catch {
          return [];
        }
      }
      return [];
    })(),
    detailsText: row.details_text || null,
    investmentYears: row.investment_years == null ? null : Number(row.investment_years),
    estimatedYearlyProfitBps:
      row.estimated_yearly_profit_bps == null ? null : Number(row.estimated_yearly_profit_bps),
    badLossSummary: row.bad_loss_summary || null,
    ownerExperience: row.owner_experience || null,
    educationalBackground: row.educational_background || null,
    fundingProgress: (() => {
      const sold = Number(row.active_units || 0) + Number(row.reserved_units || 0);
      const total = Number(row.total_units || 0) || 1;
      const ratio = Math.min(1, sold / total);
      const closesAt = row.funding_closes_at ? new Date(row.funding_closes_at) : null;
      const daysToClose =
        closesAt && !Number.isNaN(closesAt.getTime())
          ? Math.ceil((closesAt.getTime() - Date.now()) / 86_400_000)
          : null;
      return {
        unitsSold: sold,
        unitsTarget: Number(row.total_units || 0),
        unitsRemaining: Math.max(0, Number(row.total_units || 0) - sold),
        ratio,
        fundraisedPoisha: sold * Number(row.unit_investment_poisha || 0),
        fundingTargetPoisha: row.funding_target_poisha == null ? null : Number(row.funding_target_poisha),
        daysToOfferClose: daysToClose,
        almostFull: ratio >= 0.85,
        closingSoon: daysToClose != null && daysToClose >= 0 && daysToClose <= 14,
        hints: [
          ...(ratio >= 0.85 ? ['Almost full — few units remaining'] : []),
          ...(daysToClose != null && daysToClose >= 0 && daysToClose <= 14
            ? [`Closing soon — ~${daysToClose} day(s) to offer close`]
            : []),
        ],
      };
    })(),
  };
}

export function publicProjectView(project) {
  if (!project) return null;
  return {
    id: project.id,
    title: project.title,
    slug: project.slug,
    projectCode: project.projectCode,
    category: project.categoryName || project.category,
    categoryId: project.categoryId,
    categorySlug: project.categorySlug,
    summary: project.summary,
    status: project.status,
    versionNumber: project.versionNumber,
    businessName: project.businessName || null,
    ownerDisplayName: project.ownerDisplayName || null,
    totalUnits: project.totalUnits,
    availableUnits: project.availableUnits,
    activeUnits: project.activeUnits,
    reservedUnits: project.reservedUnits,
    unitPricePoisha: project.unitPricePoisha,
    unitInvestmentPoisha: project.unitInvestmentPoisha ?? project.unitPricePoisha,
    administrationFeeBps: project.administrationFeeBps,
    administrationFeePoishaPerUnit: project.administrationFeePoishaPerUnit,
    totalPayablePoishaPerUnit: project.totalPayablePoishaPerUnit,
    fundingTargetPoisha: project.fundingTargetPoisha,
    projectedReturnMinBps: project.projectedReturnMinBps,
    projectedReturnMaxBps: project.projectedReturnMaxBps,
    selectedRateBps: project.selectedRateBps,
    targetProfitBps: project.targetProfitBps,
    termDays: project.termDays,
    durationDays: project.durationDays,
    minimumExitDays: project.minimumExitDays,
    fundingOpensAt: project.fundingOpensAt,
    fundingClosesAt: project.fundingClosesAt,
    projectStartsAt: project.projectStartsAt,
    projectEndsAt: project.projectEndsAt,
    riskDisclosure: project.riskDisclosure,
    termsText: project.termsText,
    exitPolicy: project.exitPolicy,
    publishedTermsVersion: project.publishedTermsVersion,
    publishedAt: project.publishedAt,
    projectedReturnDisclaimer: project.projectedReturnDisclaimer,
    withdrawable: false,
    locationAddress: project.locationAddress || null,
    photoUrls: project.photoUrls || [],
    photoDocumentIds: project.photoDocumentIds || [],
    detailsText: project.detailsText || null,
    investmentYears: project.investmentYears ?? null,
    estimatedYearlyProfitBps: project.estimatedYearlyProfitBps ?? null,
    badLossSummary: project.badLossSummary || null,
    ownerExperience: project.ownerExperience || null,
    educationalBackground: project.educationalBackground || null,
    fundingProgress: project.fundingProgress || null,
  };
}
