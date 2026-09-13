import { createHash, randomUUID } from 'node:crypto';

import { calculateAmounts, calculateEstimatedProfit, DomainError, PAYMENT_METHODS } from './domain.js';
import { withTransaction } from './db.js';
import {
  PROJECT_WORKFLOW_STATUS,
  OWNER_EDITABLE_STATUSES,
  ADMIN_EDITABLE_STATUSES,
  REVIEW_QUEUE_STATUSES,
  PUBLIC_VISIBLE_STATUSES,
  INVESTOR_BROWSE_STATUSES,
  assertTransition,
  slugifyTitle,
  buildProjectCode,
  validateProjectPayload,
  mapProjectRow,
  publicProjectView,
  hasMaterialChange,
  materialSnapshot,
  feeBpsRange,
} from './project_workflow.js';
import {
  validateProfilePatch,
  validateBankUpsert,
  encryptBankSecrets,
  mapProfileRow,
  mapBankRowMasked,
  attachCompletion,
  bankAuditSnapshot,
  profileAuditSnapshot,
  KYC_STATUSES,
} from './investor_profile.js';
import {
  APPLICATION_WORKFLOW_STATUS,
  APPLICATION_REVIEW_QUEUE_STATUSES,
  APPLICATION_APPROVABLE_STATUSES,
  APPLICATION_REJECTABLE_STATUSES,
  APPLICATION_CHANGES_REQUESTABLE_STATUSES,
  APPLICATION_RESUBMITTABLE_STATUSES,
  APPLICATION_CANCELABLE_STATUSES,
  assertApplicationTransition,
  requireReason,
  previewInvestmentCalculation,
  mapApplicationDetail,
} from './application_workflow.js';
import {
  PROFIT_CONFIRMATION_STATUS,
  PROJECTION_DISCLAIMER,
  ESTIMATE_LABEL,
  dailyProjectedReturnPoisha,
  parseIsoDateOnly,
  assertPeriodOrder,
  requireConfirmedProfitPoisha,
  optionalNote,
  mapProfitConfirmation,
  buildProjectionPayload,
} from './profit_distributions.js';
import {
  EXIT_REQUEST_STATUS,
  OPEN_EXIT_STATUSES,
  CANCELABLE_EXIT_STATUSES,
  REVIEWABLE_EXIT_STATUSES,
  DECIDABLE_EXIT_STATUSES,
  COMPLETABLE_EXIT_STATUSES,
  LIQUIDITY_DISCLAIMER,
  assertExitEligibility,
  optionalExitNote,
  requireDecisionReason,
  optionalNonNegativePoisha,
  estimateExitPayablePoisha,
  mapExitRequest,
  mapExitPayment,
  buildExitEligibilityPayload,
} from './exit_requests.js';
import {
  DEFAULT_REFERRAL_REWARD_POISHA,
  REFERRAL_FUNDING_DISCLAIMER,
  REFERRAL_REWARD_STATUS,
  APPROVABLE_REWARD_STATUSES,
  REJECTABLE_REWARD_STATUSES,
  REVERSIBLE_REWARD_STATUSES,
  QUALIFYING_APPLICATION_STATUSES,
  normalizeReferralCode,
  generateReferralCode,
  requirePositiveRewardPoisha,
  optionalReferralNote,
  requireReferralReason,
  assertNotSelfReferral,
  mapReferral,
  mapReferralReward,
  mapReferralPayout,
  parseRewardPoishaSetting,
} from './referrals.js';

import {
  PERFORMANCE_REPORT_STATUS,
  REPORT_APPROVABLE_STATUSES,
  REPORT_REJECTABLE_STATUSES,
  REPORT_REVIEWABLE_STATUSES,
  AVAILABLE_PAYABLE_DISCLAIMER,
  DISTRIBUTION_RULE,
  AUDIT_ACTION_PREFIXES,
  requireNonNegativePoisha,
  computeActualProfitPoisha,
  requireRejectionReason,
  optionalSupportingDocumentKey,
  proRataByInvestmentPoisha,
  parseReportPeriod,
  mapPerformanceReport,
  mapAuditLog,
  normalizeAuditPrefixes,
  optionalNote as optionalReportNote,
} from './performance_reports.js';
import { attachFinalDemoMethods } from './final_demo_service.js';
import { attachProjectOwnerPackMethods, yearsToDurationDays } from './project_owner_pack.js';
import { attachSuperAdminPackMethods } from './super_admin_pack.js';
import { attachInvestorPackMethods, maskEmail, maskPhone } from './investor_pack.js';
import { attachDashboardAdminWorkflowMethods } from './dashboard_admin_workflow.js';
import { attachMobileFirstDashboard } from './mobile_first_dashboard.js';
import { attachLegalAgreementMethods } from './legal_agreements.js';

function mapProject(row) {
  return mapProjectRow(row);
}

const PROJECT_SELECT = `
  SELECT p.*,
         c.name AS category_name,
         c.slug AS category_slug,
         b.owner_user_id,
         b.legal_name AS business_legal_name,
         COALESCE(ou.email, b.legal_name) AS owner_display_name
  FROM projects p
  JOIN categories c ON c.id = p.category_id
  JOIN businesses b ON b.id = p.business_id
  LEFT JOIN users ou ON ou.id = b.owner_user_id
`;

function mapApplication(row, extras = {}) {
  return mapApplicationDetail(row, extras);
}

function mapPayment(row, extras = {}) {
  return {
    id: row.id,
    applicationId: row.application_id,
    method: row.method,
    status: row.status,
    amountPoisha: row.amount_poisha,
    reference: row.reference,
    evidenceStorageKey: row.evidence_storage_key,
    paidOn: row.paid_on,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    reviewNote: row.review_note,
    ...extras,
  };
}

function mapAllocation(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    applicationId: row.application_id,
    paymentId: row.payment_id,
    investorId: row.investor_id,
    units: row.units,
    investmentPoisha: row.investment_poisha,
    targetProfitBps: row.target_profit_bps,
    durationDays: row.duration_days,
    activatedAt: row.activated_at,
    maturityAt: row.maturity_at,
    status: row.status,
  };
}

async function audit(client, actorId, action, subjectType, subjectId, detail = {}, meta = {}) {
  const afterPayload = meta.after != null ? meta.after : detail;
  await client.query(
    `INSERT INTO audit_logs(actor_id, action, subject_type, subject_id, reason, before_json, after_json, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::inet, $9)`,
    [
      actorId,
      action,
      subjectType,
      subjectId,
      meta.reason ?? null,
      meta.before != null ? JSON.stringify(meta.before) : null,
      afterPayload != null ? JSON.stringify(afterPayload) : null,
      meta.ip || null,
      meta.userAgent || null,
    ],
  );
}


function mapCategory(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    iconUrl: row.icon_url,
    isActive: row.is_active,
    displayOrder: row.display_order,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function slugifyCategoryName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function assertCategoryName(name) {
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) {
    throw new DomainError('INVALID_CATEGORY_NAME', 'Category name must be 2–80 characters', 400);
  }
}

const MANUAL_PAYMENT_METHODS = Object.freeze(['cash', 'bank_transfer', 'bkash']);

function normalizeRequestContext(requestContext = {}) {
  return {
    ip: requestContext.ip || null,
    userAgent: requestContext.userAgent || requestContext.device || null,
  };
}

function parsePaidOn(paidOn) {
  if (!paidOn || typeof paidOn !== 'string') {
    throw new DomainError('PAYMENT_DATE_REQUIRED', 'A payment date (YYYY-MM-DD) is required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
    throw new DomainError('INVALID_PAYMENT_DATE', 'Payment date must be YYYY-MM-DD');
  }
  return paidOn;
}

function assertSafeInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new DomainError('INVALID_INTEGER', `${name} must be an integer of at least ${minimum}`);
  }
}

export class PostgresGrowBangladeshService {
  constructor(pool) {
    this.pool = pool;
  }

  async health() {
    const result = await this.pool.query('SELECT now() AS database_time');
    return { status: 'ok', database: 'connected', databaseTime: result.rows[0].database_time };
  }

  async listPublishedProjects({
    categorySlug = null,
    termMinDays = null,
    termMaxDays = null,
    unitPriceMinPoisha = null,
    unitPriceMaxPoisha = null,
    status = null,
  } = {}) {
    const params = [];
    let statuses = [...INVESTOR_BROWSE_STATUSES];
    if (status) {
      const requested = String(status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const allowed = requested.filter((s) => INVESTOR_BROWSE_STATUSES.has(s) || PUBLIC_VISIBLE_STATUSES.has(s));
      if (!allowed.length) {
        throw new DomainError('INVALID_STATUS_FILTER', 'status filter must be a marketplace-visible status', 400);
      }
      statuses = allowed;
    }
    let sql = `${PROJECT_SELECT}
       WHERE p.status = ANY($1::text[])`;
    params.push(statuses);
    if (categorySlug) {
      params.push(String(categorySlug).trim().toLowerCase());
      sql += ` AND c.slug = $${params.length}`;
    }
    if (termMinDays != null && termMinDays !== '') {
      params.push(Number(termMinDays));
      sql += ` AND p.duration_days >= $${params.length}`;
    }
    if (termMaxDays != null && termMaxDays !== '') {
      params.push(Number(termMaxDays));
      sql += ` AND p.duration_days <= $${params.length}`;
    }
    if (unitPriceMinPoisha != null && unitPriceMinPoisha !== '') {
      params.push(Number(unitPriceMinPoisha));
      sql += ` AND p.unit_investment_poisha >= $${params.length}`;
    }
    if (unitPriceMaxPoisha != null && unitPriceMaxPoisha !== '') {
      params.push(Number(unitPriceMaxPoisha));
      sql += ` AND p.unit_investment_poisha <= $${params.length}`;
    }
    sql += ' ORDER BY p.published_at DESC NULLS LAST, p.created_at DESC';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => publicProjectView(mapProject(row)));
  }

  async previewInvestmentForProject(projectId, units) {
    assertSafeInteger(units, 'units', 1);
    const result = await this.pool.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
    if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    const project = mapProject(result.rows[0]);
    if (!PUBLIC_VISIBLE_STATUSES.has(project.status)) {
      throw new DomainError('PROJECT_NOT_OPEN', 'Project is not visible on the marketplace', 409);
    }
    return {
      projectId: project.id,
      projectTitle: project.title,
      projectSlug: project.slug,
      projectStatus: project.status,
      publishedTermsVersion: project.publishedTermsVersion,
      projectVersionNumber: project.versionNumber,
      businessName: project.businessName,
      ...previewInvestmentCalculation({
        unitInvestmentPoisha: project.unitInvestmentPoisha,
        administrationFeeBps: project.administrationFeeBps,
        units,
        availableUnits: project.availableUnits,
        projectedReturnMinBps: project.projectedReturnMinBps,
        projectedReturnMaxBps: project.projectedReturnMaxBps,
        selectedRateBps: project.selectedRateBps,
        termDays: project.termDays,
      }),
    };
  }

  async getPublishedProjectBySlug(slug) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(slug || ''));
    const statuses = [...PUBLIC_VISIBLE_STATUSES];
    const result = isUuid
      ? await this.pool.query(
          `${PROJECT_SELECT}
           WHERE p.id = $1::uuid AND p.status = ANY($2::text[])
           LIMIT 1`,
          [slug, statuses],
        )
      : await this.pool.query(
          `${PROJECT_SELECT}
           WHERE p.slug = $1 AND p.status = ANY($2::text[])
           LIMIT 1`,
          [slug, statuses],
        );
    if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    return publicProjectView(mapProject(result.rows[0]));
  }

  async createProject(input, actorId, { asAdmin = false } = {}) {
    validateProjectPayload(input, 'draft');
    return withTransaction(this.pool, async (client) => {
      let businessId = input.businessId;
      if (!businessId) {
        const biz = await client.query(
          `SELECT id FROM businesses WHERE owner_user_id=$1 ORDER BY created_at ASC LIMIT 1`,
          [asAdmin && input.ownerUserId ? input.ownerUserId : actorId],
        );
        if (!biz.rowCount) {
          const ownerId = asAdmin && input.ownerUserId ? input.ownerUserId : actorId;
          const created = await client.query(
            `INSERT INTO businesses(owner_user_id, legal_name, verification_status)
             VALUES ($1, $2, 'pending')
             RETURNING id`,
            [ownerId, input.businessName || 'Owner business'],
          );
          businessId = created.rows[0].id;
        } else {
          businessId = biz.rows[0].id;
        }
      } else if (!asAdmin) {
        const biz = await client.query(
          `SELECT id FROM businesses WHERE id=$1 AND owner_user_id=$2`,
          [businessId, actorId],
        );
        if (!biz.rowCount) {
          throw new DomainError('BUSINESS_FORBIDDEN', 'You can only create projects for your own business', 403);
        }
      }

      const category = await this.#resolveActiveCategory(client, input);
      const title = String(input.title || 'Untitled draft').trim() || 'Untitled draft';
      const summary = String(input.summary || '').trim() || 'Draft — incomplete';
      const totalUnits = Number.isSafeInteger(input.totalUnits) ? input.totalUnits : 1;
      const unitInvestmentPoisha = Number.isSafeInteger(input.unitInvestmentPoisha)
        ? input.unitInvestmentPoisha
        : 100000;
      const administrationFeeBps = Number.isSafeInteger(input.administrationFeeBps)
        ? input.administrationFeeBps
        : 1000;
      const feeRange = feeBpsRange();
      if (administrationFeeBps < feeRange.min || administrationFeeBps > feeRange.max) {
        throw new DomainError(
          'FEE_OUT_OF_RANGE',
          `administrationFeeBps must be between ${feeRange.min} and ${feeRange.max}`,
          400,
        );
      }
      const selectedRateBps = Number.isSafeInteger(input.selectedRateBps)
        ? input.selectedRateBps
        : Number.isSafeInteger(input.targetProfitBps)
          ? input.targetProfitBps
          : 1500;
      const projectedMin = Number.isSafeInteger(input.projectedReturnMinBps)
        ? input.projectedReturnMinBps
        : Math.max(0, selectedRateBps - 500);
      const projectedMax = Number.isSafeInteger(input.projectedReturnMaxBps)
        ? input.projectedReturnMaxBps
        : selectedRateBps + 500;
      let durationDays = Number.isSafeInteger(input.durationDays) ? input.durationDays : null;
      let investmentYears = Number.isSafeInteger(input.investmentYears) ? input.investmentYears : null;
      if (investmentYears != null) {
        durationDays = yearsToDurationDays(investmentYears);
      } else if (durationDays == null) {
        durationDays = 365;
        investmentYears = 1;
      } else {
        investmentYears = Math.min(5, Math.max(1, Math.round(durationDays / 365)));
      }
      const estimatedYearlyProfitBps = Number.isSafeInteger(input.estimatedYearlyProfitBps)
        ? input.estimatedYearlyProfitBps
        : selectedRateBps;
      const photoUrls = Array.isArray(input.photoUrls)
        ? input.photoUrls.filter((u) => typeof u === 'string' && u.trim()).slice(0, 10)
        : [];
      const fundingTargetException = Boolean(input.fundingTargetException);
      const fundingTargetPoisha = Number.isSafeInteger(input.fundingTargetPoisha)
        ? input.fundingTargetPoisha
        : unitInvestmentPoisha * totalUnits;
      if (fundingTargetPoisha !== unitInvestmentPoisha * totalUnits && !fundingTargetException) {
        throw new DomainError(
          'FUNDING_TARGET_MISMATCH',
          'fundingTargetPoisha must equal unit price × total units unless an exception is recorded',
          400,
        );
      }

      const id = randomUUID();
      const slugBase = input.slug ? slugifyTitle(input.slug) : slugifyTitle(title);
      const slug = await this.#ensureUniqueSlug(client, `${slugBase}-${id.replace(/-/g, '').slice(0, 8)}`);
      const projectCode = input.projectCode || buildProjectCode(id);

      const result = await client.query(
        `INSERT INTO projects(
           id, business_id, title, category, category_id, summary, slug, project_code,
           total_units, unit_investment_poisha, administration_fee_bps, target_profit_bps,
           selected_rate_bps, projected_return_min_bps, projected_return_max_bps,
           funding_target_poisha, funding_target_exception, funding_target_exception_reason,
           duration_days, minimum_exit_days,
           funding_opens_at, funding_closes_at, project_starts_at, project_ends_at,
           risk_disclosure, terms_text, exit_policy, version_number, status,
           location_address, photo_urls, details_text, investment_years,
           estimated_yearly_profit_bps, bad_loss_summary, owner_experience, educational_background
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,
           $9,$10,$11,$12,
           $13,$14,$15,
           $16,$17,$18,
           $19,$20,
           $21,$22,$23,$24,
           $25,$26,$27,1,'draft',
           $28,$29::jsonb,$30,$31,
           $32,$33,$34,$35
         ) RETURNING *`,
        [
          id,
          businessId,
          title,
          category.name,
          category.id,
          summary,
          slug,
          projectCode,
          totalUnits,
          unitInvestmentPoisha,
          administrationFeeBps,
          selectedRateBps,
          selectedRateBps,
          projectedMin,
          projectedMax,
          fundingTargetPoisha,
          fundingTargetException,
          fundingTargetException ? String(input.fundingTargetExceptionReason || '').trim() : null,
          durationDays,
          input.minimumExitDays ?? 180,
          input.fundingOpensAt || null,
          input.fundingClosesAt || null,
          input.projectStartsAt || null,
          input.projectEndsAt || null,
          input.riskDisclosure || null,
          input.termsText || null,
          input.exitPolicy || null,
          input.locationAddress || null,
          JSON.stringify(photoUrls),
          input.detailsText || null,
          investmentYears,
          estimatedYearlyProfitBps,
          input.badLossSummary || null,
          input.ownerExperience || null,
          input.educationalBackground || null,
        ],
      );
      await client.query(
        `INSERT INTO project_review_fees(project_id, amount_poisha, status)
         VALUES (
           $1,
           COALESCE(
             (SELECT (value_json #>> '{}')::bigint FROM platform_settings WHERE key='project_review_fee_poisha' LIMIT 1),
             50000
           ),
           'unpaid'
         )
         ON CONFLICT (project_id) DO NOTHING`,
        [id],
      );
      const full = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [id]);
      const project = mapProject(full.rows[0]);
      await this.#insertVersionSnapshot(client, project, actorId, 'project.created');
      await audit(client, actorId, 'project.created', 'project', project.id, project);
      return project;
    });
  }

  async publishProject(projectId, actorId, terms = {}) {
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(`${PROJECT_SELECT} WHERE p.id=$1 FOR UPDATE OF p`, [projectId]);
      if (!locked.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
      const before = mapProject(locked.rows[0]);
      assertTransition(before.status, PROJECT_WORKFLOW_STATUS.PUBLISHED);
      validateProjectPayload(
        {
          ...before,
          riskDisclosure: terms.riskDisclosure || before.riskDisclosure,
          termsText: terms.termsText || before.termsText || terms.versionNote,
          exitPolicy: terms.exitPolicy || before.exitPolicy,
        },
        'publish',
      );

      const termsJson = JSON.stringify({
        ...(typeof terms === 'object' && terms ? terms : {}),
        unitInvestmentPoisha: before.unitInvestmentPoisha,
        administrationFeeBps: before.administrationFeeBps,
        totalUnits: before.totalUnits,
        fundingTargetPoisha: before.fundingTargetPoisha,
        selectedRateBps: before.selectedRateBps,
        projectedReturnMinBps: before.projectedReturnMinBps,
        projectedReturnMaxBps: before.projectedReturnMaxBps,
        durationDays: before.durationDays,
        riskDisclosure: terms.riskDisclosure || before.riskDisclosure,
        termsText: terms.termsText || before.termsText,
        exitPolicy: terms.exitPolicy || before.exitPolicy,
        versionNumber: before.versionNumber,
      });
      const contentHash = createHash('sha256').update(termsJson).digest('hex');
      const versionResult = await client.query(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM project_terms WHERE project_id=$1',
        [projectId],
      );
      const version = versionResult.rows[0].version;
      await client.query(
        `INSERT INTO project_terms(project_id, version, terms_json, content_hash, approved_by)
         VALUES ($1,$2,$3::jsonb,$4,$5)`,
        [projectId, version, termsJson, contentHash, actorId],
      );
      await client.query(
        `UPDATE projects
         SET status='published',
             published_terms_version=$2,
             published_at=now(),
             published_by=$3,
             risk_disclosure=COALESCE($4, risk_disclosure),
             terms_text=COALESCE($5, terms_text),
             exit_policy=COALESCE($6, exit_policy),
             funding_opens_at=COALESCE(funding_opens_at, now()),
             funding_closes_at=COALESCE(funding_closes_at, now() + (duration_days || ' days')::interval),
             project_starts_at=COALESCE(project_starts_at, now()),
             project_ends_at=COALESCE(project_ends_at, now() + (duration_days || ' days')::interval),
             updated_at=now()
         WHERE id=$1`,
        [
          projectId,
          version,
          actorId,
          terms.riskDisclosure || before.riskDisclosure,
          terms.termsText || before.termsText,
          terms.exitPolicy || before.exitPolicy,
        ],
      );
      const updated = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
      const project = mapProject(updated.rows[0]);
      await audit(client, actorId, 'project.published', 'project', projectId, project, {
        before,
        after: project,
      });
      return project;
    });
  }

  async applyForUnits({ projectId, investorId, units, acceptedTermsVersion, agreementVersion, deviceMeta, requestContext }, actorId = investorId) {
    assertSafeInteger(units, 'units', 1);
    const ctx = normalizeRequestContext(requestContext || {});
    return withTransaction(this.pool, async (client) => {
      const projectResult = await client.query('SELECT * FROM projects WHERE id=$1 FOR SHARE', [projectId]);
      if (!projectResult.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
      const project = projectResult.rows[0];
      if (project.status !== 'published') throw new DomainError('PROJECT_NOT_OPEN', 'Project is not accepting applications', 409);
      const ownBiz = await client.query(
        `SELECT 1 FROM businesses WHERE id=$1 AND owner_user_id=$2`,
        [project.business_id, investorId],
      );
      if (ownBiz.rowCount) {
        throw new DomainError(
          'CANNOT_INVEST_OWN_PROJECT',
          'Project owners cannot invest in their own projects — browse others via Invest opportunities',
          403,
        );
      }
      if (acceptedTermsVersion !== project.published_terms_version) {
        throw new DomainError('TERMS_VERSION_MISMATCH', 'The project terms have changed; review the current version', 409);
      }
      const available = project.total_units - project.active_units - project.reserved_units;
      if (units > available) throw new DomainError('INSUFFICIENT_UNITS', `Only ${available} units are available`, 409);
      const amounts = calculateAmounts({
        unitInvestmentPoisha: project.unit_investment_poisha,
        administrationFeeBps: project.administration_fee_bps,
        units,
      });
      const result = await client.query(
        `INSERT INTO investment_applications(
           project_id, investor_id, units, unit_investment_poisha,
           investment_poisha, administration_fee_poisha, total_payable_poisha,
           terms_version, project_version_number, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted') RETURNING *`,
        [
          projectId,
          investorId,
          units,
          project.unit_investment_poisha,
          amounts.investmentPoisha,
          amounts.administrationFeePoisha,
          amounts.totalPayablePoisha,
          project.published_terms_version,
          project.version_number || 1,
        ],
      );
      const application = mapApplication(result.rows[0]);
      const snap = {
        agreementVersion: agreementVersion || `terms-v${project.published_terms_version}`,
        termsVersion: project.published_terms_version,
        acceptedAt: new Date().toISOString(),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        deviceMeta: deviceMeta || null,
        fictionalBanner: 'FICTIONAL DEMO — NOT A REAL DOCUMENT',
      };
      await client.query(
        `INSERT INTO agreement_acceptances(
           application_id, investor_id, project_id, terms_version,
           accepted_from_ip, accepted_user_agent, agreement_version, device_meta, snapshot_json
         ) VALUES ($1,$2,$3,$4,$5::inet,$6,$7,$8::jsonb,$9::jsonb)`,
        [
          application.id, investorId, projectId, project.published_terms_version,
          ctx.ip, ctx.userAgent, snap.agreementVersion,
          JSON.stringify(deviceMeta || { userAgent: ctx.userAgent }),
          JSON.stringify(snap),
        ],
      );
      await audit(client, actorId, 'application.submitted', 'application', application.id, { projectId, units, agreementVersion: snap.agreementVersion }, {
        ip: ctx.ip, userAgent: ctx.userAgent,
      });
      return application;
    });
  }

  async approveApplication(applicationId, actorId) {
    return withTransaction(this.pool, async (client) => {
      const applicationResult = await client.query(
        'SELECT * FROM investment_applications WHERE id=$1 FOR UPDATE',
        [applicationId],
      );
      if (!applicationResult.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      const application = applicationResult.rows[0];
      if (!APPLICATION_APPROVABLE_STATUSES.includes(application.status)) {
        throw new DomainError('APPLICATION_NOT_APPROVABLE', 'Application is not awaiting approval', 409);
      }
      assertApplicationTransition(application.status, APPLICATION_WORKFLOW_STATUS.APPROVED_PAYMENT_PENDING);
      const projectResult = await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE', [application.project_id]);
      const project = projectResult.rows[0];
      if (project.status !== 'published' && project.status !== 'active' && project.status !== 'paused') {
        throw new DomainError('PROJECT_NOT_OPEN', 'Project is not accepting applications', 409);
      }
      const available = project.total_units - project.active_units - project.reserved_units;
      if (application.units > available) throw new DomainError('INSUFFICIENT_UNITS', `Only ${available} units are available`, 409);
      await client.query(
        `UPDATE projects SET reserved_units=reserved_units+$2, updated_at=now() WHERE id=$1`,
        [project.id, application.units],
      );
      const updated = await client.query(
        `UPDATE investment_applications
         SET status='approved_payment_pending', approved_by=$2, approved_at=now(),
             decided_by=$2, decided_at=now(), rejection_reason=NULL, changes_requested_reason=NULL
         WHERE id=$1 RETURNING *`,
        [applicationId, actorId],
      );
      await audit(client, actorId, 'application.approved', 'application', applicationId, {
        reservedUnits: application.units,
        fromStatus: application.status,
      });
      return mapApplication(updated.rows[0]);
    });
  }

  async startApplicationReview(applicationId, actorId) {
    return withTransaction(this.pool, async (client) => {
      const applicationResult = await client.query(
        'SELECT * FROM investment_applications WHERE id=$1 FOR UPDATE',
        [applicationId],
      );
      if (!applicationResult.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      const application = applicationResult.rows[0];
      if (application.status === APPLICATION_WORKFLOW_STATUS.UNDER_REVIEW) {
        return mapApplication(application);
      }
      assertApplicationTransition(application.status, APPLICATION_WORKFLOW_STATUS.UNDER_REVIEW);
      const updated = await client.query(
        `UPDATE investment_applications
         SET status='under_review', under_review_at=now(), under_review_by=$2
         WHERE id=$1 RETURNING *`,
        [applicationId, actorId],
      );
      await audit(client, actorId, 'application.under_review', 'application', applicationId, {
        fromStatus: application.status,
      });
      return mapApplication(updated.rows[0]);
    });
  }

  async rejectApplication(applicationId, actorId, reason) {
    const rejectionReason = requireReason(reason, 'reason');
    return withTransaction(this.pool, async (client) => {
      const applicationResult = await client.query(
        'SELECT * FROM investment_applications WHERE id=$1 FOR UPDATE',
        [applicationId],
      );
      if (!applicationResult.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      const application = applicationResult.rows[0];
      if (!APPLICATION_REJECTABLE_STATUSES.includes(application.status)) {
        throw new DomainError('APPLICATION_NOT_REJECTABLE', 'Application cannot be rejected in its current status', 409);
      }
      assertApplicationTransition(application.status, APPLICATION_WORKFLOW_STATUS.REJECTED);
      const updated = await client.query(
        `UPDATE investment_applications
         SET status='rejected', rejection_reason=$2, decided_by=$3, decided_at=now()
         WHERE id=$1 RETURNING *`,
        [applicationId, rejectionReason, actorId],
      );
      await audit(
        client,
        actorId,
        'application.rejected',
        'application',
        applicationId,
        { fromStatus: application.status },
        { reason: rejectionReason },
      );
      return mapApplication(updated.rows[0]);
    });
  }

  async requestApplicationChanges(applicationId, actorId, reason) {
    const changesReason = requireReason(reason, 'reason');
    return withTransaction(this.pool, async (client) => {
      const applicationResult = await client.query(
        'SELECT * FROM investment_applications WHERE id=$1 FOR UPDATE',
        [applicationId],
      );
      if (!applicationResult.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      const application = applicationResult.rows[0];
      if (!APPLICATION_CHANGES_REQUESTABLE_STATUSES.includes(application.status)) {
        throw new DomainError('APPLICATION_NOT_EDITABLE', 'Application cannot request changes in its current status', 409);
      }
      assertApplicationTransition(application.status, APPLICATION_WORKFLOW_STATUS.CHANGES_REQUESTED);
      const updated = await client.query(
        `UPDATE investment_applications
         SET status='changes_requested', changes_requested_reason=$2, decided_by=$3, decided_at=now()
         WHERE id=$1 RETURNING *`,
        [applicationId, changesReason, actorId],
      );
      await audit(
        client,
        actorId,
        'application.changes_requested',
        'application',
        applicationId,
        { fromStatus: application.status },
        { reason: changesReason },
      );
      return mapApplication(updated.rows[0]);
    });
  }

  async resubmitApplication(applicationId, investorId, { units } = {}) {
    return withTransaction(this.pool, async (client) => {
      const applicationResult = await client.query(
        'SELECT * FROM investment_applications WHERE id=$1 FOR UPDATE',
        [applicationId],
      );
      if (!applicationResult.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      const application = applicationResult.rows[0];
      if (application.investor_id !== investorId) {
        throw new DomainError('FORBIDDEN', 'You can only resubmit your own applications', 403);
      }
      if (!APPLICATION_RESUBMITTABLE_STATUSES.includes(application.status)) {
        throw new DomainError('APPLICATION_NOT_RESUBMITTABLE', 'Application is not awaiting resubmission', 409);
      }
      assertApplicationTransition(application.status, APPLICATION_WORKFLOW_STATUS.SUBMITTED);
      const projectResult = await client.query('SELECT * FROM projects WHERE id=$1 FOR SHARE', [application.project_id]);
      if (!projectResult.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
      const project = projectResult.rows[0];
      if (project.status !== 'published') {
        throw new DomainError('PROJECT_NOT_OPEN', 'Project is not accepting applications', 409);
      }
      let nextUnits = application.units;
      let amounts = {
        investmentPoisha: Number(application.investment_poisha),
        administrationFeePoisha: Number(application.administration_fee_poisha),
        totalPayablePoisha: Number(application.total_payable_poisha),
      };
      if (units != null) {
        assertSafeInteger(units, 'units', 1);
        const available = project.total_units - project.active_units - project.reserved_units;
        if (units > available) throw new DomainError('INSUFFICIENT_UNITS', `Only ${available} units are available`, 409);
        nextUnits = units;
        amounts = calculateAmounts({
          unitInvestmentPoisha: project.unit_investment_poisha,
          administrationFeeBps: project.administration_fee_bps,
          units,
        });
      }
      const updated = await client.query(
        `UPDATE investment_applications
         SET status='submitted',
             units=$2,
             unit_investment_poisha=$3,
             investment_poisha=$4,
             administration_fee_poisha=$5,
             total_payable_poisha=$6,
             terms_version=$7,
             project_version_number=$8,
             changes_requested_reason=NULL,
             resubmitted_at=now()
         WHERE id=$1 RETURNING *`,
        [
          applicationId,
          nextUnits,
          project.unit_investment_poisha,
          amounts.investmentPoisha,
          amounts.administrationFeePoisha,
          amounts.totalPayablePoisha,
          project.published_terms_version,
          project.version_number || 1,
        ],
      );
      await audit(client, investorId, 'application.resubmitted', 'application', applicationId, {
        units: nextUnits,
      });
      return mapApplication(updated.rows[0]);
    });
  }

  async cancelApplication(applicationId, investorId) {
    return withTransaction(this.pool, async (client) => {
      const applicationResult = await client.query(
        'SELECT * FROM investment_applications WHERE id=$1 FOR UPDATE',
        [applicationId],
      );
      if (!applicationResult.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      const application = applicationResult.rows[0];
      if (application.investor_id !== investorId) {
        throw new DomainError('FORBIDDEN', 'You can only cancel your own applications', 403);
      }
      if (!APPLICATION_CANCELABLE_STATUSES.includes(application.status)) {
        throw new DomainError('APPLICATION_NOT_CANCELABLE', 'Application cannot be cancelled in its current status', 409);
      }
      assertApplicationTransition(application.status, APPLICATION_WORKFLOW_STATUS.CANCELLED);
      const updated = await client.query(
        `UPDATE investment_applications
         SET status='cancelled', cancelled_at=now(), cancelled_by=$2
         WHERE id=$1 RETURNING *`,
        [applicationId, investorId],
      );
      await audit(client, investorId, 'application.cancelled', 'application', applicationId, {
        fromStatus: application.status,
      });
      return mapApplication(updated.rows[0]);
    });
  }

  async submitPayment(
    {
      applicationId,
      method,
      reference,
      amountPoisha,
      evidenceStorageKey,
      idempotencyKey,
      paidOn,
      branch,
      requestContext,
    },
    actorId,
  ) {
    if (!PAYMENT_METHODS.includes(method)) throw new DomainError('INVALID_PAYMENT_METHOD', 'Unsupported payment method');
    if (method === 'sslcommerz') {
      throw new DomainError(
        'GATEWAY_NOT_AVAILABLE',
        'SSLCommerz gateway is not configured; use manual cash, bank_transfer, or bKash',
        501,
      );
    }
    if (!MANUAL_PAYMENT_METHODS.includes(method)) {
      throw new DomainError('INVALID_PAYMENT_METHOD', 'Unsupported manual payment method');
    }
    assertSafeInteger(amountPoisha, 'amountPoisha', 1);
    if (!idempotencyKey || idempotencyKey.length < 16) {
      throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'A unique idempotency key is required');
    }
    const paidOnDate = parsePaidOn(paidOn);
    const ctx = normalizeRequestContext(requestContext);
    if ((method === 'bank_transfer' || method === 'bkash') && !evidenceStorageKey) {
      throw new DomainError(
        'EVIDENCE_REQUIRED',
        'Supporting evidence (evidenceStorageKey) is required for bank transfer and bKash payments',
      );
    }
    if ((method === 'bank_transfer' || method === 'bkash') && (!reference || !String(reference).trim())) {
      throw new DomainError('REFERENCE_REQUIRED', 'A unique transaction/reference is required');
    }

    return withTransaction(this.pool, async (client) => {
      const existing = await client.query('SELECT * FROM payments WHERE idempotency_key=$1', [idempotencyKey]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        let receiptNumber = null;
        if (row.method === 'cash') {
          const receipt = await client.query('SELECT receipt_number FROM cash_receipts WHERE payment_id=$1', [row.id]);
          receiptNumber = receipt.rows[0]?.receipt_number ?? null;
        }
        return mapPayment(row, { receiptNumber });
      }
      const applicationResult = await client.query(
        'SELECT * FROM investment_applications WHERE id=$1 FOR UPDATE',
        [applicationId],
      );
      if (!applicationResult.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
      const application = applicationResult.rows[0];
      if (application.status !== 'approved_payment_pending') {
        throw new DomainError('APPLICATION_NOT_PAYABLE', 'Application is not ready for payment', 409);
      }
      if (amountPoisha !== application.total_payable_poisha) {
        throw new DomainError('PAYMENT_AMOUNT_MISMATCH', 'Payment must match the approved total payable', 409);
      }
      if (typeof this.assertPurchaseAgreementAccepted === 'function') {
        await this.assertPurchaseAgreementAccepted(applicationId, application.investor_id);
      }

      const paymentReference =
        method === 'cash' && (!reference || !String(reference).trim())
          ? `CASH-${randomUUID()}`
          : String(reference).trim();

      try {
        const paymentResult = await client.query(
          `INSERT INTO payments(
             application_id, method, amount_poisha, reference, evidence_storage_key,
             submitted_by, idempotency_key, paid_on, submission_context
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
          [
            applicationId,
            method,
            amountPoisha,
            paymentReference,
            evidenceStorageKey ?? null,
            actorId,
            idempotencyKey,
            paidOnDate,
            JSON.stringify(ctx),
          ],
        );
        await client.query(
          `UPDATE investment_applications SET status='payment_verification_pending' WHERE id=$1`,
          [applicationId],
        );

        let receiptNumber = null;
        if (method === 'cash') {
          const receipt = await client.query(
            `INSERT INTO cash_receipts(payment_id, branch, received_by)
             VALUES ($1,$2,$3)
             RETURNING receipt_number`,
            [paymentResult.rows[0].id, (branch && String(branch).trim()) || 'HQ', actorId],
          );
          receiptNumber = receipt.rows[0].receipt_number;
          await client.query(`UPDATE payments SET reference=$2 WHERE id=$1`, [
            paymentResult.rows[0].id,
            `CASH-${receiptNumber}`,
          ]);
          paymentResult.rows[0].reference = `CASH-${receiptNumber}`;
        }

        const payment = mapPayment(paymentResult.rows[0], { receiptNumber });
        await audit(
          client,
          actorId,
          'payment.submitted',
          'payment',
          payment.id,
          { applicationId, method, amountPoisha, paidOn: paidOnDate, receiptNumber, reference: payment.reference },
          { ip: ctx.ip, userAgent: ctx.userAgent, after: payment },
        );
        return payment;
      } catch (error) {
        if (error.code === '23505') {
          throw new DomainError('DUPLICATE_PAYMENT_REFERENCE', 'Payment reference has already been used', 409);
        }
        throw error;
      }
    });
  }

  async verifyPayment(paymentId, actorId, reviewNote, options = {}) {
    if (!reviewNote || reviewNote.trim().length < 3) {
      throw new DomainError('REVIEW_NOTE_REQUIRED', 'A finance review note is required');
    }
    const {
      requestContext,
      actorRoles = [],
      overrideMakerChecker = false,
      overrideReason = '',
    } = options;
    const ctx = normalizeRequestContext(requestContext);

    return withTransaction(this.pool, async (client) => {
      const paymentResult = await client.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId]);
      if (!paymentResult.rowCount) throw new DomainError('PAYMENT_NOT_FOUND', 'Payment was not found', 404);
      const payment = paymentResult.rows[0];
      if (payment.status === 'verified') {
        const existingAllocation = await client.query('SELECT * FROM allocations WHERE payment_id=$1', [paymentId]);
        const allocation = existingAllocation.rowCount ? mapAllocation(existingAllocation.rows[0]) : null;
        let agreementRow = null;
        if (allocation) {
          const agr = await client.query('SELECT * FROM investment_agreements WHERE allocation_id=$1', [allocation.id]);
          agreementRow = agr.rows[0] || null;
        }
        return {
          payment: mapPayment(payment),
          allocation,
          allocationId: allocation?.id ?? null,
          alreadyVerified: true,
          agreement: agreementRow
            ? {
                id: agreementRow.id,
                agreementNumber: agreementRow.agreement_number,
                pdfDocumentId: agreementRow.pdf_document_id,
                emailDeliveryStatus: agreementRow.email_delivery_status,
                fictionalBanner: agreementRow.fictional_banner,
              }
            : null,
        };
      }
      if (payment.status !== 'verification_pending') {
        throw new DomainError('PAYMENT_NOT_VERIFIABLE', 'Payment is not awaiting verification', 409);
      }

      const sameMaker = payment.submitted_by === actorId;
      const isSuperAdmin = Array.isArray(actorRoles) && actorRoles.includes('super_admin');
      const canOverride =
        isSuperAdmin && overrideMakerChecker && typeof overrideReason === 'string' && overrideReason.trim().length >= 3;
      if (sameMaker && !canOverride) {
        throw new DomainError(
          'MAKER_CHECKER_VIOLATION',
          'The same staff account cannot submit and verify a payment',
          403,
        );
      }

      const applicationResult = await client.query(
        'SELECT * FROM investment_applications WHERE id=$1 FOR UPDATE',
        [payment.application_id],
      );
      const application = applicationResult.rows[0];
      if (application.status !== 'payment_verification_pending') {
        throw new DomainError('APPLICATION_STATE_CONFLICT', 'Application is not awaiting payment verification', 409);
      }
      if (Number(payment.amount_poisha) !== Number(application.total_payable_poisha)) {
        throw new DomainError('PAYMENT_AMOUNT_MISMATCH', 'Payment must match the approved total payable', 409);
      }
      const projectResult = await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE', [application.project_id]);
      const project = projectResult.rows[0];
      if (project.reserved_units < application.units || project.active_units + application.units > project.total_units) {
        throw new DomainError('RESERVATION_CONFLICT', 'Reserved unit inventory is inconsistent', 409);
      }

      const beforeState = {
        payment: mapPayment(payment),
        application: mapApplication(application),
        project: {
          id: project.id,
          reservedUnits: project.reserved_units,
          activeUnits: project.active_units,
          totalUnits: project.total_units,
        },
      };

      if (sameMaker && canOverride) {
        await audit(
          client,
          actorId,
          'maker_checker.override',
          'payment',
          payment.id,
          {
            submittedBy: payment.submitted_by,
            verifiedBy: actorId,
            reviewNote: reviewNote.trim(),
          },
          { reason: overrideReason.trim(), before: beforeState, ip: ctx.ip, userAgent: ctx.userAgent },
        );
      }

      const activatedAt = new Date();
      const maturityAt = new Date(activatedAt.getTime() + project.duration_days * 86_400_000);
      const allocationResult = await client.query(
        `INSERT INTO allocations(
           project_id, application_id, payment_id, investor_id, units,
           investment_poisha, target_profit_bps, duration_days, activated_at, maturity_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          project.id,
          application.id,
          payment.id,
          application.investor_id,
          application.units,
          application.investment_poisha,
          project.target_profit_bps,
          project.duration_days,
          activatedAt,
          maturityAt,
        ],
      );
      await client.query(
        `UPDATE projects
         SET reserved_units=reserved_units-$2, active_units=active_units+$2, updated_at=now()
         WHERE id=$1`,
        [project.id, application.units],
      );
      await client.query(
        `UPDATE investment_applications SET status='active', activated_at=$2 WHERE id=$1`,
        [application.id, activatedAt],
      );
      const verifiedPayment = await client.query(
        `UPDATE payments
         SET status='verified', verified_by=$2, verified_at=now(), review_note=$3, verification_context=$4::jsonb
         WHERE id=$1 RETURNING *`,
        [payment.id, actorId, reviewNote.trim(), JSON.stringify(ctx)],
      );
      const allocation = mapAllocation(allocationResult.rows[0]);
      const afterState = {
        payment: mapPayment(verifiedPayment.rows[0]),
        allocation,
        applicationStatus: 'active',
        projectUnits: {
          reservedDelta: -application.units,
          activeDelta: application.units,
        },
      };
      await audit(
        client,
        actorId,
        'payment.verified',
        'payment',
        payment.id,
        { allocationId: allocation.id, makerCheckerOverride: Boolean(sameMaker && canOverride) },
        { before: beforeState, after: afterState, ip: ctx.ip, userAgent: ctx.userAgent, reason: reviewNote.trim() },
      );
      await audit(
        client,
        actorId,
        'allocation.activated',
        'allocation',
        allocation.id,
        { units: allocation.units },
        { ip: ctx.ip, userAgent: ctx.userAgent },
      );
      // Phase 7: mark referral reward eligible when referred investor allocation activates
      await this.#maybeMarkReferralEligible(client, {
        investorId: application.investor_id,
        applicationId: application.id,
        actorId,
        requestContext: ctx,
      });
      // Final demo K/L: finalize agreement in same TX (rollback-safe with allocation)
      let agreement = null;
      if (typeof this.createFinalAgreementForAllocation === 'function') {
        agreement = await this.createFinalAgreementForAllocation(client, {
          application,
          allocation: allocationResult.rows[0],
          project,
          investorId: application.investor_id,
          actorId,
          requestContext: ctx,
        });
      }
      return {
        payment: mapPayment(verifiedPayment.rows[0]),
        allocation,
        allocationId: allocation.id,
        alreadyVerified: false,
        agreement: agreement
          ? {
              id: agreement.id,
              agreementNumber: agreement.agreement_number,
              pdfDocumentId: agreement.pdf_document_id,
              emailDeliveryStatus: agreement.email_delivery_status,
              fictionalBanner: agreement.fictional_banner,
            }
          : null,
      };
    });
  }

  async rejectPayment(paymentId, actorId, reviewNote, options = {}) {
    if (!reviewNote || reviewNote.trim().length < 3) {
      throw new DomainError('REVIEW_NOTE_REQUIRED', 'A finance review note is required');
    }
    const { requestContext, actorRoles = [] } = options;
    const ctx = normalizeRequestContext(requestContext);
    return withTransaction(this.pool, async (client) => {
      const paymentResult = await client.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId]);
      if (!paymentResult.rowCount) throw new DomainError('PAYMENT_NOT_FOUND', 'Payment was not found', 404);
      const payment = paymentResult.rows[0];
      if (payment.status !== 'verification_pending') {
        throw new DomainError('PAYMENT_NOT_REJECTABLE', 'Payment is not awaiting verification', 409);
      }
      const applicationResult = await client.query(
        'SELECT * FROM investment_applications WHERE id=$1 FOR UPDATE',
        [payment.application_id],
      );
      const application = applicationResult.rows[0];
      const projectResult = await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE', [application.project_id]);
      const project = projectResult.rows[0];
      const beforeState = {
        payment: mapPayment(payment),
        application: mapApplication(application),
        reservedUnits: project.reserved_units,
      };
      const rejected = await client.query(
        `UPDATE payments
         SET status='rejected', verified_by=$2, verified_at=now(), review_note=$3, verification_context=$4::jsonb
         WHERE id=$1 RETURNING *`,
        [payment.id, actorId, reviewNote.trim(), JSON.stringify(ctx)],
      );
      await client.query(
        `UPDATE investment_applications SET status='payment_rejected' WHERE id=$1`,
        [application.id],
      );
      if (project.reserved_units >= application.units) {
        await client.query(
          `UPDATE projects SET reserved_units=reserved_units-$2, updated_at=now() WHERE id=$1`,
          [project.id, application.units],
        );
      }
      await audit(
        client,
        actorId,
        'payment.rejected',
        'payment',
        payment.id,
        { applicationId: application.id, actorRoles },
        { before: beforeState, after: mapPayment(rejected.rows[0]), ip: ctx.ip, userAgent: ctx.userAgent, reason: reviewNote.trim() },
      );
      return { payment: mapPayment(rejected.rows[0]), alreadyVerified: false };
    });
  }

  async listInvestments({ actorId, canViewAny = false, investorId = null, projectId = null } = {}) {
    const params = [];
    const where = [];
    if (!canViewAny) {
      params.push(actorId);
      where.push(`a.investor_id=$${params.length}`);
    } else if (investorId) {
      params.push(investorId);
      where.push(`a.investor_id=$${params.length}`);
    }
    if (projectId) {
      params.push(projectId);
      where.push(`a.project_id=$${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT a.*,
              p.title AS project_title,
              p.published_at AS project_published_at,
              pay.method AS payment_method,
              pay.reference AS payment_reference,
              pay.amount_poisha AS total_paid_poisha,
              pay.verified_at AS payment_verified_at,
              app.administration_fee_poisha,
              app.total_payable_poisha,
              COALESCE((SELECT SUM(confirmed_profit_poisha)::bigint FROM profit_confirmations pc WHERE pc.allocation_id=a.id AND COALESCE(pc.status,'approved')='approved'),0)::bigint AS confirmed_profit_poisha
       FROM allocations a
       JOIN projects p ON p.id=a.project_id
       JOIN payments pay ON pay.id=a.payment_id
       JOIN investment_applications app ON app.id=a.application_id
       ${whereSql}
       ORDER BY a.activated_at DESC`,
      params,
    );
    return result.rows.map((row) => this.#mapInvestmentDetail(row));
  }

  async listOwnerProjects(ownerUserId) {
    const result = await this.pool.query(
      `${PROJECT_SELECT}
       WHERE b.owner_user_id=$1
       ORDER BY p.created_at DESC`,
      [ownerUserId],
    );
    return result.rows.map(mapProject);
  }

  async listAdminPayments({ status = 'verification_pending' } = {}) {
    const allowed = new Set(['verification_pending', 'verified', 'rejected']);
    if (!allowed.has(status)) {
      throw new DomainError('INVALID_PAYMENT_STATUS', 'Unsupported payment status filter');
    }
    const result = await this.pool.query(
      `SELECT pay.*,
              app.units,
              app.investor_id,
              app.investment_poisha,
              app.administration_fee_poisha,
              app.total_payable_poisha,
              app.status AS application_status,
              u.email AS investor_email,
              COALESCE(ip.full_name, u.email) AS investor_name,
              p.id AS project_id,
              p.title AS project_title,
              p.active_units AS project_active_units,
              p.reserved_units AS project_reserved_units,
              p.total_units AS project_total_units,
              a.id AS allocation_id
       FROM payments pay
       JOIN investment_applications app ON app.id=pay.application_id
       JOIN users u ON u.id=app.investor_id
       LEFT JOIN investor_profiles ip ON ip.user_id=u.id
       JOIN projects p ON p.id=app.project_id
       LEFT JOIN allocations a ON a.payment_id=pay.id
       WHERE pay.status=$1
       ORDER BY pay.submitted_at ASC`,
      [status],
    );
    return result.rows.map((row) => ({
      ...mapPayment(row),
      units: row.units,
      investorId: row.investor_id,
      investorEmail: row.investor_email,
      investorName: row.investor_name,
      investmentPoisha: Number(row.investment_poisha),
      administrationFeePoisha: Number(row.administration_fee_poisha),
      totalPayablePoisha: Number(row.total_payable_poisha),
      applicationStatus: row.application_status,
      projectId: row.project_id,
      projectTitle: row.project_title,
      projectActiveUnits: row.project_active_units,
      projectReservedUnits: row.project_reserved_units,
      projectTotalUnits: row.project_total_units,
      allocationId: row.allocation_id,
    }));
  }

  async listAdminApplications({ status = null, reviewQueue = false } = {}) {
    const params = [];
    let sql = `SELECT app.*,
              u.email AS investor_email,
              COALESCE(ip.full_name, u.email) AS investor_name,
              p.title AS project_title,
              p.slug AS project_slug,
              p.status AS project_status
       FROM investment_applications app
       JOIN users u ON u.id=app.investor_id
       LEFT JOIN investor_profiles ip ON ip.user_id=u.id
       JOIN projects p ON p.id=app.project_id
       WHERE 1=1`;
    if (status) {
      params.push(String(status));
      sql += ` AND app.status=$${params.length}`;
    } else {
      params.push([...APPLICATION_REVIEW_QUEUE_STATUSES]);
      sql += ` AND app.status = ANY($${params.length}::text[])`;
    }
    sql += ' ORDER BY app.created_at ASC';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      ...mapApplication(row),
      investorEmail: row.investor_email,
      investorName: row.investor_name,
      projectTitle: row.project_title,
      projectSlug: row.project_slug,
      projectStatus: row.project_status,
    }));
  }

  async getAdminApplication(applicationId) {
    const result = await this.pool.query(
      `SELECT app.*,
              u.email AS investor_email,
              COALESCE(ip.full_name, u.email) AS investor_name,
              p.title AS project_title,
              p.slug AS project_slug,
              p.status AS project_status,
              p.unit_investment_poisha AS project_unit_investment_poisha,
              p.administration_fee_bps AS project_administration_fee_bps
       FROM investment_applications app
       JOIN users u ON u.id=app.investor_id
       LEFT JOIN investor_profiles ip ON ip.user_id=u.id
       JOIN projects p ON p.id=app.project_id
       WHERE app.id=$1`,
      [applicationId],
    );
    if (!result.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    const row = result.rows[0];
    return {
      ...mapApplication(row),
      investorEmail: row.investor_email,
      investorName: row.investor_name,
      projectTitle: row.project_title,
      projectSlug: row.project_slug,
      projectStatus: row.project_status,
    };
  }

  async listMyApplications(investorId, { status = null } = {}) {
    const params = [investorId];
    let sql = `SELECT app.*, p.title AS project_title, p.slug AS project_slug, p.status AS project_status,
              b.legal_name AS business_name
       FROM investment_applications app
       JOIN projects p ON p.id=app.project_id
       JOIN businesses b ON b.id=p.business_id
       WHERE app.investor_id=$1`;
    if (status) {
      params.push(String(status));
      sql += ` AND app.status=$${params.length}`;
    }
    sql += ' ORDER BY app.created_at DESC';
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      ...mapApplication(row),
      projectTitle: row.project_title,
      projectSlug: row.project_slug,
      projectStatus: row.project_status,
      businessName: row.business_name,
    }));
  }

  async getMyApplication(applicationId, investorId) {
    const result = await this.pool.query(
      `SELECT app.*, p.title AS project_title, p.slug AS project_slug, p.status AS project_status,
              p.risk_disclosure, p.terms_text, p.exit_policy,
              b.legal_name AS business_name
       FROM investment_applications app
       JOIN projects p ON p.id=app.project_id
       JOIN businesses b ON b.id=p.business_id
       WHERE app.id=$1`,
      [applicationId],
    );
    if (!result.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    const row = result.rows[0];
    if (row.investor_id !== investorId) {
      throw new DomainError('FORBIDDEN', 'You can only view your own applications', 403);
    }
    return {
      ...mapApplication(row),
      projectTitle: row.project_title,
      projectSlug: row.project_slug,
      projectStatus: row.project_status,
      businessName: row.business_name,
      riskDisclosure: row.risk_disclosure,
      termsText: row.terms_text,
      exitPolicy: row.exit_policy,
    };
  }

  #mapInvestmentDetail(row, { approvedDistributions = null } = {}) {
    const investmentPoisha = Number(row.investment_poisha);
    const elapsedDays = Math.max(0, Math.floor((Date.now() - new Date(row.activated_at).getTime()) / 86_400_000));
    const confirmedProfitPoisha = Number(row.confirmed_profit_poisha || 0);
    const projection = buildProjectionPayload({
      investmentPoisha,
      targetProfitBps: row.target_profit_bps,
      elapsedDays,
      projectDays: row.duration_days,
      confirmedProfitPoisha,
      approvedDistributions: approvedDistributions || undefined,
    });
    const payload = {
      ...mapAllocation(row),
      projectName: row.project_title,
      projectTitle: row.project_title,
      projectStartAt: row.activated_at,
      lockInEndAt: row.maturity_at,
      administrationFeePoisha: Number(row.administration_fee_poisha),
      totalPaidPoisha: Number(row.total_paid_poisha ?? row.total_payable_poisha),
      paymentMethod: row.payment_method,
      paymentReference: row.payment_reference,
      verificationDate: row.payment_verified_at,
      annualProjectedRateBps: row.target_profit_bps,
      elapsedDays,
      ...projection,
      availablePayablePoisha: confirmedProfitPoisha,
      approvedDistributionsLabel: 'Approved distributions',
      projectionNeverPayable: true,
    };
    if (approvedDistributions) {
      payload.approvedDistributions = approvedDistributions;
    }
    return payload;
  }

  async getInvestment(allocationId, actorId, { includeDistributions = true } = {}) {
    const result = await this.pool.query(
      `SELECT a.*,
              p.title AS project_title,
              p.published_at AS project_published_at,
              pay.method AS payment_method,
              pay.reference AS payment_reference,
              pay.amount_poisha AS total_paid_poisha,
              pay.verified_at AS payment_verified_at,
              app.administration_fee_poisha,
              app.total_payable_poisha,
              COALESCE((SELECT SUM(confirmed_profit_poisha)::bigint FROM profit_confirmations pc WHERE pc.allocation_id=a.id AND COALESCE(pc.status,'approved')='approved'),0)::bigint AS confirmed_profit_poisha
       FROM allocations a
       JOIN projects p ON p.id=a.project_id
       JOIN payments pay ON pay.id=a.payment_id
       JOIN investment_applications app ON app.id=a.application_id
       WHERE a.id=$1`,
      [allocationId],
    );
    if (!result.rowCount) throw new DomainError('ALLOCATION_NOT_FOUND', 'Investment allocation was not found', 404);
    const row = result.rows[0];
    if (actorId && row.investor_id !== actorId) {
      throw new DomainError('FORBIDDEN', 'You cannot access this investment', 403);
    }
    let approvedDistributions = null;
    if (includeDistributions) {
      const dist = await this.pool.query(
        `SELECT * FROM profit_confirmations
         WHERE allocation_id=$1 AND COALESCE(status,'approved')='approved'
         ORDER BY period_end DESC, approved_at DESC`,
        [allocationId],
      );
      approvedDistributions = dist.rows.map(mapProfitConfirmation);
    }
    return this.#mapInvestmentDetail(row, { approvedDistributions });
  }

  async listActiveCategories() {
    const result = await this.pool.query(
      `SELECT * FROM categories
       WHERE is_active = true
       ORDER BY display_order ASC, name ASC`,
    );
    return result.rows.map(mapCategory);
  }

  async listAdminCategories({ includeInactive = true } = {}) {
    const result = await this.pool.query(
      includeInactive
        ? `SELECT * FROM categories ORDER BY display_order ASC, name ASC`
        : `SELECT * FROM categories WHERE is_active = true ORDER BY display_order ASC, name ASC`,
    );
    return result.rows.map(mapCategory);
  }

  async createCategory(input, actorId, meta = {}) {
    assertCategoryName(input.name);
    const name = input.name.trim();
    const slug = (input.slug && String(input.slug).trim()) || slugifyCategoryName(name);
    if (!slug) {
      throw new DomainError('INVALID_CATEGORY_SLUG', 'Category slug could not be derived', 400);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new DomainError('INVALID_CATEGORY_SLUG', 'Slug must be lowercase kebab-case', 400);
    }
    const description = input.description != null ? String(input.description).trim() || null : null;
    const iconUrl = input.iconUrl != null ? String(input.iconUrl).trim() || null : null;
    let displayOrder = input.displayOrder;
    if (displayOrder == null) {
      const max = await this.pool.query('SELECT COALESCE(MAX(display_order), 0) + 10 AS next FROM categories');
      displayOrder = Number(max.rows[0].next);
    } else {
      assertSafeInteger(displayOrder, 'displayOrder', 0);
    }
    const isActive = input.isActive !== false;

    return withTransaction(this.pool, async (client) => {
      let result;
      try {
        result = await client.query(
          `INSERT INTO categories(name, slug, description, icon_url, is_active, display_order, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [name, slug, description, iconUrl, isActive, displayOrder, actorId],
        );
      } catch (error) {
        if (error && error.code === '23505') {
          throw new DomainError('CATEGORY_CONFLICT', 'Category name or slug already exists', 409);
        }
        throw error;
      }
      const category = mapCategory(result.rows[0]);
      const ctx = normalizeRequestContext(meta.requestContext);
      await audit(client, actorId, 'category.created', 'category', category.id, category, {
        after: category,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return category;
    });
  }

  async updateCategory(categoryId, input, actorId, meta = {}) {
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query('SELECT * FROM categories WHERE id=$1 FOR UPDATE', [categoryId]);
      if (!locked.rowCount) throw new DomainError('CATEGORY_NOT_FOUND', 'Category was not found', 404);
      const before = mapCategory(locked.rows[0]);

      const name = input.name != null ? String(input.name).trim() : before.name;
      assertCategoryName(name);
      let slug = before.slug;
      if (input.slug != null) {
        slug = String(input.slug).trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
          throw new DomainError('INVALID_CATEGORY_SLUG', 'Slug must be lowercase kebab-case', 400);
        }
      }
      const description =
        input.description !== undefined
          ? input.description == null
            ? null
            : String(input.description).trim() || null
          : before.description;
      const iconUrl =
        input.iconUrl !== undefined
          ? input.iconUrl == null
            ? null
            : String(input.iconUrl).trim() || null
          : before.iconUrl;
      let displayOrder = before.displayOrder;
      if (input.displayOrder != null) {
        assertSafeInteger(input.displayOrder, 'displayOrder', 0);
        displayOrder = input.displayOrder;
      }

      let result;
      try {
        result = await client.query(
          `UPDATE categories
           SET name=$2, slug=$3, description=$4, icon_url=$5, display_order=$6
           WHERE id=$1
           RETURNING *`,
          [categoryId, name, slug, description, iconUrl, displayOrder],
        );
      } catch (error) {
        if (error && error.code === '23505') {
          throw new DomainError('CATEGORY_CONFLICT', 'Category name or slug already exists', 409);
        }
        throw error;
      }
      const category = mapCategory(result.rows[0]);
      const ctx = normalizeRequestContext(meta.requestContext);
      await audit(client, actorId, 'category.updated', 'category', category.id, category, {
        before,
        after: category,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return category;
    });
  }

  async setCategoryActive(categoryId, isActive, actorId, meta = {}) {
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query('SELECT * FROM categories WHERE id=$1 FOR UPDATE', [categoryId]);
      if (!locked.rowCount) throw new DomainError('CATEGORY_NOT_FOUND', 'Category was not found', 404);
      const before = mapCategory(locked.rows[0]);
      if (before.isActive === Boolean(isActive)) {
        return before;
      }
      const result = await client.query(
        `UPDATE categories SET is_active=$2 WHERE id=$1 RETURNING *`,
        [categoryId, Boolean(isActive)],
      );
      const category = mapCategory(result.rows[0]);
      const ctx = normalizeRequestContext(meta.requestContext);
      await audit(
        client,
        actorId,
        isActive ? 'category.activated' : 'category.deactivated',
        'category',
        category.id,
        category,
        {
          before,
          after: category,
          reason: meta.reason || null,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      );
      return category;
    });
  }

  async reorderCategories(orderedIds, actorId, meta = {}) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new DomainError('INVALID_REORDER', 'orderedIds must be a non-empty array of category ids', 400);
    }
    const unique = new Set(orderedIds);
    if (unique.size !== orderedIds.length) {
      throw new DomainError('INVALID_REORDER', 'orderedIds must be unique', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query('SELECT id, display_order, name FROM categories ORDER BY display_order ASC, name ASC');
      if (existing.rowCount !== orderedIds.length) {
        throw new DomainError(
          'INVALID_REORDER',
          'orderedIds must include every category exactly once',
          400,
        );
      }
      const existingIds = new Set(existing.rows.map((row) => row.id));
      for (const id of orderedIds) {
        if (!existingIds.has(id)) {
          throw new DomainError('CATEGORY_NOT_FOUND', `Unknown category id in reorder: ${id}`, 404);
        }
      }
      const before = existing.rows.map((row) => ({ id: row.id, displayOrder: row.display_order, name: row.name }));
      for (let index = 0; index < orderedIds.length; index += 1) {
        await client.query('UPDATE categories SET display_order=$2 WHERE id=$1', [
          orderedIds[index],
          (index + 1) * 10,
        ]);
      }
      const afterRows = await client.query(
        'SELECT * FROM categories ORDER BY display_order ASC, name ASC',
      );
      const after = afterRows.rows.map(mapCategory);
      const ctx = normalizeRequestContext(meta.requestContext);
      await audit(client, actorId, 'category.reordered', 'category', orderedIds[0], after, {
        before,
        after: after.map((row) => ({ id: row.id, displayOrder: row.displayOrder, name: row.name })),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  }

  async #resolveActiveCategory(client, input) {
    const categoryId = input.categoryId || input.category_id;
    if (categoryId) {
      const byId = await client.query(
        `SELECT * FROM categories WHERE id=$1 AND is_active=true LIMIT 1`,
        [categoryId],
      );
      if (!byId.rowCount) {
        throw new DomainError('CATEGORY_INVALID', 'Category must match an active marketplace category', 400);
      }
      return byId.rows[0];
    }
    const categoryKey = typeof input.category === 'string' ? input.category.trim() : '';
    if (!categoryKey) {
      throw new DomainError('CATEGORY_REQUIRED', 'A category is required', 400);
    }
    const categoryLookup = await client.query(
      `SELECT * FROM categories
       WHERE is_active = true
         AND (slug = $1 OR lower(name) = lower($1))
       LIMIT 1`,
      [categoryKey],
    );
    if (!categoryLookup.rowCount) {
      throw new DomainError('CATEGORY_INVALID', 'Category must match an active marketplace category', 400);
    }
    return categoryLookup.rows[0];
  }

  async #ensureUniqueSlug(client, desired) {
    let slug = slugifyTitle(desired);
    for (let i = 0; i < 8; i += 1) {
      const clash = await client.query('SELECT 1 FROM projects WHERE slug=$1 LIMIT 1', [slug]);
      if (!clash.rowCount) return slug;
      slug = `${slugifyTitle(desired)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    }
    throw new DomainError('SLUG_CONFLICT', 'Unable to allocate a unique project slug', 409);
  }

  async #insertVersionSnapshot(client, project, actorId, changeSummary) {
    const snapshot = materialSnapshot(project);
    const contentHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    await client.query(
      `INSERT INTO project_versions(project_id, version_number, snapshot_json, content_hash, change_summary, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6)
       ON CONFLICT (project_id, version_number) DO NOTHING`,
      [
        project.id,
        project.versionNumber || 1,
        JSON.stringify(snapshot),
        contentHash,
        changeSummary || null,
        actorId,
      ],
    );
  }

  async #loadProjectForUpdate(client, projectId) {
    const locked = await client.query(`${PROJECT_SELECT} WHERE p.id=$1 FOR UPDATE OF p`, [projectId]);
    if (!locked.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    return mapProject(locked.rows[0]);
  }

  async #assertOwner(project, actorId) {
    if (project.ownerUserId !== actorId) {
      throw new DomainError('PROJECT_FORBIDDEN', 'You can only access your own projects', 403);
    }
  }

  async getOwnerProject(projectId, ownerUserId) {
    const result = await this.pool.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
    if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    const project = mapProject(result.rows[0]);
    await this.#assertOwner(project, ownerUserId);
    return project;
  }

  async getAdminProject(projectId) {
    const result = await this.pool.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
    if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    return mapProject(result.rows[0]);
  }

  async listAdminProjects({ status = null, reviewQueue = false } = {}) {
    const params = [];
    let sql = `${PROJECT_SELECT} WHERE 1=1`;
    if (reviewQueue) {
      params.push(REVIEW_QUEUE_STATUSES);
      sql += ` AND p.status = ANY($${params.length}::text[])`;
    } else if (status) {
      params.push(status);
      sql += ` AND p.status = $${params.length}`;
    }
    sql += ' ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC';
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapProject);
  }

  async updateOwnerProject(projectId, input, ownerUserId) {
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      await this.#assertOwner(before, ownerUserId);
      if (!OWNER_EDITABLE_STATUSES.has(before.status)) {
        throw new DomainError(
          'PROJECT_NOT_EDITABLE',
          'Owners can only edit drafts or projects with changes requested',
          409,
        );
      }
      // Owners cannot set staff timestamps / approve / publish fields
      const forbidden = [
        'approvedAt', 'approvedBy', 'publishedAt', 'publishedBy', 'reviewedAt', 'reviewedBy',
        'pausedAt', 'pausedBy', 'fundingClosedAt', 'fundingClosedBy', 'status',
      ];
      for (const key of forbidden) {
        if (input[key] != null) {
          throw new DomainError('FORBIDDEN_FIELD', `Owners cannot set ${key}`, 403);
        }
      }
      return this.#applyProjectPatch(client, before, input, ownerUserId, { bumpIfMaterial: false });
    });
  }

  async updateAdminProject(projectId, input, actorId) {
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      if (!ADMIN_EDITABLE_STATUSES.has(before.status)) {
        throw new DomainError(
          'PROJECT_NOT_EDITABLE',
          'Admins can only edit unpublished projects in editable workflow states',
          409,
        );
      }
      const bumpIfMaterial = [
        PROJECT_WORKFLOW_STATUS.APPROVED,
        PROJECT_WORKFLOW_STATUS.RESUBMITTED,
        PROJECT_WORKFLOW_STATUS.SUBMITTED_FOR_REVIEW,
      ].includes(before.status);
      return this.#applyProjectPatch(client, before, input, actorId, { bumpIfMaterial });
    });
  }

  async #applyProjectPatch(client, before, input, actorId, { bumpIfMaterial }) {
    validateProjectPayload({ ...before, ...input }, 'draft');
    let category = null;
    if (input.categoryId || input.category) {
      category = await this.#resolveActiveCategory(client, input);
    }
    const unitInvestmentPoisha = input.unitInvestmentPoisha ?? before.unitInvestmentPoisha;
    const totalUnits = input.totalUnits ?? before.totalUnits;
    const administrationFeeBps = input.administrationFeeBps ?? before.administrationFeeBps;
    const feeRange = feeBpsRange();
    if (administrationFeeBps < feeRange.min || administrationFeeBps > feeRange.max) {
      throw new DomainError(
        'FEE_OUT_OF_RANGE',
        `administrationFeeBps must be between ${feeRange.min} and ${feeRange.max}`,
        400,
      );
    }
    const selectedRateBps =
      input.selectedRateBps ?? input.targetProfitBps ?? before.selectedRateBps ?? before.targetProfitBps;
    const projectedMin = input.projectedReturnMinBps ?? before.projectedReturnMinBps;
    const projectedMax = input.projectedReturnMaxBps ?? before.projectedReturnMaxBps;
    const fundingTargetException =
      input.fundingTargetException != null
        ? Boolean(input.fundingTargetException)
        : before.fundingTargetException;
    let fundingTargetPoisha = input.fundingTargetPoisha ?? before.fundingTargetPoisha;
    if (fundingTargetPoisha == null) fundingTargetPoisha = unitInvestmentPoisha * totalUnits;
    if (fundingTargetPoisha !== unitInvestmentPoisha * totalUnits && !fundingTargetException) {
      throw new DomainError(
        'FUNDING_TARGET_MISMATCH',
        'fundingTargetPoisha must equal unit price × total units unless an exception is recorded',
        400,
      );
    }
    if (input.availableUnits != null && input.availableUnits > totalUnits) {
      throw new DomainError('INVALID_AVAILABLE_UNITS', 'availableUnits must be <= totalUnits', 400);
    }

    const reservedActive = before.reservedUnits + before.activeUnits;
    if (totalUnits < reservedActive) {
      throw new DomainError(
        'TOTAL_UNITS_TOO_LOW',
        `totalUnits cannot be below reserved+active (${reservedActive})`,
        409,
      );
    }

    let slug = before.slug;
    if (input.slug && input.slug !== before.slug) {
      slug = await this.#ensureUniqueSlug(client, input.slug);
    } else if (input.title && input.title !== before.title && before.status === PROJECT_WORKFLOW_STATUS.DRAFT) {
      // keep stable slug after create; only allow explicit slug change
      slug = before.slug;
    }

    const next = {
      ...before,
      title: input.title != null ? String(input.title).trim() : before.title,
      summary: input.summary != null ? String(input.summary).trim() : before.summary,
      categoryId: category ? category.id : before.categoryId,
      category: category ? category.name : before.category,
      unitInvestmentPoisha,
      administrationFeeBps,
      totalUnits,
      selectedRateBps,
      targetProfitBps: selectedRateBps,
      projectedReturnMinBps: projectedMin,
      projectedReturnMaxBps: projectedMax,
      fundingTargetPoisha,
      fundingTargetException,
      fundingTargetExceptionReason: fundingTargetException
        ? String(input.fundingTargetExceptionReason ?? before.fundingTargetExceptionReason ?? '').trim()
        : null,
      durationDays: input.durationDays ?? before.durationDays,
      minimumExitDays: input.minimumExitDays ?? before.minimumExitDays,
      fundingOpensAt: input.fundingOpensAt ?? before.fundingOpensAt,
      fundingClosesAt: input.fundingClosesAt ?? before.fundingClosesAt,
      projectStartsAt: input.projectStartsAt ?? before.projectStartsAt,
      projectEndsAt: input.projectEndsAt ?? before.projectEndsAt,
      riskDisclosure: input.riskDisclosure ?? before.riskDisclosure,
      termsText: input.termsText ?? before.termsText,
      exitPolicy: input.exitPolicy ?? before.exitPolicy,
      slug,
      locationAddress: input.locationAddress != null ? String(input.locationAddress).trim() : before.locationAddress,
      photoUrls: Array.isArray(input.photoUrls)
        ? input.photoUrls.filter((u) => typeof u === 'string' && u.trim()).slice(0, 10)
        : before.photoUrls || [],
      detailsText: input.detailsText != null ? String(input.detailsText) : before.detailsText,
      investmentYears: input.investmentYears != null ? Number(input.investmentYears) : before.investmentYears,
      estimatedYearlyProfitBps:
        input.estimatedYearlyProfitBps != null
          ? Number(input.estimatedYearlyProfitBps)
          : before.estimatedYearlyProfitBps,
      badLossSummary: input.badLossSummary != null ? String(input.badLossSummary) : before.badLossSummary,
      ownerExperience: input.ownerExperience != null ? String(input.ownerExperience) : before.ownerExperience,
      educationalBackground:
        input.educationalBackground != null
          ? String(input.educationalBackground)
          : before.educationalBackground,
    };
    if (input.investmentYears != null) {
      next.durationDays = yearsToDurationDays(Number(input.investmentYears));
      next.investmentYears = Number(input.investmentYears);
    }

    let versionNumber = before.versionNumber;
    const material = hasMaterialChange(before, next);
    if (bumpIfMaterial && material) {
      versionNumber += 1;
    }

    await client.query(
      `UPDATE projects SET
         title=$2, summary=$3, category=$4, category_id=$5, slug=$6,
         total_units=$7, unit_investment_poisha=$8, administration_fee_bps=$9,
         target_profit_bps=$10, selected_rate_bps=$11,
         projected_return_min_bps=$12, projected_return_max_bps=$13,
         funding_target_poisha=$14, funding_target_exception=$15, funding_target_exception_reason=$16,
         duration_days=$17, minimum_exit_days=$18,
         funding_opens_at=$19, funding_closes_at=$20, project_starts_at=$21, project_ends_at=$22,
         risk_disclosure=$23, terms_text=$24, exit_policy=$25,
         version_number=$26, updated_at=now(),
         location_address=$27, photo_urls=$28::jsonb, details_text=$29, investment_years=$30,
         estimated_yearly_profit_bps=$31, bad_loss_summary=$32, owner_experience=$33, educational_background=$34
       WHERE id=$1`,
      [
        before.id,
        next.title,
        next.summary,
        next.category,
        next.categoryId,
        next.slug,
        next.totalUnits,
        next.unitInvestmentPoisha,
        next.administrationFeeBps,
        next.selectedRateBps,
        next.selectedRateBps,
        next.projectedReturnMinBps,
        next.projectedReturnMaxBps,
        next.fundingTargetPoisha,
        next.fundingTargetException,
        next.fundingTargetExceptionReason,
        next.durationDays,
        next.minimumExitDays,
        next.fundingOpensAt,
        next.fundingClosesAt,
        next.projectStartsAt,
        next.projectEndsAt,
        next.riskDisclosure,
        next.termsText,
        next.exitPolicy,
        versionNumber,
        next.locationAddress ?? null,
        JSON.stringify(next.photoUrls || []),
        next.detailsText ?? null,
        next.investmentYears ?? null,
        next.estimatedYearlyProfitBps ?? null,
        next.badLossSummary ?? null,
        next.ownerExperience ?? null,
        next.educationalBackground ?? null,
      ],
    );

    const updatedRows = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [before.id]);
    const project = mapProject(updatedRows.rows[0]);
    if (bumpIfMaterial && material) {
      await this.#insertVersionSnapshot(client, project, actorId, input.changeSummary || 'material financial terms updated');
    }
    await audit(client, actorId, 'project.updated', 'project', project.id, project, {
      before,
      after: project,
      reason: input.changeSummary || null,
    });
    return project;
  }

  async submitOwnerProject(projectId, ownerUserId, feePayload = null) {
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      await this.#assertOwner(before, ownerUserId);
      assertTransition(before.status, PROJECT_WORKFLOW_STATUS.SUBMITTED_FOR_REVIEW);
      validateProjectPayload(before, 'submit');
      // Ensure review fee row exists; optionally record fictional cash/bank deposit at submit.
      if (typeof this.ensureProjectReviewFee === 'function') {
        await this.ensureProjectReviewFee(projectId, ownerUserId, client);
      }
      if (feePayload && feePayload.paymentMethod) {
        const method = String(feePayload.paymentMethod || '').trim();
        const ref = String(feePayload.reference || '').trim();
        if (!['cash', 'bank_deposit'].includes(method) || ref.length < 3) {
          throw new DomainError('INVALID_FEE_PAYMENT', 'Fee paymentMethod + reference required', 400);
        }
        await client.query(
          `UPDATE project_review_fees SET
             status='submitted', payment_method=$2, reference=$3, receipt_note=$4,
             submitted_at=now(), submitted_by=$5, updated_at=now()
           WHERE project_id=$1 AND status IN ('unpaid','submitted')`,
          [projectId, method, ref, feePayload.receiptNote || null, ownerUserId],
        );
      }
      if (typeof this.assertReviewFeeReadyForSubmit === 'function') {
        await this.assertReviewFeeReadyForSubmit(projectId, client);
      }
      await client.query(
        `UPDATE projects
         SET status='submitted_for_review', submitted_at=now(), submitted_by=$2,
             change_request_reason=NULL, updated_at=now()
         WHERE id=$1`,
        [projectId, ownerUserId],
      );
      const updated = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
      const project = mapProject(updated.rows[0]);
      await audit(client, ownerUserId, 'project.submitted', 'project', projectId, project, { before });
      return project;
    });
  }

  async resubmitOwnerProject(projectId, ownerUserId) {
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      await this.#assertOwner(before, ownerUserId);
      assertTransition(before.status, PROJECT_WORKFLOW_STATUS.RESUBMITTED);
      validateProjectPayload(before, 'submit');
      await client.query(
        `UPDATE projects
         SET status='resubmitted', submitted_at=now(), submitted_by=$2, updated_at=now()
         WHERE id=$1`,
        [projectId, ownerUserId],
      );
      const updated = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
      const project = mapProject(updated.rows[0]);
      await audit(client, ownerUserId, 'project.resubmitted', 'project', projectId, project, { before });
      return project;
    });
  }

  async requestProjectChanges(projectId, actorId, reason) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 5) {
      throw new DomainError('REASON_REQUIRED', 'A change-request reason is required', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      assertTransition(before.status, PROJECT_WORKFLOW_STATUS.CHANGES_REQUESTED);
      await client.query(
        `UPDATE projects
         SET status='changes_requested', change_request_reason=$2,
             reviewed_at=now(), reviewed_by=$3, updated_at=now()
         WHERE id=$1`,
        [projectId, trimmed, actorId],
      );
      const updated = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
      const project = mapProject(updated.rows[0]);
      await audit(client, actorId, 'project.changes_requested', 'project', projectId, project, {
        before,
        reason: trimmed,
      });
      return project;
    });
  }

  async rejectProject(projectId, actorId, reason) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 5) {
      throw new DomainError('REASON_REQUIRED', 'A rejection reason is required', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      assertTransition(before.status, PROJECT_WORKFLOW_STATUS.REJECTED);
      await client.query(
        `UPDATE projects
         SET status='rejected', rejection_reason=$2,
             reviewed_at=now(), reviewed_by=$3, updated_at=now()
         WHERE id=$1`,
        [projectId, trimmed, actorId],
      );
      const updated = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
      const project = mapProject(updated.rows[0]);
      await audit(client, actorId, 'project.rejected', 'project', projectId, project, {
        before,
        reason: trimmed,
      });
      return project;
    });
  }

  async approveProject(projectId, actorId) {
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      assertTransition(before.status, PROJECT_WORKFLOW_STATUS.APPROVED);
      validateProjectPayload(before, 'approve');
      await client.query(
        `UPDATE projects
         SET status='approved', approved_at=now(), approved_by=$2,
             reviewed_at=now(), reviewed_by=$2,
             change_request_reason=NULL, rejection_reason=NULL, updated_at=now()
         WHERE id=$1`,
        [projectId, actorId],
      );
      const updated = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
      const project = mapProject(updated.rows[0]);
      await this.#insertVersionSnapshot(client, project, actorId, 'project.approved');
      // Immutable application terms are written on publish (not approve).
      await audit(client, actorId, 'project.approved', 'project', projectId, project, { before });
      return project;
    });
  }

  async pauseProject(projectId, actorId, reason = '') {
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      assertTransition(before.status, PROJECT_WORKFLOW_STATUS.PAUSED);
      await client.query(
        `UPDATE projects
         SET status='paused', paused_at=now(), paused_by=$2, updated_at=now()
         WHERE id=$1`,
        [projectId, actorId],
      );
      const updated = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
      const project = mapProject(updated.rows[0]);
      await audit(client, actorId, 'project.paused', 'project', projectId, project, {
        before,
        reason: reason || null,
      });
      return project;
    });
  }

  async resumeProject(projectId, actorId) {
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      assertTransition(before.status, PROJECT_WORKFLOW_STATUS.PUBLISHED);
      if (before.status !== PROJECT_WORKFLOW_STATUS.PAUSED) {
        throw new DomainError('PROJECT_NOT_PAUSED', 'Only paused projects can be resumed', 409);
      }
      await client.query(
        `UPDATE projects
         SET status='published', paused_at=NULL, paused_by=NULL, updated_at=now()
         WHERE id=$1`,
        [projectId],
      );
      const updated = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
      const project = mapProject(updated.rows[0]);
      await audit(client, actorId, 'project.resumed', 'project', projectId, project, { before });
      return project;
    });
  }

  async closeFunding(projectId, actorId, reason = '') {
    return withTransaction(this.pool, async (client) => {
      const before = await this.#loadProjectForUpdate(client, projectId);
      assertTransition(before.status, PROJECT_WORKFLOW_STATUS.FUNDING_CLOSED);
      await client.query(
        `UPDATE projects
         SET status='funding_closed', funding_closed_at=now(), funding_closed_by=$2, updated_at=now()
         WHERE id=$1`,
        [projectId, actorId],
      );
      const updated = await client.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
      const project = mapProject(updated.rows[0]);
      await audit(client, actorId, 'project.funding_closed', 'project', projectId, project, {
        before,
        reason: reason || null,
      });
      return project;
    });
  }

  async listProjectVersions(projectId, { actorId, asAdmin = false } = {}) {
    const result = await this.pool.query(`${PROJECT_SELECT} WHERE p.id=$1`, [projectId]);
    if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    const project = mapProject(result.rows[0]);
    if (!asAdmin) {
      await this.#assertOwner(project, actorId);
    }
    const versions = await this.pool.query(
      `SELECT id, project_id, version_number, snapshot_json, content_hash, change_summary, created_by, created_at
       FROM project_versions
       WHERE project_id=$1
       ORDER BY version_number DESC`,
      [projectId],
    );
    return {
      projectId,
      currentVersion: project.versionNumber,
      versions: versions.rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        versionNumber: row.version_number,
        snapshot: row.snapshot_json,
        contentHash: row.content_hash,
        changeSummary: row.change_summary,
        createdBy: row.created_by,
        createdAt: row.created_at,
      })),
    };
  }



  // ---- Phase 3: investor profile + encrypted bank ----

  async #loadUserRow(clientOrPool, userId) {
    const result = await clientOrPool.query(
      `SELECT id, email, mobile, status, email_verified_at, phone_verified_at, created_at, updated_at
       FROM users WHERE id=$1`,
      [userId],
    );
    return result.rows[0] || null;
  }

  async #loadProfileRow(clientOrPool, userId) {
    const result = await clientOrPool.query(
      `SELECT * FROM investor_profiles WHERE user_id=$1`,
      [userId],
    );
    return result.rows[0] || null;
  }

  async #loadBankRow(clientOrPool, userId) {
    const result = await clientOrPool.query(
      `SELECT * FROM investor_bank_accounts WHERE user_id=$1`,
      [userId],
    );
    return result.rows[0] || null;
  }

  async getInvestorProfile(userId) {
    const user = await this.#loadUserRow(this.pool, userId);
    if (!user) throw new DomainError('USER_NOT_FOUND', 'User was not found', 404);
    const profileRow = await this.#loadProfileRow(this.pool, userId);
    const bankRow = await this.#loadBankRow(this.pool, userId);
    const profile = mapProfileRow(profileRow, user) || mapProfileRow(null, user);
    const bank = mapBankRowMasked(bankRow);
    return attachCompletion(profile, bank);
  }

  async updateInvestorProfile(userId, input, actorId, meta = {}) {
    const patch = validateProfilePatch(input);
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const user = await this.#loadUserRow(client, userId);
      if (!user) throw new DomainError('USER_NOT_FOUND', 'User was not found', 404);
      const beforeRow = await this.#loadProfileRow(client, userId);
      const before = profileAuditSnapshot(mapProfileRow(beforeRow, user));

      // After admin-approved KYC, further investor edits require changeReason and re-review.
      let changeReason = null;
      let revertKycToPending = false;
      if (beforeRow && beforeRow.kyc_status === 'approved') {
        const rawReason = input.changeReason ?? input.reason ?? null;
        if (rawReason == null || String(rawReason).trim().length < 10) {
          throw new DomainError(
            'CHANGE_REASON_REQUIRED',
            'After KYC approval, profile edits require changeReason (at least 10 characters) and return to under review',
            400,
          );
        }
        changeReason = String(rawReason).trim().slice(0, 2000);
        revertKycToPending = true;
      }

      if (!beforeRow) {
        await client.query(
          `INSERT INTO investor_profiles(
             user_id, full_name, phone, date_of_birth, nationality, occupation,
             present_address, permanent_address, nominee_name, nominee_relationship, nominee_phone, kyc_status
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'not_started')`,
          [
            userId,
            patch.fullName || 'Investor',
            patch.phone || null,
            patch.dateOfBirth || null,
            patch.nationality || null,
            patch.occupation || null,
            patch.presentAddress || null,
            patch.permanentAddress || null,
            patch.nomineeName || null,
            patch.nomineeRelationship || null,
            patch.nomineePhone || null,
          ],
        );
      } else {
        const merged = {
          fullName: patch.fullName ?? beforeRow.full_name,
          phone: patch.phone ?? beforeRow.phone,
          dateOfBirth: patch.dateOfBirth !== undefined ? patch.dateOfBirth : beforeRow.date_of_birth,
          nationality: patch.nationality ?? beforeRow.nationality,
          occupation: patch.occupation ?? beforeRow.occupation,
          presentAddress: patch.presentAddress ?? beforeRow.present_address,
          permanentAddress: patch.permanentAddress ?? beforeRow.permanent_address,
          nomineeName: patch.nomineeName ?? beforeRow.nominee_name,
          nomineeRelationship: patch.nomineeRelationship ?? beforeRow.nominee_relationship,
          nomineePhone: patch.nomineePhone ?? beforeRow.nominee_phone,
        };
        await client.query(
          `UPDATE investor_profiles SET
             full_name=$2, phone=$3, date_of_birth=$4, nationality=$5, occupation=$6,
             present_address=$7, permanent_address=$8, nominee_name=$9,
             nominee_relationship=$10, nominee_phone=$11,
             kyc_status=CASE WHEN $12 THEN 'pending' ELSE kyc_status END,
             previous_kyc_status=CASE WHEN $12 THEN kyc_status ELSE previous_kyc_status END,
             change_reason=CASE WHEN $12 THEN $13 ELSE change_reason END,
             change_requested_at=CASE WHEN $12 THEN now() ELSE change_requested_at END,
             updated_at=now()
           WHERE user_id=$1`,
          [
            userId,
            merged.fullName,
            merged.phone,
            merged.dateOfBirth,
            merged.nationality,
            merged.occupation,
            merged.presentAddress,
            merged.permanentAddress,
            merged.nomineeName,
            merged.nomineeRelationship,
            merged.nomineePhone,
            revertKycToPending,
            changeReason,
          ],
        );
      }

      // Keep users.mobile in sync when phone is updated (display / verification status).
      if (patch.phone) {
        await client.query(
          `UPDATE users SET mobile=$2, updated_at=now() WHERE id=$1 AND (mobile IS DISTINCT FROM $2)`,
          [userId, patch.phone],
        );
      }

      const afterUser = await this.#loadUserRow(client, userId);
      const afterRow = await this.#loadProfileRow(client, userId);
      const bankRow = await this.#loadBankRow(client, userId);
      const profile = attachCompletion(mapProfileRow(afterRow, afterUser), mapBankRowMasked(bankRow));
      await audit(
        client,
        actorId,
        'investor.profile.updated',
        'investor_profile',
        userId,
        profileAuditSnapshot(profile),
        { before, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return profile;
    });
  }

  async getInvestorBank(userId) {
    const user = await this.#loadUserRow(this.pool, userId);
    if (!user) throw new DomainError('USER_NOT_FOUND', 'User was not found', 404);
    const bankRow = await this.#loadBankRow(this.pool, userId);
    return mapBankRowMasked(bankRow);
  }

  async upsertInvestorBank(userId, input, actorId, meta = {}) {
    const validated = validateBankUpsert(input);
    const encrypted = encryptBankSecrets(validated);
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const user = await this.#loadUserRow(client, userId);
      if (!user) throw new DomainError('USER_NOT_FOUND', 'User was not found', 404);
      const beforeRow = await this.#loadBankRow(client, userId);
      const beforeMasked = mapBankRowMasked(beforeRow);
      const wasVerified = beforeRow?.verification_status === 'verified';

      await client.query(
        `INSERT INTO investor_bank_accounts(
           user_id, account_holder_name, bank_name, branch_name, account_type,
           account_number_ciphertext, account_number_last4,
           routing_number_ciphertext, routing_number_last4,
           mfs_type, mfs_number_ciphertext, mfs_number_last4,
           verification_status, verified_at, verified_by, verification_note
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',NULL,NULL,NULL)
         ON CONFLICT (user_id) DO UPDATE SET
           account_holder_name=EXCLUDED.account_holder_name,
           bank_name=EXCLUDED.bank_name,
           branch_name=EXCLUDED.branch_name,
           account_type=EXCLUDED.account_type,
           account_number_ciphertext=EXCLUDED.account_number_ciphertext,
           account_number_last4=EXCLUDED.account_number_last4,
           routing_number_ciphertext=EXCLUDED.routing_number_ciphertext,
           routing_number_last4=EXCLUDED.routing_number_last4,
           mfs_type=EXCLUDED.mfs_type,
           mfs_number_ciphertext=EXCLUDED.mfs_number_ciphertext,
           mfs_number_last4=EXCLUDED.mfs_number_last4,
           verification_status='pending',
           verified_at=NULL,
           verified_by=NULL,
           verification_note=NULL,
           updated_at=now()`,
        [
          userId,
          encrypted.accountHolderName,
          encrypted.bankName,
          encrypted.branchName,
          encrypted.accountType,
          encrypted.accountNumberCiphertext,
          encrypted.accountNumberLast4,
          encrypted.routingNumberCiphertext,
          encrypted.routingNumberLast4,
          encrypted.mfsType,
          encrypted.mfsNumberCiphertext,
          encrypted.mfsNumberLast4,
        ],
      );

      // Keep legacy last4 mirror for older readers.
      await client.query(
        `UPDATE investor_profiles SET payout_account_last4=$2, updated_at=now() WHERE user_id=$1`,
        [userId, encrypted.accountNumberLast4],
      );

      const afterRow = await this.#loadBankRow(client, userId);
      const masked = mapBankRowMasked(afterRow);
      const action = wasVerified ? 'investor.bank.updated_reset_pending' : 'investor.bank.upserted';
      await audit(
        client,
        actorId,
        action,
        'investor_bank',
        userId,
        bankAuditSnapshot(masked),
        {
          before: bankAuditSnapshot(beforeMasked),
          reason: wasVerified ? 'Verified bank details changed; verification reset to pending' : null,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      );
      return {
        bank: masked,
        verificationReset: wasVerified,
      };
    });
  }

  async verifyInvestorBank(userId, actorId, { status = 'verified', note = '', requestContext } = {}) {
    const next = String(status || 'verified').toLowerCase();
    if (!['verified', 'rejected', 'pending'].includes(next)) {
      throw new DomainError('VALIDATION_ERROR', 'status must be verified, rejected, or pending', 400);
    }
    const ctx = normalizeRequestContext(requestContext);
    return withTransaction(this.pool, async (client) => {
      const beforeRow = await this.#loadBankRow(client, userId);
      if (!beforeRow) throw new DomainError('BANK_NOT_FOUND', 'Investor bank details not found', 404);
      const beforeMasked = mapBankRowMasked(beforeRow);
      await client.query(
        `UPDATE investor_bank_accounts SET
           verification_status=$2,
           verified_at=CASE WHEN $2='verified' THEN now() WHEN $2='pending' THEN NULL ELSE verified_at END,
           verified_by=CASE WHEN $2='pending' THEN NULL ELSE $3::uuid END,
           verification_note=$4,
           updated_at=now()
         WHERE user_id=$1`,
        [userId, next, actorId, note || null],
      );
      const afterRow = await this.#loadBankRow(client, userId);
      const masked = mapBankRowMasked(afterRow);
      await audit(
        client,
        actorId,
        'investor.bank.verification_updated',
        'investor_bank',
        userId,
        bankAuditSnapshot(masked),
        {
          before: bankAuditSnapshot(beforeMasked),
          reason: note || null,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      );
      return masked;
    });
  }

  async setInvestorKycStatus(userId, actorId, status, meta = {}) {
    const next = String(status || '').toLowerCase();
    if (!KYC_STATUSES.includes(next)) {
      throw new DomainError('VALIDATION_ERROR', `kycStatus must be one of: ${KYC_STATUSES.join(', ')}`, 400);
    }
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const user = await this.#loadUserRow(client, userId);
      if (!user) throw new DomainError('USER_NOT_FOUND', 'User was not found', 404);
      const beforeRow = await this.#loadProfileRow(client, userId);
      if (!beforeRow) {
        await client.query(
          `INSERT INTO investor_profiles(user_id, full_name, kyc_status) VALUES ($1,$2,$3)`,
          [userId, 'Investor', next],
        );
      } else {
        await client.query(
          `UPDATE investor_profiles SET kyc_status=$2, updated_at=now() WHERE user_id=$1`,
          [userId, next],
        );
      }
      const afterUser = await this.#loadUserRow(client, userId);
      const afterRow = await this.#loadProfileRow(client, userId);
      const bankRow = await this.#loadBankRow(client, userId);
      const profile = attachCompletion(mapProfileRow(afterRow, afterUser), mapBankRowMasked(bankRow));
      await audit(
        client,
        actorId,
        'investor.kyc.status_updated',
        'investor_profile',
        userId,
        { kycStatus: next },
        {
          before: { kycStatus: beforeRow?.kyc_status || 'not_started' },
          reason: meta.reason || null,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      );
      return profile;
    });
  }

  async listAdminAllocations({ status = 'active', projectId = null, limit = 100 } = {}) {
    const params = [];
    let sql = `SELECT a.*,
              p.title AS project_title,
              u.email AS investor_email,
              COALESCE(ip.full_name, u.email) AS investor_name,
              COALESCE((SELECT SUM(confirmed_profit_poisha)::bigint FROM profit_confirmations pc WHERE pc.allocation_id=a.id AND COALESCE(pc.status,'approved')='approved'),0)::bigint AS confirmed_profit_poisha,
              app.administration_fee_poisha,
              app.total_payable_poisha,
              pay.method AS payment_method,
              pay.reference AS payment_reference,
              pay.amount_poisha AS total_paid_poisha,
              pay.verified_at AS payment_verified_at
       FROM allocations a
       JOIN projects p ON p.id=a.project_id
       JOIN users u ON u.id=a.investor_id
       LEFT JOIN investor_profiles ip ON ip.user_id=u.id
       JOIN investment_applications app ON app.id=a.application_id
       JOIN payments pay ON pay.id=a.payment_id
       WHERE 1=1`;
    if (status) {
      params.push(String(status));
      sql += ` AND a.status=$${params.length}`;
    }
    if (projectId) {
      params.push(projectId);
      sql += ` AND a.project_id=$${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY a.activated_at DESC LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      ...this.#mapInvestmentDetail(row),
      investorEmail: row.investor_email,
      investorName: row.investor_name,
    }));
  }

  async listApprovedDistributions(allocationId, actorId, { canViewAny = false } = {}) {
    const alloc = await this.pool.query(`SELECT id, investor_id FROM allocations WHERE id=$1`, [allocationId]);
    if (!alloc.rowCount) throw new DomainError('ALLOCATION_NOT_FOUND', 'Investment allocation was not found', 404);
    if (!canViewAny && actorId && alloc.rows[0].investor_id !== actorId) {
      throw new DomainError('FORBIDDEN', 'You can only view Approved distributions for your own share holdings', 403);
    }
    const result = await this.pool.query(
      `SELECT * FROM profit_confirmations
       WHERE allocation_id=$1 AND COALESCE(status,'approved')='approved'
       ORDER BY period_end DESC, approved_at DESC`,
      [allocationId],
    );
    return result.rows.map(mapProfitConfirmation);
  }

  async getProfitConfirmation(confirmationId, actorId, { canViewAny = false } = {}) {
    const result = await this.pool.query(
      `SELECT pc.*, a.investor_id
       FROM profit_confirmations pc
       JOIN allocations a ON a.id=pc.allocation_id
       WHERE pc.id=$1`,
      [confirmationId],
    );
    if (!result.rowCount) throw new DomainError('PROFIT_CONFIRMATION_NOT_FOUND', 'Approved distribution was not found', 404);
    const row = result.rows[0];
    if (!canViewAny && actorId && row.investor_id !== actorId) {
      throw new DomainError('FORBIDDEN', 'You can only view your own Approved distributions', 403);
    }
    return mapProfitConfirmation(row);
  }

  async declareProfitConfirmation(allocationId, input, actorId, meta = {}) {
    const periodStart = parseIsoDateOnly(input.periodStart, 'periodStart');
    const periodEnd = parseIsoDateOnly(input.periodEnd, 'periodEnd');
    assertPeriodOrder(periodStart, periodEnd);
    const confirmedProfitPoisha = requireConfirmedProfitPoisha(input.confirmedProfitPoisha);
    const notes = optionalNote(input.notes, 'notes');
    const declarationNote = optionalNote(input.declarationNote ?? input.reviewNote, 'declarationNote');
    const sourceReportId = input.sourceReportId || null;
    const ctx = normalizeRequestContext(meta.requestContext);

    return withTransaction(this.pool, async (client) => {
      const allocResult = await client.query(
        `SELECT a.*, p.title AS project_title
         FROM allocations a
         JOIN projects p ON p.id=a.project_id
         WHERE a.id=$1
         FOR UPDATE`,
        [allocationId],
      );
      if (!allocResult.rowCount) {
        throw new DomainError('ALLOCATION_NOT_FOUND', 'Investment allocation was not found', 404);
      }
      const alloc = allocResult.rows[0];
      if (!['active', 'matured'].includes(alloc.status)) {
        throw new DomainError(
          'ALLOCATION_NOT_ELIGIBLE',
          `Cannot declare Approved distribution for allocation status ${alloc.status}`,
          409,
        );
      }

      if (sourceReportId) {
        const report = await client.query(
          `SELECT id, project_id, status FROM performance_reports WHERE id=$1`,
          [sourceReportId],
        );
        if (!report.rowCount) {
          throw new DomainError('PERFORMANCE_REPORT_NOT_FOUND', 'Performance report was not found', 404);
        }
        if (report.rows[0].project_id !== alloc.project_id) {
          throw new DomainError('REPORT_PROJECT_MISMATCH', 'Performance report does not belong to this allocation project', 409);
        }
      }

      const insert = await client.query(
        `INSERT INTO profit_confirmations(
           allocation_id, period_start, period_end, confirmed_profit_poisha,
           approved_by, approved_at, source_report_id, notes, declaration_note,
           status, available_payable_poisha, created_at
         ) VALUES ($1,$2::date,$3::date,$4,$5,now(),$6,$7,$8,'approved',$4,now())
         ON CONFLICT (allocation_id, period_start, period_end) DO NOTHING
         RETURNING *`,
        [allocationId, periodStart, periodEnd, confirmedProfitPoisha, actorId, sourceReportId, notes, declarationNote],
      );

      if (!insert.rowCount) {
        throw new DomainError(
          'DUPLICATE_PERIOD',
          'An Approved distribution already exists for this allocation and period',
          409,
        );
      }

      const mapped = mapProfitConfirmation(insert.rows[0]);
      await audit(
        client,
        actorId,
        'profit_confirmation.declared',
        'profit_confirmation',
        mapped.id,
        {
          allocationId,
          periodStart,
          periodEnd,
          confirmedProfitPoisha,
          projectTitle: alloc.project_title,
          investorId: alloc.investor_id,
        },
        {
          after: mapped,
          reason: declarationNote || notes,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      );
      return mapped;
    });
  }

  async listAdminProfitConfirmations({ allocationId = null, limit = 100 } = {}) {
    const params = [];
    let sql = `SELECT pc.*, a.investor_id, a.project_id, p.title AS project_title,
              u.email AS investor_email,
              COALESCE(ip.full_name, u.email) AS investor_name
       FROM profit_confirmations pc
       JOIN allocations a ON a.id=pc.allocation_id
       JOIN projects p ON p.id=a.project_id
       JOIN users u ON u.id=a.investor_id
       LEFT JOIN investor_profiles ip ON ip.user_id=u.id
       WHERE COALESCE(pc.status,'approved')='approved'`;
    if (allocationId) {
      params.push(allocationId);
      sql += ` AND pc.allocation_id=$${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY pc.approved_at DESC LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      ...mapProfitConfirmation(row),
      projectId: row.project_id,
      projectTitle: row.project_title,
      investorId: row.investor_id,
      investorEmail: row.investor_email,
      investorName: row.investor_name,
    }));
  }

  async #loadExitContext(client, allocationId) {
    const result = await client.query(
      `SELECT a.*, p.title AS project_title, p.minimum_exit_days, p.exit_policy,
              p.duration_days AS project_duration_days
       FROM allocations a
       JOIN projects p ON p.id=a.project_id
       WHERE a.id=$1
       FOR UPDATE OF a`,
      [allocationId],
    );
    if (!result.rowCount) {
      throw new DomainError('ALLOCATION_NOT_FOUND', 'Investment allocation was not found', 404);
    }
    return result.rows[0];
  }

  async #hasOpenExit(client, allocationId, excludeId = null) {
    const params = [allocationId, [...OPEN_EXIT_STATUSES]];
    let sql = `SELECT id FROM exit_requests WHERE allocation_id=$1 AND status = ANY($2::text[])`;
    if (excludeId) {
      params.push(excludeId);
      sql += ` AND id<>$${params.length}`;
    }
    sql += ' LIMIT 1';
    const result = await client.query(sql, params);
    return result.rowCount > 0;
  }

  async getExitEligibility(allocationId, actorId, { canViewAny = false } = {}) {
    const result = await this.pool.query(
      `SELECT a.*, p.minimum_exit_days, p.exit_policy,
              EXISTS(
                SELECT 1 FROM exit_requests er
                WHERE er.allocation_id=a.id AND er.status = ANY($2::text[])
              ) AS has_open_exit
       FROM allocations a
       JOIN projects p ON p.id=a.project_id
       WHERE a.id=$1`,
      [allocationId, [...OPEN_EXIT_STATUSES]],
    );
    if (!result.rowCount) throw new DomainError('ALLOCATION_NOT_FOUND', 'Investment allocation was not found', 404);
    const row = result.rows[0];
    if (!canViewAny && actorId && row.investor_id !== actorId) {
      throw new DomainError('FORBIDDEN', 'You can only check exit eligibility for your own share holdings', 403);
    }
    return {
      allocationId: row.id,
      projectId: row.project_id,
      exitPolicy: row.exit_policy || null,
      ...buildExitEligibilityPayload({
        allocationStatus: row.status,
        activatedAt: row.activated_at,
        projectMinimumExitDays: row.minimum_exit_days,
        investmentPoisha: Number(row.investment_poisha),
        hasOpenExit: row.has_open_exit,
      }),
    };
  }

  async submitExitRequest(allocationId, input, actorId, meta = {}) {
    const reason = optionalExitNote(input.reason ?? input.note, 'reason');
    const deductionPoisha = optionalNonNegativePoisha(input.deductionPoisha, 'deductionPoisha') ?? 0;
    const ctx = normalizeRequestContext(meta.requestContext);

    return withTransaction(this.pool, async (client) => {
      const alloc = await this.#loadExitContext(client, allocationId);
      if (alloc.investor_id !== actorId) {
        throw new DomainError('FORBIDDEN', 'You can only submit exit requests for your own share holdings', 403);
      }
      if (await this.#hasOpenExit(client, allocationId)) {
        throw new DomainError(
          'EXIT_ALREADY_OPEN',
          'An open exit request already exists for this share holding',
          409,
        );
      }
      const { minHoldDays, holdDaysElapsed } = assertExitEligibility({
        allocationStatus: alloc.status,
        activatedAt: alloc.activated_at,
        projectMinimumExitDays: alloc.minimum_exit_days,
      });
      const estimatedPayablePoisha = estimateExitPayablePoisha({
        investmentPoisha: Number(alloc.investment_poisha),
        deductionPoisha,
      });

      const insert = await client.query(
        `INSERT INTO exit_requests(
           allocation_id, investor_id, reason, status, requested_at,
           deduction_poisha, estimated_payable_poisha, min_hold_days, hold_days_elapsed, updated_at
         ) VALUES ($1,$2,$3,'submitted',now(),$4,$5,$6,$7,now())
         RETURNING *`,
        [allocationId, actorId, reason, deductionPoisha, estimatedPayablePoisha, minHoldDays, holdDaysElapsed],
      );
      await client.query(
        `UPDATE allocations SET status='exit_requested' WHERE id=$1 AND status IN ('active','matured')`,
        [allocationId],
      );
      const mapped = mapExitRequest(insert.rows[0]);
      await audit(
        client,
        actorId,
        'exit_request.submitted',
        'exit_request',
        mapped.id,
        {
          allocationId,
          minHoldDays,
          holdDaysElapsed,
          estimatedPayablePoisha,
          projectTitle: alloc.project_title,
        },
        { after: mapped, reason, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return {
        ...mapped,
        projectTitle: alloc.project_title,
        exitPolicy: alloc.exit_policy || null,
      };
    });
  }

  async listMyExitRequests(actorId, { canViewAny = false, investorId = null, allocationId = null, limit = 100 } = {}) {
    const params = [];
    let sql = `SELECT er.*, p.title AS project_title, p.exit_policy,
              a.investment_poisha, a.status AS allocation_status, a.units
       FROM exit_requests er
       JOIN allocations a ON a.id=er.allocation_id
       JOIN projects p ON p.id=a.project_id
       WHERE 1=1`;
    if (!canViewAny) {
      params.push(actorId);
      sql += ` AND er.investor_id=$${params.length}`;
    } else if (investorId) {
      params.push(investorId);
      sql += ` AND er.investor_id=$${params.length}`;
    }
    if (allocationId) {
      params.push(allocationId);
      sql += ` AND er.allocation_id=$${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY er.requested_at DESC LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      ...mapExitRequest(row),
      projectTitle: row.project_title,
      exitPolicy: row.exit_policy || null,
      allocationStatus: row.allocation_status,
      units: row.units,
      investmentPoisha: Number(row.investment_poisha),
    }));
  }

  async listExitRequestsForAllocation(allocationId, actorId, { canViewAny = false } = {}) {
    const alloc = await this.pool.query(`SELECT id, investor_id FROM allocations WHERE id=$1`, [allocationId]);
    if (!alloc.rowCount) throw new DomainError('ALLOCATION_NOT_FOUND', 'Investment allocation was not found', 404);
    if (!canViewAny && actorId && alloc.rows[0].investor_id !== actorId) {
      throw new DomainError('FORBIDDEN', 'You can only view exit requests for your own share holdings', 403);
    }
    return this.listMyExitRequests(actorId, {
      canViewAny: true,
      allocationId,
      limit: 100,
    });
  }

  async getExitRequest(exitRequestId, actorId, { canViewAny = false } = {}) {
    const result = await this.pool.query(
      `SELECT er.*, p.title AS project_title, p.exit_policy,
              a.investment_poisha, a.status AS allocation_status, a.units
       FROM exit_requests er
       JOIN allocations a ON a.id=er.allocation_id
       JOIN projects p ON p.id=a.project_id
       WHERE er.id=$1`,
      [exitRequestId],
    );
    if (!result.rowCount) throw new DomainError('EXIT_REQUEST_NOT_FOUND', 'Exit request was not found', 404);
    const row = result.rows[0];
    if (!canViewAny && actorId && row.investor_id !== actorId) {
      throw new DomainError('FORBIDDEN', 'You can only view your own exit requests', 403);
    }
    let exitPayment = null;
    if (row.payout_id) {
      const pay = await this.pool.query(`SELECT * FROM payouts WHERE id=$1`, [row.payout_id]);
      if (pay.rowCount) exitPayment = mapExitPayment(pay.rows[0]);
    }
    return {
      ...mapExitRequest(row),
      projectTitle: row.project_title,
      exitPolicy: row.exit_policy || null,
      allocationStatus: row.allocation_status,
      units: row.units,
      investmentPoisha: Number(row.investment_poisha),
      exitPayment,
    };
  }

  async cancelExitRequest(exitRequestId, actorId, meta = {}) {
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT er.*, a.status AS allocation_status
         FROM exit_requests er
         JOIN allocations a ON a.id=er.allocation_id
         WHERE er.id=$1
         FOR UPDATE OF er`,
        [exitRequestId],
      );
      if (!result.rowCount) throw new DomainError('EXIT_REQUEST_NOT_FOUND', 'Exit request was not found', 404);
      const row = result.rows[0];
      if (row.investor_id !== actorId) {
        throw new DomainError('FORBIDDEN', 'You can only cancel your own exit requests', 403);
      }
      if (!CANCELABLE_EXIT_STATUSES.includes(row.status)) {
        throw new DomainError(
          'EXIT_NOT_CANCELABLE',
          `Cannot cancel exit request in status ${row.status}`,
          409,
        );
      }
      const before = mapExitRequest(row);
      const updated = await client.query(
        `UPDATE exit_requests SET status='cancelled', updated_at=now(),
            decision_note=COALESCE(decision_note, 'Cancelled by investor')
         WHERE id=$1 RETURNING *`,
        [exitRequestId],
      );
      await client.query(
        `UPDATE allocations SET status='active'
         WHERE id=$1 AND status IN ('exit_requested','exit_processing')`,
        [row.allocation_id],
      );
      const mapped = mapExitRequest(updated.rows[0]);
      await audit(
        client,
        actorId,
        'exit_request.cancelled',
        'exit_request',
        exitRequestId,
        { allocationId: row.allocation_id },
        { before, after: mapped, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return mapped;
    });
  }

  async listAdminExitRequests({ status = null, limit = 100 } = {}) {
    const params = [];
    let sql = `SELECT er.*, p.title AS project_title, p.exit_policy,
              a.investment_poisha, a.status AS allocation_status, a.units,
              u.email AS investor_email,
              COALESCE(ip.full_name, u.email) AS investor_name
       FROM exit_requests er
       JOIN allocations a ON a.id=er.allocation_id
       JOIN projects p ON p.id=a.project_id
       JOIN users u ON u.id=er.investor_id
       LEFT JOIN investor_profiles ip ON ip.user_id=u.id
       WHERE 1=1`;
    if (status && status !== 'all') {
      params.push(String(status));
      sql += ` AND er.status=$${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY er.requested_at DESC LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      ...mapExitRequest(row),
      projectTitle: row.project_title,
      exitPolicy: row.exit_policy || null,
      allocationStatus: row.allocation_status,
      units: row.units,
      investmentPoisha: Number(row.investment_poisha),
      investorEmail: row.investor_email,
      investorName: row.investor_name,
    }));
  }

  async startExitReview(exitRequestId, actorId, meta = {}) {
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT * FROM exit_requests WHERE id=$1 FOR UPDATE`,
        [exitRequestId],
      );
      if (!result.rowCount) throw new DomainError('EXIT_REQUEST_NOT_FOUND', 'Exit request was not found', 404);
      const row = result.rows[0];
      if (!REVIEWABLE_EXIT_STATUSES.includes(row.status)) {
        throw new DomainError(
          'EXIT_NOT_REVIEWABLE',
          `Cannot start review from status ${row.status}`,
          409,
        );
      }
      const before = mapExitRequest(row);
      const updated = await client.query(
        `UPDATE exit_requests SET status='under_review', updated_at=now() WHERE id=$1 RETURNING *`,
        [exitRequestId],
      );
      await client.query(
        `UPDATE allocations SET status='exit_requested' WHERE id=$1 AND status='active'`,
        [row.allocation_id],
      );
      const mapped = mapExitRequest(updated.rows[0]);
      await audit(
        client,
        actorId,
        'exit_request.review_started',
        'exit_request',
        exitRequestId,
        { allocationId: row.allocation_id },
        { before, after: mapped, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return mapped;
    });
  }

  async approveExitRequest(exitRequestId, input, actorId, meta = {}) {
    const waitForLiquidity = Boolean(input.waitForLiquidity ?? input.awaitLiquidity);
    const liquidityNote = optionalExitNote(input.liquidityNote, 'liquidityNote');
    const decisionNote = optionalExitNote(input.decisionNote ?? input.note, 'decisionNote');
    const deductionPoisha = optionalNonNegativePoisha(input.deductionPoisha, 'deductionPoisha');
    const ctx = normalizeRequestContext(meta.requestContext);

    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT er.*, a.investment_poisha
         FROM exit_requests er
         JOIN allocations a ON a.id=er.allocation_id
         WHERE er.id=$1
         FOR UPDATE OF er`,
        [exitRequestId],
      );
      if (!result.rowCount) throw new DomainError('EXIT_REQUEST_NOT_FOUND', 'Exit request was not found', 404);
      const row = result.rows[0];
      if (!DECIDABLE_EXIT_STATUSES.includes(row.status)) {
        throw new DomainError(
          'EXIT_NOT_DECIDABLE',
          `Cannot approve exit request in status ${row.status}`,
          409,
        );
      }
      const nextStatus = waitForLiquidity
        ? EXIT_REQUEST_STATUS.APPROVED_WAITING_LIQUIDITY
        : EXIT_REQUEST_STATUS.APPROVED;
      const ded = deductionPoisha ?? (row.deduction_poisha == null ? 0 : Number(row.deduction_poisha));
      const estimatedPayablePoisha = estimateExitPayablePoisha({
        investmentPoisha: Number(row.investment_poisha),
        deductionPoisha: ded,
      });
      const before = mapExitRequest(row);
      const updated = await client.query(
        `UPDATE exit_requests SET
           status=$2,
           decided_by=$3,
           decided_at=now(),
           decision_note=$4,
           liquidity_note=$5,
           deduction_poisha=$6,
           estimated_payable_poisha=$7,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [exitRequestId, nextStatus, actorId, decisionNote, liquidityNote, ded, estimatedPayablePoisha],
      );
      await client.query(
        `UPDATE allocations SET status='exit_processing' WHERE id=$1`,
        [row.allocation_id],
      );
      const mapped = mapExitRequest(updated.rows[0]);
      await audit(
        client,
        actorId,
        'exit_request.approved',
        'exit_request',
        exitRequestId,
        {
          allocationId: row.allocation_id,
          waitForLiquidity,
          nextStatus,
          estimatedPayablePoisha,
        },
        {
          before,
          after: mapped,
          reason: decisionNote || liquidityNote,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      );
      return mapped;
    });
  }

  async rejectExitRequest(exitRequestId, input, actorId, meta = {}) {
    const reason = requireDecisionReason(input.reason ?? input.decisionNote, 'reason');
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT * FROM exit_requests WHERE id=$1 FOR UPDATE`,
        [exitRequestId],
      );
      if (!result.rowCount) throw new DomainError('EXIT_REQUEST_NOT_FOUND', 'Exit request was not found', 404);
      const row = result.rows[0];
      if (!DECIDABLE_EXIT_STATUSES.includes(row.status)) {
        throw new DomainError(
          'EXIT_NOT_DECIDABLE',
          `Cannot reject exit request in status ${row.status}`,
          409,
        );
      }
      const before = mapExitRequest(row);
      const updated = await client.query(
        `UPDATE exit_requests SET
           status='rejected',
           decided_by=$2,
           decided_at=now(),
           decision_note=$3,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [exitRequestId, actorId, reason],
      );
      await client.query(
        `UPDATE allocations SET status='active'
         WHERE id=$1 AND status IN ('exit_requested','exit_processing')`,
        [row.allocation_id],
      );
      const mapped = mapExitRequest(updated.rows[0]);
      await audit(
        client,
        actorId,
        'exit_request.rejected',
        'exit_request',
        exitRequestId,
        { allocationId: row.allocation_id },
        { before, after: mapped, reason, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return mapped;
    });
  }

  async completeExitRequest(exitRequestId, input, actorId, meta = {}) {
    const decisionNote = optionalExitNote(input.decisionNote ?? input.note, 'decisionNote');
    const amountOverride = optionalNonNegativePoisha(input.amountPoisha, 'amountPoisha');
    const ctx = normalizeRequestContext(meta.requestContext);

    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT er.*, a.investment_poisha, a.investor_id AS alloc_investor_id
         FROM exit_requests er
         JOIN allocations a ON a.id=er.allocation_id
         WHERE er.id=$1
         FOR UPDATE OF er`,
        [exitRequestId],
      );
      if (!result.rowCount) throw new DomainError('EXIT_REQUEST_NOT_FOUND', 'Exit request was not found', 404);
      const row = result.rows[0];
      if (!COMPLETABLE_EXIT_STATUSES.includes(row.status)) {
        throw new DomainError(
          'EXIT_NOT_COMPLETABLE',
          `Cannot complete exit request in status ${row.status}`,
          409,
        );
      }
      if (row.payout_id) {
        throw new DomainError('EXIT_PAYMENT_EXISTS', 'Exit payment record already exists for this request', 409);
      }
      const amountPoisha =
        amountOverride ??
        (row.estimated_payable_poisha == null
          ? estimateExitPayablePoisha({
              investmentPoisha: Number(row.investment_poisha),
              deductionPoisha: Number(row.deduction_poisha) || 0,
            })
          : Number(row.estimated_payable_poisha));
      if (!Number.isSafeInteger(amountPoisha) || amountPoisha <= 0) {
        throw new DomainError('INVALID_AMOUNT', 'Exit payment amountPoisha must be a positive integer', 400);
      }

      // Display-only Exit payment record — never moves funds / never sets paid.
      const payout = await client.query(
        `INSERT INTO payouts(
           allocation_id, investor_id, payout_type, amount_poisha, status,
           destination_reference, approved_by, approved_at, created_at
         ) VALUES ($1,$2,'early_exit',$3,'approved',$4,$5,now(),now())
         RETURNING *`,
        [
          row.allocation_id,
          row.investor_id,
          amountPoisha,
          `exit-request:${exitRequestId}:display-only`,
          actorId,
        ],
      );
      const before = mapExitRequest(row);
      const updated = await client.query(
        `UPDATE exit_requests SET
           status='completed',
           payout_id=$2,
           decided_by=COALESCE(decided_by,$3),
           decided_at=COALESCE(decided_at, now()),
           decision_note=COALESCE($4, decision_note),
           estimated_payable_poisha=$5,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [exitRequestId, payout.rows[0].id, actorId, decisionNote, amountPoisha],
      );
      await client.query(
        `UPDATE allocations SET status='exited' WHERE id=$1`,
        [row.allocation_id],
      );
      const mapped = mapExitRequest(updated.rows[0]);
      const exitPayment = mapExitPayment(payout.rows[0]);
      await audit(
        client,
        actorId,
        'exit_request.completed',
        'exit_request',
        exitRequestId,
        {
          allocationId: row.allocation_id,
          payoutId: exitPayment.id,
          amountPoisha,
          fundsMoved: false,
        },
        {
          before,
          after: { ...mapped, exitPayment },
          reason: decisionNote,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      );
      return { ...mapped, exitPayment, liquidityDisclaimer: LIQUIDITY_DISCLAIMER };
    });
  }

  // ---- Phase 7: Referral rewards ----

  async #getReferralRewardPoisha(client) {
    const q = client || this.pool;
    const result = await q.query(
      `SELECT value_json FROM platform_settings WHERE key='referral_reward_poisha' LIMIT 1`,
    );
    if (!result.rowCount) return DEFAULT_REFERRAL_REWARD_POISHA;
    return parseRewardPoishaSetting(result.rows[0].value_json);
  }

  async #ensureUserReferralCode(client, userId) {
    const existing = await client.query(`SELECT id, referral_code FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    if (!existing.rowCount) throw new DomainError('USER_NOT_FOUND', 'User was not found', 404);
    if (existing.rows[0].referral_code) return existing.rows[0].referral_code;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = generateReferralCode(userId);
      try {
        const updated = await client.query(
          `UPDATE users SET referral_code=$2, updated_at=now() WHERE id=$1 AND referral_code IS NULL RETURNING referral_code`,
          [userId, code],
        );
        if (updated.rowCount) return updated.rows[0].referral_code;
        const again = await client.query(`SELECT referral_code FROM users WHERE id=$1`, [userId]);
        if (again.rows[0]?.referral_code) return again.rows[0].referral_code;
      } catch (error) {
        if (error.code === '23505') continue;
        throw error;
      }
    }
    throw new DomainError('REFERRAL_CODE_ALLOCATION_FAILED', 'Unable to allocate a referral code', 500);
  }

  async #maybeMarkReferralEligible(client, { investorId, applicationId, actorId, requestContext }) {
    const referral = await client.query(
      `SELECT * FROM referrals WHERE referred_user_id=$1 LIMIT 1`,
      [investorId],
    );
    if (!referral.rowCount) return null;
    const ref = referral.rows[0];
    const existing = await client.query(
      `SELECT * FROM referral_rewards WHERE qualifying_application_id=$1 LIMIT 1`,
      [applicationId],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.status === REFERRAL_REWARD_STATUS.PENDING) {
        const rewardPoisha = await this.#getReferralRewardPoisha(client);
        const updated = await client.query(
          `UPDATE referral_rewards
           SET status='eligible', eligible_at=now(), reward_poisha=$2, updated_at=now()
           WHERE id=$1 AND status='pending'
           RETURNING *`,
          [row.id, rewardPoisha],
        );
        if (updated.rowCount) {
          const mapped = mapReferralReward(updated.rows[0]);
          await audit(
            client,
            actorId,
            'referral_reward.eligible',
            'referral_reward',
            mapped.id,
            { referralId: ref.id, applicationId, rewardPoisha },
            { after: mapped, ip: requestContext?.ip, userAgent: requestContext?.userAgent },
          );
          return mapped;
        }
      }
      return mapReferralReward(row);
    }
    const rewardPoisha = await this.#getReferralRewardPoisha(client);
    const inserted = await client.query(
      `INSERT INTO referral_rewards(
         referral_id, qualifying_application_id, reward_poisha, status, eligible_at, created_at, updated_at
       ) VALUES ($1,$2,$3,'eligible',now(),now(),now())
       RETURNING *`,
      [ref.id, applicationId, rewardPoisha],
    );
    const mapped = mapReferralReward(inserted.rows[0]);
    await audit(
      client,
      actorId,
      'referral_reward.eligible',
      'referral_reward',
      mapped.id,
      { referralId: ref.id, applicationId, rewardPoisha, qualifyingState: 'allocation_active' },
      { after: mapped, ip: requestContext?.ip, userAgent: requestContext?.userAgent },
    );
    return mapped;
  }

  async getMyReferralDashboard(actorId) {
    return withTransaction(this.pool, async (client) => {
      const code = await this.#ensureUserReferralCode(client, actorId);
      const rewardPoisha = await this.#getReferralRewardPoisha(client);
      const referred = await client.query(
        `SELECT r.*,
                u.email AS referred_email,
                COALESCE(ip.full_name, u.email) AS referred_name,
                rr.id AS reward_id,
                rr.status AS reward_status,
                rr.reward_poisha,
                rr.eligible_at,
                rr.qualifying_application_id
         FROM referrals r
         JOIN users u ON u.id=r.referred_user_id
         LEFT JOIN investor_profiles ip ON ip.user_id=u.id
         LEFT JOIN LATERAL (
           SELECT * FROM referral_rewards rr2
           WHERE rr2.referral_id=r.id
           ORDER BY rr2.created_at DESC
           LIMIT 1
         ) rr ON true
         WHERE r.referrer_id=$1
         ORDER BY r.created_at DESC
         LIMIT 200`,
        [actorId],
      );
      const rewards = await client.query(
        `SELECT rr.*
         FROM referral_rewards rr
         JOIN referrals r ON r.id=rr.referral_id
         WHERE r.referrer_id=$1
         ORDER BY rr.created_at DESC
         LIMIT 200`,
        [actorId],
      );
      const asReferred = await client.query(
        `SELECT r.*, u.referral_code AS referrer_code
         FROM referrals r
         JOIN users u ON u.id=r.referrer_id
         WHERE r.referred_user_id=$1
         LIMIT 1`,
        [actorId],
      );
      return {
        myReferralCode: code,
        fixedRewardPoisha: rewardPoisha,
        fundingDisclaimer: REFERRAL_FUNDING_DISCLAIMER,
        singleLevelOnly: true,
        qualifyingRule: 'eligible_when_referred_investor_allocation_active_after_payment_verified',
        attachedAsReferred: asReferred.rowCount
          ? {
              ...mapReferral(asReferred.rows[0]),
              referrerCode: asReferred.rows[0].referrer_code || null,
            }
          : null,
        referred: referred.rows.map((row) => ({
          ...mapReferral(row),
          referredEmailMasked: maskEmail(row.referred_email),
          referredNameMasked: row.referred_name
            ? `${String(row.referred_name).trim().split(/\s+/)[0]} ***`
            : null,
          // Full email/name intentionally omitted for referrer privacy.
          reward: row.reward_id
            ? {
                id: row.reward_id,
                status: row.reward_status,
                rewardPoisha: row.reward_poisha == null ? null : Number(row.reward_poisha),
                eligibleAt: row.eligible_at || null,
                qualifyingApplicationId: row.qualifying_application_id || null,
              }
            : null,
        })),
        rewards: rewards.rows.map(mapReferralReward),
        payoutEnabled: false,
      };
    });
  }

  async attachReferralCode(actorId, input, meta = {}) {
    const code = normalizeReferralCode(input.referralCode ?? input.code);
    if (!code) throw new DomainError('REFERRAL_CODE_REQUIRED', 'referralCode is required', 400);
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query(
        `SELECT id FROM referrals WHERE referred_user_id=$1 LIMIT 1`,
        [actorId],
      );
      if (existing.rowCount) {
        throw new DomainError('ALREADY_REFERRED', 'This account is already linked to a referral', 409);
      }
      const referrer = await client.query(
        `SELECT id, referral_code, email, mobile FROM users WHERE referral_code=$1 LIMIT 1`,
        [code],
      );
      if (!referrer.rowCount) {
        throw new DomainError('REFERRAL_CODE_NOT_FOUND', 'Referral code was not found', 404);
      }
      const referrerId = referrer.rows[0].id;
      assertNotSelfReferral(referrerId, actorId);

      const me = await client.query(`SELECT email, mobile FROM users WHERE id=$1`, [actorId]);
      if (!me.rowCount) throw new DomainError('USER_NOT_FOUND', 'User was not found', 404);
      // Duplicate identity guard when email/mobile match referrer (should already be unique, but double-check)
      if (
        (me.rows[0].email && me.rows[0].email === referrer.rows[0].email) ||
        (me.rows[0].mobile && me.rows[0].mobile === referrer.rows[0].mobile)
      ) {
        throw new DomainError('DUPLICATE_IDENTITY', 'Referral blocked due to matching identity data', 409);
      }

      let inserted;
      try {
        inserted = await client.query(
          `INSERT INTO referrals(referrer_id, referred_user_id, referral_code, created_at)
           VALUES ($1,$2,$3,now()) RETURNING *`,
          [referrerId, actorId, code],
        );
      } catch (error) {
        if (error.code === '23505') {
          throw new DomainError('ALREADY_REFERRED', 'This account is already linked to a referral', 409);
        }
        if (error.code === '23514') {
          throw new DomainError('SELF_REFERRAL_FORBIDDEN', 'You cannot refer yourself', 409);
        }
        throw error;
      }
      const mapped = mapReferral(inserted.rows[0]);
      await audit(
        client,
        actorId,
        'referral.attached',
        'referral',
        mapped.id,
        { referrerId, referralCode: code },
        { after: mapped, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return {
        ...mapped,
        fundingDisclaimer: REFERRAL_FUNDING_DISCLAIMER,
      };
    });
  }

  /** Used by AuthService during register when referralCode is supplied. */
  async attachReferralCodeWithClient(client, actorId, referralCode, meta = {}) {
    const code = normalizeReferralCode(referralCode);
    if (!code) return null;
    const ctx = normalizeRequestContext(meta.requestContext);
    const existing = await client.query(
      `SELECT id FROM referrals WHERE referred_user_id=$1 LIMIT 1`,
      [actorId],
    );
    if (existing.rowCount) {
      throw new DomainError('ALREADY_REFERRED', 'This account is already linked to a referral', 409);
    }
    const referrer = await client.query(
      `SELECT id, email, mobile FROM users WHERE referral_code=$1 LIMIT 1`,
      [code],
    );
    if (!referrer.rowCount) {
      throw new DomainError('REFERRAL_CODE_NOT_FOUND', 'Referral code was not found', 404);
    }
    assertNotSelfReferral(referrer.rows[0].id, actorId);
    const inserted = await client.query(
      `INSERT INTO referrals(referrer_id, referred_user_id, referral_code, created_at)
       VALUES ($1,$2,$3,now()) RETURNING *`,
      [referrer.rows[0].id, actorId, code],
    );
    const mapped = mapReferral(inserted.rows[0]);
    await audit(
      client,
      actorId,
      'referral.attached',
      'referral',
      mapped.id,
      { referrerId: referrer.rows[0].id, referralCode: code, via: 'register' },
      { after: mapped, ip: ctx.ip, userAgent: ctx.userAgent },
    );
    return mapped;
  }

  async ensureMyReferralCode(actorId) {
    return withTransaction(this.pool, async (client) => {
      const code = await this.#ensureUserReferralCode(client, actorId);
      return {
        myReferralCode: code,
        fundingDisclaimer: REFERRAL_FUNDING_DISCLAIMER,
        fixedRewardPoisha: await this.#getReferralRewardPoisha(client),
      };
    });
  }

  async getReferralSettings() {
    const rewardPoisha = await this.#getReferralRewardPoisha(this.pool);
    return {
      referralRewardPoisha: rewardPoisha,
      fundingDisclaimer: REFERRAL_FUNDING_DISCLAIMER,
      singleLevelOnly: true,
      qualifyingRule: 'eligible_when_referred_investor_allocation_active_after_payment_verified',
      payoutEnabled: false,
    };
  }

  async updateReferralSettings(input, actorId, meta = {}) {
    const rewardPoisha = requirePositiveRewardPoisha(
      input.referralRewardPoisha ?? input.rewardPoisha,
      'referralRewardPoisha',
    );
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const before = await this.#getReferralRewardPoisha(client);
      await client.query(
        `INSERT INTO platform_settings(key, value_json, updated_at, updated_by)
         VALUES ('referral_reward_poisha', $1::jsonb, now(), $2)
         ON CONFLICT (key) DO UPDATE
           SET value_json=EXCLUDED.value_json, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [JSON.stringify(rewardPoisha), actorId],
      );
      const after = { referralRewardPoisha: rewardPoisha };
      await audit(
        client,
        actorId,
        'referral_settings.updated',
        'platform_settings',
        'referral_reward_poisha',
        { before: before, after: rewardPoisha },
        { after, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return {
        referralRewardPoisha: rewardPoisha,
        fundingDisclaimer: REFERRAL_FUNDING_DISCLAIMER,
        singleLevelOnly: true,
        payoutEnabled: false,
      };
    });
  }

  async listAdminReferralRewards({ status = null, limit = 100 } = {}) {
    const params = [];
    let sql = `SELECT rr.*,
              r.referrer_id, r.referred_user_id, r.referral_code,
              ru.email AS referrer_email,
              COALESCE(rip.full_name, ru.email) AS referrer_name,
              du.email AS referred_email,
              COALESCE(dip.full_name, du.email) AS referred_name
       FROM referral_rewards rr
       JOIN referrals r ON r.id=rr.referral_id
       JOIN users ru ON ru.id=r.referrer_id
       LEFT JOIN investor_profiles rip ON rip.user_id=ru.id
       JOIN users du ON du.id=r.referred_user_id
       LEFT JOIN investor_profiles dip ON dip.user_id=du.id
       WHERE 1=1`;
    if (status) {
      params.push(status);
      sql += ` AND rr.status=$${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY rr.created_at DESC LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      ...mapReferralReward(row),
      referrerId: row.referrer_id,
      referredUserId: row.referred_user_id,
      referralCode: row.referral_code,
      referrerEmail: row.referrer_email || null,
      referrerName: row.referrer_name || null,
      referredEmail: row.referred_email || null,
      referredName: row.referred_name || null,
    }));
  }

  async getReferralReward(rewardId, actorId, { canViewAny = false } = {}) {
    const result = await this.pool.query(
      `SELECT rr.*, r.referrer_id, r.referred_user_id, r.referral_code
       FROM referral_rewards rr
       JOIN referrals r ON r.id=rr.referral_id
       WHERE rr.id=$1`,
      [rewardId],
    );
    if (!result.rowCount) throw new DomainError('REFERRAL_REWARD_NOT_FOUND', 'Referral reward was not found', 404);
    const row = result.rows[0];
    if (!canViewAny && actorId && row.referrer_id !== actorId) {
      throw new DomainError('FORBIDDEN', 'You can only view your own referral rewards', 403);
    }
    let payout = null;
    if (row.payout_id) {
      const pay = await this.pool.query(`SELECT * FROM payouts WHERE id=$1`, [row.payout_id]);
      if (pay.rowCount) payout = mapReferralPayout(pay.rows[0]);
    }
    return {
      ...mapReferralReward(row),
      referrerId: row.referrer_id,
      referredUserId: row.referred_user_id,
      referralCode: row.referral_code,
      payout,
    };
  }

  async approveReferralReward(rewardId, input, actorId, meta = {}) {
    const note = optionalReferralNote(input.decisionNote ?? input.note, 'decisionNote');
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT rr.*, r.referrer_id, r.referred_user_id
         FROM referral_rewards rr
         JOIN referrals r ON r.id=rr.referral_id
         WHERE rr.id=$1
         FOR UPDATE OF rr`,
        [rewardId],
      );
      if (!result.rowCount) throw new DomainError('REFERRAL_REWARD_NOT_FOUND', 'Referral reward was not found', 404);
      const row = result.rows[0];
      if (!APPROVABLE_REWARD_STATUSES.includes(row.status)) {
        throw new DomainError(
          'REWARD_NOT_APPROVABLE',
          `Cannot approve referral reward in status ${row.status}`,
          409,
        );
      }
      if (row.payout_id) {
        throw new DomainError('REFERRAL_PAYOUT_EXISTS', 'Display-only payout already exists for this reward', 409);
      }
      const amountPoisha = Number(row.reward_poisha);
      // Display-only Referral reward payout — never moves funds / never sets paid.
      const payout = await client.query(
        `INSERT INTO payouts(
           allocation_id, investor_id, payout_type, amount_poisha, status,
           destination_reference, approved_by, approved_at, created_at
         ) VALUES (NULL,$1,'referral_reward',$2,'approved',$3,$4,now(),now())
         RETURNING *`,
        [row.referrer_id, amountPoisha, `referral-reward:${rewardId}:display-only`, actorId],
      );
      const before = mapReferralReward(row);
      const updated = await client.query(
        `UPDATE referral_rewards SET
           status='approved',
           approved_by=$2,
           approved_at=now(),
           decided_by=$2,
           payout_id=$3,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [rewardId, actorId, payout.rows[0].id],
      );
      const mapped = mapReferralReward(updated.rows[0]);
      const payoutMapped = mapReferralPayout(payout.rows[0]);
      await audit(
        client,
        actorId,
        'referral_reward.approved',
        'referral_reward',
        rewardId,
        {
          payoutId: payoutMapped.id,
          amountPoisha,
          fundsMoved: false,
          funding: 'platform_marketing_admin_revenue',
        },
        {
          before,
          after: { ...mapped, payout: payoutMapped },
          reason: note,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      );
      return {
        ...mapped,
        referrerId: row.referrer_id,
        referredUserId: row.referred_user_id,
        payout: payoutMapped,
        fundingDisclaimer: REFERRAL_FUNDING_DISCLAIMER,
      };
    });
  }

  async rejectReferralReward(rewardId, input, actorId, meta = {}) {
    const reason = requireReferralReason(input.reason ?? input.rejectionReason, 'reason');
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT rr.*, r.referrer_id, r.referred_user_id
         FROM referral_rewards rr
         JOIN referrals r ON r.id=rr.referral_id
         WHERE rr.id=$1
         FOR UPDATE OF rr`,
        [rewardId],
      );
      if (!result.rowCount) throw new DomainError('REFERRAL_REWARD_NOT_FOUND', 'Referral reward was not found', 404);
      const row = result.rows[0];
      if (!REJECTABLE_REWARD_STATUSES.includes(row.status)) {
        throw new DomainError(
          'REWARD_NOT_REJECTABLE',
          `Cannot reject referral reward in status ${row.status}`,
          409,
        );
      }
      const before = mapReferralReward(row);
      const updated = await client.query(
        `UPDATE referral_rewards SET
           status='rejected',
           rejection_reason=$2,
           decided_by=$3,
           rejected_at=now(),
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [rewardId, reason, actorId],
      );
      const mapped = mapReferralReward(updated.rows[0]);
      await audit(
        client,
        actorId,
        'referral_reward.rejected',
        'referral_reward',
        rewardId,
        { reason },
        { before, after: mapped, reason, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return { ...mapped, referrerId: row.referrer_id, referredUserId: row.referred_user_id };
    });
  }

  async reverseReferralReward(rewardId, input, actorId, meta = {}) {
    const reason = requireReferralReason(input.reason ?? input.rejectionReason, 'reason');
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT rr.*, r.referrer_id, r.referred_user_id
         FROM referral_rewards rr
         JOIN referrals r ON r.id=rr.referral_id
         WHERE rr.id=$1
         FOR UPDATE OF rr`,
        [rewardId],
      );
      if (!result.rowCount) throw new DomainError('REFERRAL_REWARD_NOT_FOUND', 'Referral reward was not found', 404);
      const row = result.rows[0];
      if (!REVERSIBLE_REWARD_STATUSES.includes(row.status)) {
        throw new DomainError(
          'REWARD_NOT_REVERSIBLE',
          `Cannot reverse referral reward in status ${row.status}`,
          409,
        );
      }
      if (row.payout_id) {
        await client.query(
          `UPDATE payouts SET status='reversed' WHERE id=$1 AND status IN ('created','approved')`,
          [row.payout_id],
        );
      }
      const before = mapReferralReward(row);
      const updated = await client.query(
        `UPDATE referral_rewards SET
           status='reversed',
           rejection_reason=$2,
           decided_by=$3,
           reversed_at=now(),
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [rewardId, reason, actorId],
      );
      const mapped = mapReferralReward(updated.rows[0]);
      await audit(
        client,
        actorId,
        'referral_reward.reversed',
        'referral_reward',
        rewardId,
        { reason, fundsMoved: false },
        { before, after: mapped, reason, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return { ...mapped, referrerId: row.referrer_id, referredUserId: row.referred_user_id };
    });
  }


  // ---- Phase 8: Performance reports + Available payable + audit visibility ----

  async submitPerformanceReport(projectId, input, ownerUserId, meta = {}) {
    const { periodStart, periodEnd } = parseReportPeriod(input);
    const revenuePoisha = requireNonNegativePoisha(input.revenuePoisha, 'revenuePoisha');
    const expensePoisha = requireNonNegativePoisha(input.expensePoisha, 'expensePoisha');
    const actualProfitPoisha = computeActualProfitPoisha(revenuePoisha, expensePoisha);
    const supportingDocumentKey = optionalSupportingDocumentKey(input.supportingDocumentKey);
    const reviewNote = optionalReportNote(input.notes ?? input.reviewNote, 'notes');
    const ctx = normalizeRequestContext(meta.requestContext);

    return withTransaction(this.pool, async (client) => {
      const project = await client.query(
        `SELECT p.id, p.title, p.project_code, p.status, b.owner_user_id
         FROM projects p
         JOIN businesses b ON b.id=p.business_id
         WHERE p.id=$1
         FOR UPDATE OF p`,
        [projectId],
      );
      if (!project.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
      const p = project.rows[0];
      if (p.owner_user_id !== ownerUserId) {
        throw new DomainError('FORBIDDEN', 'You can only submit performance reports for your own projects', 403);
      }

      const insert = await client.query(
        `INSERT INTO performance_reports(
           project_id, period_start, period_end, revenue_poisha, expense_poisha,
           actual_profit_poisha, supporting_document_key, status, submitted_by,
           submitted_at, review_note, updated_at
         ) VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,'submitted',$8,now(),$9,now())
         ON CONFLICT (project_id, period_start, period_end) DO NOTHING
         RETURNING *`,
        [
          projectId,
          periodStart,
          periodEnd,
          revenuePoisha,
          expensePoisha,
          actualProfitPoisha,
          supportingDocumentKey,
          ownerUserId,
          reviewNote,
        ],
      );
      if (!insert.rowCount) {
        throw new DomainError(
          'DUPLICATE_REPORT_PERIOD',
          'A performance report already exists for this project and period',
          409,
        );
      }
      const mapped = mapPerformanceReport({
        ...insert.rows[0],
        project_title: p.title,
        project_code: p.project_code,
      });
      await audit(
        client,
        ownerUserId,
        'performance_report.submitted',
        'performance_report',
        mapped.id,
        { projectId, periodStart, periodEnd, revenuePoisha, expensePoisha, actualProfitPoisha },
        { after: mapped, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return mapped;
    });
  }

  async listOwnerPerformanceReports(ownerUserId, { projectId = null, status = null, limit = 100 } = {}) {
    const params = [ownerUserId];
    let sql = `SELECT pr.*, p.title AS project_title, p.project_code
       FROM performance_reports pr
       JOIN projects p ON p.id=pr.project_id
       JOIN businesses b ON b.id=p.business_id
       WHERE b.owner_user_id=$1`;
    if (projectId) {
      params.push(projectId);
      sql += ` AND pr.project_id=$${params.length}`;
    }
    if (status) {
      params.push(status);
      sql += ` AND pr.status=$${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY pr.submitted_at DESC LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapPerformanceReport);
  }

  async listAdminPerformanceReports({ status = null, projectId = null, limit = 100 } = {}) {
    const params = [];
    let sql = `SELECT pr.*, p.title AS project_title, p.project_code
       FROM performance_reports pr
       JOIN projects p ON p.id=pr.project_id
       WHERE 1=1`;
    if (status) {
      params.push(status);
      sql += ` AND pr.status=$${params.length}`;
    }
    if (projectId) {
      params.push(projectId);
      sql += ` AND pr.project_id=$${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY pr.submitted_at DESC LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapPerformanceReport);
  }

  async getPerformanceReport(reportId, actorId, { canViewAny = false, ownerOnly = false } = {}) {
    const result = await this.pool.query(
      `SELECT pr.*, p.title AS project_title, p.project_code, b.owner_user_id
       FROM performance_reports pr
       JOIN projects p ON p.id=pr.project_id
       JOIN businesses b ON b.id=p.business_id
       WHERE pr.id=$1`,
      [reportId],
    );
    if (!result.rowCount) throw new DomainError('PERFORMANCE_REPORT_NOT_FOUND', 'Performance report was not found', 404);
    const row = result.rows[0];
    if (!canViewAny) {
      if (row.owner_user_id !== actorId && row.submitted_by !== actorId) {
        throw new DomainError('FORBIDDEN', 'You can only view performance reports for your own projects', 403);
      }
    }
    return mapPerformanceReport(row);
  }

  async startPerformanceReportReview(reportId, input, actorId, meta = {}) {
    const note = optionalReportNote(input.reviewNote ?? input.notes, 'reviewNote');
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT pr.*, p.title AS project_title, p.project_code
         FROM performance_reports pr
         JOIN projects p ON p.id=pr.project_id
         WHERE pr.id=$1
         FOR UPDATE OF pr`,
        [reportId],
      );
      if (!result.rowCount) throw new DomainError('PERFORMANCE_REPORT_NOT_FOUND', 'Performance report was not found', 404);
      const row = result.rows[0];
      if (row.status !== PERFORMANCE_REPORT_STATUS.SUBMITTED && row.status !== PERFORMANCE_REPORT_STATUS.UNDER_REVIEW) {
        throw new DomainError(
          'REPORT_NOT_REVIEWABLE',
          `Cannot start review for performance report in status ${row.status}`,
          409,
        );
      }
      const before = mapPerformanceReport(row);
      const updated = await client.query(
        `UPDATE performance_reports SET
           status='under_review',
           under_review_at=COALESCE(under_review_at, now()),
           review_note=COALESCE($2, review_note),
           decided_by=$3,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [reportId, note, actorId],
      );
      const mapped = mapPerformanceReport({
        ...updated.rows[0],
        project_title: row.project_title,
        project_code: row.project_code,
      });
      await audit(
        client,
        actorId,
        'performance_report.under_review',
        'performance_report',
        reportId,
        { status: mapped.status },
        { before, after: mapped, reason: note, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return mapped;
    });
  }

  async #generateDistributionsFromReport(client, reportRow, actorId, ctx) {
    const actual = Number(reportRow.actual_profit_poisha);
    if (actual < 0) {
      throw new DomainError(
        'NEGATIVE_PROFIT',
        'Cannot generate Approved distributions from a negative actual profit',
        409,
      );
    }
    const allocs = await client.query(
      `SELECT id, investment_poisha, status, investor_id
       FROM allocations
       WHERE project_id=$1 AND status IN ('active','matured')
       ORDER BY id ASC
       FOR UPDATE`,
      [reportRow.project_id],
    );
    const shares = proRataByInvestmentPoisha(allocs.rows, actual);
    const periodStart =
      reportRow.period_start instanceof Date
        ? reportRow.period_start.toISOString().slice(0, 10)
        : String(reportRow.period_start).slice(0, 10);
    const periodEnd =
      reportRow.period_end instanceof Date
        ? reportRow.period_end.toISOString().slice(0, 10)
        : String(reportRow.period_end).slice(0, 10);

    const created = [];
    const skipped = [];
    for (const share of shares) {
      const insert = await client.query(
        `INSERT INTO profit_confirmations(
           allocation_id, period_start, period_end, confirmed_profit_poisha,
           approved_by, approved_at, source_report_id, notes, declaration_note,
           status, available_payable_poisha, created_at
         ) VALUES ($1,$2::date,$3::date,$4,$5,now(),$6,$7,$8,'approved',$4,now())
         ON CONFLICT (allocation_id, period_start, period_end) DO NOTHING
         RETURNING *`,
        [
          share.allocationId,
          periodStart,
          periodEnd,
          share.confirmedProfitPoisha,
          actorId,
          reportRow.id,
          'Generated from approved performance report',
          `source_report_id=${reportRow.id}; rule=pro-rata-by-investment_poisha`,
        ],
      );
      if (insert.rowCount) {
        created.push(mapProfitConfirmation(insert.rows[0]));
      } else {
        skipped.push({ allocationId: share.allocationId, reason: 'duplicate_period' });
      }
    }

    await client.query(
      `UPDATE performance_reports SET
         distributions_generated_at=now(),
         distributions_generated_count=COALESCE(distributions_generated_count,0) + $2,
         updated_at=now()
       WHERE id=$1`,
      [reportRow.id, created.length],
    );

    await audit(
      client,
      actorId,
      'performance_report.generate_confirmations',
      'performance_report',
      reportRow.id,
      {
        createdCount: created.length,
        skippedCount: skipped.length,
        distributionRule: DISTRIBUTION_RULE,
        actualProfitPoisha: actual,
      },
      {
        after: { created, skipped },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    );

    return { created, skipped, distributionRule: DISTRIBUTION_RULE };
  }

  async approvePerformanceReport(reportId, input, actorId, meta = {}) {
    const note = optionalReportNote(input.reviewNote ?? input.notes ?? input.decisionNote, 'reviewNote');
    const generate =
      input.generateDistributions === undefined || input.generateDistributions === null
        ? true
        : Boolean(input.generateDistributions);
    const ctx = normalizeRequestContext(meta.requestContext);

    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT pr.*, p.title AS project_title, p.project_code
         FROM performance_reports pr
         JOIN projects p ON p.id=pr.project_id
         WHERE pr.id=$1
         FOR UPDATE OF pr`,
        [reportId],
      );
      if (!result.rowCount) throw new DomainError('PERFORMANCE_REPORT_NOT_FOUND', 'Performance report was not found', 404);
      const row = result.rows[0];
      if (!REPORT_APPROVABLE_STATUSES.includes(row.status)) {
        throw new DomainError(
          'REPORT_NOT_APPROVABLE',
          `Cannot approve performance report in status ${row.status}`,
          409,
        );
      }
      const before = mapPerformanceReport(row);
      const updated = await client.query(
        `UPDATE performance_reports SET
           status='approved',
           approved_by=$2,
           approved_at=now(),
           decided_by=$2,
           review_note=COALESCE($3, review_note),
           rejection_reason=NULL,
           rejected_at=NULL,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [reportId, actorId, note],
      );
      const reportRow = {
        ...updated.rows[0],
        project_title: row.project_title,
        project_code: row.project_code,
      };
      const mapped = mapPerformanceReport(reportRow);
      await audit(
        client,
        actorId,
        'performance_report.approved',
        'performance_report',
        reportId,
        { generateDistributions: generate },
        { before, after: mapped, reason: note, ip: ctx.ip, userAgent: ctx.userAgent },
      );

      let distributions = null;
      if (generate) {
        distributions = await this.#generateDistributionsFromReport(client, reportRow, actorId, ctx);
        const refreshed = await client.query(
          `SELECT pr.*, p.title AS project_title, p.project_code
           FROM performance_reports pr JOIN projects p ON p.id=pr.project_id WHERE pr.id=$1`,
          [reportId],
        );
        return {
          report: mapPerformanceReport(refreshed.rows[0]),
          distributions,
          payoutEnabled: false,
          fundsMoved: false,
        };
      }
      return { report: mapped, distributions: null, payoutEnabled: false, fundsMoved: false };
    });
  }

  async rejectPerformanceReport(reportId, input, actorId, meta = {}) {
    const reason = requireRejectionReason(input.reason ?? input.rejectionReason);
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT pr.*, p.title AS project_title, p.project_code
         FROM performance_reports pr
         JOIN projects p ON p.id=pr.project_id
         WHERE pr.id=$1
         FOR UPDATE OF pr`,
        [reportId],
      );
      if (!result.rowCount) throw new DomainError('PERFORMANCE_REPORT_NOT_FOUND', 'Performance report was not found', 404);
      const row = result.rows[0];
      if (!REPORT_REJECTABLE_STATUSES.includes(row.status)) {
        throw new DomainError(
          'REPORT_NOT_REJECTABLE',
          `Cannot reject performance report in status ${row.status}`,
          409,
        );
      }
      const before = mapPerformanceReport(row);
      const updated = await client.query(
        `UPDATE performance_reports SET
           status='rejected',
           rejection_reason=$2,
           rejected_at=now(),
           decided_by=$3,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [reportId, reason, actorId],
      );
      const mapped = mapPerformanceReport({
        ...updated.rows[0],
        project_title: row.project_title,
        project_code: row.project_code,
      });
      await audit(
        client,
        actorId,
        'performance_report.rejected',
        'performance_report',
        reportId,
        { reason },
        { before, after: mapped, reason, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return mapped;
    });
  }

  async generateDistributionsFromPerformanceReport(reportId, actorId, meta = {}) {
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT pr.*, p.title AS project_title, p.project_code
         FROM performance_reports pr
         JOIN projects p ON p.id=pr.project_id
         WHERE pr.id=$1
         FOR UPDATE OF pr`,
        [reportId],
      );
      if (!result.rowCount) throw new DomainError('PERFORMANCE_REPORT_NOT_FOUND', 'Performance report was not found', 404);
      const row = result.rows[0];
      if (row.status !== PERFORMANCE_REPORT_STATUS.APPROVED) {
        throw new DomainError(
          'REPORT_NOT_APPROVED',
          'Generate Approved distributions only after the performance report is approved',
          409,
        );
      }
      const distributions = await this.#generateDistributionsFromReport(client, row, actorId, ctx);
      const refreshed = await client.query(
        `SELECT pr.*, p.title AS project_title, p.project_code
         FROM performance_reports pr JOIN projects p ON p.id=pr.project_id WHERE pr.id=$1`,
        [reportId],
      );
      return {
        report: mapPerformanceReport(refreshed.rows[0]),
        distributions,
        payoutEnabled: false,
        fundsMoved: false,
      };
    });
  }

  async getInvestorAvailablePayable(investorId) {
    const profit = await this.pool.query(
      `SELECT COALESCE(SUM(pc.available_payable_poisha),0)::bigint AS total
       FROM profit_confirmations pc
       JOIN allocations a ON a.id=pc.allocation_id
       WHERE a.investor_id=$1
         AND COALESCE(pc.status,'approved')='approved'`,
      [investorId],
    );
    const payouts = await this.pool.query(
      `SELECT COALESCE(SUM(amount_poisha),0)::bigint AS total
       FROM payouts
       WHERE investor_id=$1
         AND status='approved'
         AND payout_type IN ('referral_reward','early_exit')
         AND paid_at IS NULL`,
      [investorId],
    );
    const fromApprovedDistributions = Number(profit.rows[0].total);
    const fromDisplayPayouts = Number(payouts.rows[0].total);
    const total = fromApprovedDistributions + fromDisplayPayouts;

    const breakdownProfit = await this.pool.query(
      `SELECT pc.id, pc.allocation_id, pc.confirmed_profit_poisha, pc.available_payable_poisha,
              pc.period_start, pc.period_end, p.title AS project_title
       FROM profit_confirmations pc
       JOIN allocations a ON a.id=pc.allocation_id
       JOIN projects p ON p.id=a.project_id
       WHERE a.investor_id=$1 AND COALESCE(pc.status,'approved')='approved'
       ORDER BY pc.approved_at DESC
       LIMIT 100`,
      [investorId],
    );
    const breakdownPayouts = await this.pool.query(
      `SELECT id, payout_type, amount_poisha, status, created_at, approved_at
       FROM payouts
       WHERE investor_id=$1
         AND status='approved'
         AND payout_type IN ('referral_reward','early_exit')
         AND paid_at IS NULL
       ORDER BY created_at DESC
       LIMIT 100`,
      [investorId],
    );

    return {
      availablePayablePoisha: total,
      fromApprovedDistributionsPoisha: fromApprovedDistributions,
      fromApprovedDisplayPayoutsPoisha: fromDisplayPayouts,
      payoutEnabled: false,
      fundsMoved: false,
      withdrawable: false,
      isWallet: false,
      label: 'Available payable amount',
      disclaimer: AVAILABLE_PAYABLE_DISCLAIMER,
      projectionsNeverCount: true,
      approvedDistributions: breakdownProfit.rows.map((r) => ({
        id: r.id,
        allocationId: r.allocation_id,
        projectTitle: r.project_title,
        confirmedProfitPoisha: Number(r.confirmed_profit_poisha),
        availablePayablePoisha: Number(r.available_payable_poisha ?? r.confirmed_profit_poisha),
        periodStart:
          r.period_start instanceof Date
            ? r.period_start.toISOString().slice(0, 10)
            : String(r.period_start).slice(0, 10),
        periodEnd:
          r.period_end instanceof Date
            ? r.period_end.toISOString().slice(0, 10)
            : String(r.period_end).slice(0, 10),
        source: 'approved_distribution',
      })),
      approvedDisplayPayouts: breakdownPayouts.rows.map((r) => ({
        id: r.id,
        payoutType: r.payout_type,
        amountPoisha: Number(r.amount_poisha),
        status: r.status,
        fundsMoved: false,
        payoutEnabled: false,
        label: r.payout_type === 'referral_reward' ? 'Referral reward' : 'Exit payment',
        createdAt: r.created_at,
        approvedAt: r.approved_at,
      })),
    };
  }

  async listAuditLogs({ prefixes = null, limit = 100 } = {}) {
    const normalized = normalizeAuditPrefixes(prefixes);
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const likePatterns = normalized.map((p) => `${p}%`);
    const result = await this.pool.query(
      `SELECT al.*, u.email AS actor_email
       FROM audit_logs al
       LEFT JOIN users u ON u.id=al.actor_id
       WHERE al.action LIKE ANY($1::text[])
       ORDER BY al.occurred_at DESC
       LIMIT $2`,
      [likePatterns, lim],
    );
    return {
      items: result.rows.map(mapAuditLog),
      prefixes: normalized,
      knownPrefixes: [...AUDIT_ACTION_PREFIXES],
      readOnly: true,
    };
  }


}

attachFinalDemoMethods(PostgresGrowBangladeshService.prototype);
attachProjectOwnerPackMethods(PostgresGrowBangladeshService.prototype);
attachSuperAdminPackMethods(PostgresGrowBangladeshService.prototype);
attachInvestorPackMethods(PostgresGrowBangladeshService.prototype);
attachDashboardAdminWorkflowMethods(PostgresGrowBangladeshService.prototype);
attachMobileFirstDashboard(PostgresGrowBangladeshService.prototype);
attachLegalAgreementMethods(PostgresGrowBangladeshService.prototype);
