/**
 * Investor feature pack — home metrics, Approved referral reward payout
 * requests (display-only, fundsMoved:false), apply reward toward share
 * applications, support message threads, project-owner access requests,
 * privacy-safe referral purchase history.
 * Attached onto PostgresGrowBangladeshService.prototype.
 * NO wallet language.
 */
import { DomainError } from './domain.js';
import { withTransaction } from './db.js';
import {
  REFERRAL_FUNDING_DISCLAIMER,
  REFERRAL_REWARD_STATUS,
  mapReferralReward,
} from './referrals.js';

const PAYOUT_STATUSES = Object.freeze({
  REQUESTED: 'requested',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAID_RECORDED: 'paid_recorded',
});

const OPEN_PAYOUT_STATUSES = Object.freeze([
  PAYOUT_STATUSES.REQUESTED,
  PAYOUT_STATUSES.UNDER_REVIEW,
  PAYOUT_STATUSES.APPROVED,
  PAYOUT_STATUSES.PAID_RECORDED,
]);

function assertSafePositivePoisha(value, field = 'amountPoisha') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new DomainError('INVALID_AMOUNT', `${field} must be a positive integer (poisha)`, 400);
  }
  return n;
}

function optionalNote(value, field = 'note', max = 2000) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (text.length > max) {
    throw new DomainError('NOTE_TOO_LONG', `${field} must be at most ${max} characters`, 400);
  }
  return text || null;
}

function requireReason(value, field = 'reason', min = 10, max = 2000) {
  const text = optionalNote(value, field, max);
  if (!text || text.length < min) {
    throw new DomainError('REASON_REQUIRED', `${field} is required (at least ${min} characters)`, 400);
  }
  return text;
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const parts = email.split('@');
  if (parts.length !== 2) return '***';
  const [local, domain] = parts;
  const keep = local.slice(0, Math.min(2, local.length));
  return `${keep}***@${domain}`;
}

function maskPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `***${digits.slice(-4)}`;
}

function mapPayoutRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    investorId: row.investor_id,
    amountPoisha: Number(row.amount_poisha),
    note: row.note || null,
    status: row.status,
    bankSnapshot: row.bank_snapshot_json || {},
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    reviewNote: row.review_note || null,
    paidRecordedAt: row.paid_recorded_at || null,
    paidRecordedBy: row.paid_recorded_by || null,
    payoutReference: row.payout_reference || null,
    payoutMethod: row.payout_method || null,
    fundsMoved: false,
    payoutEnabled: false,
    label: 'Approved referral reward payout request',
    noteDisclaimer:
      'Display-only Approved referral reward payout request — live bank rails are not enabled. Not a wallet balance.',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function mapApplyLedger(row) {
  if (!row) return null;
  return {
    id: row.id,
    investorId: row.investor_id,
    applicationId: row.application_id || null,
    projectId: row.project_id,
    units: Number(row.units),
    amountPoisha: Number(row.amount_poisha),
    unitInvestmentPoisha: Number(row.unit_investment_poisha),
    note: row.note || null,
    createdAt: row.created_at,
    label: 'Approved referral reward applied toward share application',
  };
}

function mapSupportCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    openedBy: row.opened_by,
    projectId: row.project_id || null,
    subject: row.subject,
    description: row.description,
    priority: row.priority,
    status: row.status,
    assignedTo: row.assigned_to || null,
    resolution: row.resolution || null,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at || null,
  };
}

function mapSupportMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    senderId: row.sender_id,
    body: row.body,
    isStaff: Boolean(row.is_staff),
    createdAt: row.created_at,
  };
}

async function audit(client, actorId, action, subjectType, subjectId, detail = {}, meta = {}) {
  const sid =
    subjectId &&
    String(subjectId).match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      ? subjectId
      : '00000000-0000-4000-8000-000000000018';
  await client.query(
    `INSERT INTO audit_logs(actor_id, action, subject_type, subject_id, reason, before_json, after_json, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::inet, $9)`,
    [
      actorId,
      action,
      subjectType,
      sid,
      meta.reason ?? null,
      JSON.stringify(meta.before ?? null),
      JSON.stringify(meta.after != null ? meta.after : detail),
      meta.ip ?? null,
      meta.userAgent ?? null,
    ],
  );
}

function normalizeRequestContext(requestContext = {}) {
  return {
    ip: requestContext.ip || requestContext.ipAddress || null,
    userAgent: requestContext.userAgent || null,
  };
}

export function attachInvestorPackMethods(proto) {
  /** Available Approved referral reward poisha (not yet payout-requested or applied). */
  proto.getApprovedReferralRewardAvailablePoisha = async function getApprovedReferralRewardAvailablePoisha(
    investorId,
    client = null,
  ) {
    const q = client || this.pool;
    const approved = await q.query(
      `SELECT COALESCE(SUM(rr.reward_poisha), 0)::bigint AS total
       FROM referral_rewards rr
       JOIN referrals r ON r.id = rr.referral_id
       WHERE r.referrer_id = $1
         AND rr.status IN ('approved', 'paid')`,
      [investorId],
    );
    const consumedPayouts = await q.query(
      `SELECT COALESCE(SUM(amount_poisha), 0)::bigint AS total
       FROM referral_reward_payout_requests
       WHERE investor_id = $1
         AND status = ANY($2::text[])`,
      [investorId, OPEN_PAYOUT_STATUSES],
    );
    const consumedApply = await q.query(
      `SELECT COALESCE(SUM(amount_poisha), 0)::bigint AS total
       FROM referral_reward_apply_ledger
       WHERE investor_id = $1`,
      [investorId],
    );
    const total = Number(approved.rows[0].total);
    const used =
      Number(consumedPayouts.rows[0].total) + Number(consumedApply.rows[0].total);
    return Math.max(0, total - used);
  };

  proto.getInvestorHome = async function getInvestorHome(investorId) {
    const investments = await this.listInvestments({ actorId: investorId, canViewAny: false });
    const projectIds = investments.map((i) => i.projectId).filter(Boolean);
    let metaById = {};
    if (projectIds.length) {
      const projectMeta = await this.pool.query(
        `SELECT p.id, p.status AS project_status, p.slug AS project_slug,
                p.unit_investment_poisha, p.total_units, p.active_units, p.reserved_units, p.title
         FROM projects p
         WHERE p.id = ANY($1::uuid[])`,
        [projectIds],
      );
      metaById = Object.fromEntries(projectMeta.rows.map((r) => [r.id, r]));
    }
    const active = investments.filter((r) => {
      const s = String(r.status || '').toLowerCase();
      return !['closed', 'cancelled', 'canceled', 'exited', 'matured', 'exit_completed'].includes(s)
        && !s.includes('exit_complete');
    });
    let investmentPoisha = 0;
    let shareUnits = 0;
    let projectedPoisha = 0;
    let confirmedPoisha = 0;
    let nextMaturity = null;
    const maturityReport = [];
    for (const row of active) {
      investmentPoisha += Number(row.investmentPoisha || 0);
      shareUnits += Number(row.units || 0);
      projectedPoisha += Number(row.projectedAccruedReturnPoisha || row.estimatedProfitPoisha || 0);
      confirmedPoisha += Number(row.confirmedProfitPoisha || 0);
      if (row.lockInEndAt) {
        const end = new Date(row.lockInEndAt);
        if (!nextMaturity || end < nextMaturity) nextMaturity = end;
        maturityReport.push({
          allocationId: row.id,
          projectId: row.projectId,
          projectTitle: row.projectTitle || row.projectName,
          units: Number(row.units),
          investmentPoisha: Number(row.investmentPoisha),
          lockInEndAt: row.lockInEndAt,
          projectStatus: metaById[row.projectId]?.project_status || null,
        });
      }
    }
    maturityReport.sort((a, b) => new Date(a.lockInEndAt) - new Date(b.lockInEndAt));

    const approvedTotal = await this.pool.query(
      `SELECT COALESCE(SUM(rr.reward_poisha), 0)::bigint AS total
       FROM referral_rewards rr
       JOIN referrals r ON r.id = rr.referral_id
       WHERE r.referrer_id = $1 AND rr.status IN ('approved', 'paid')`,
      [investorId],
    );
    const availableRewardPoisha = await this.getApprovedReferralRewardAvailablePoisha(investorId);

    let referralCode = null;
    try {
      const codeRow = await this.ensureMyReferralCode(investorId);
      referralCode = codeRow?.myReferralCode || codeRow?.referralCode || null;
    } catch {
      const u = await this.pool.query(`SELECT referral_code FROM users WHERE id=$1`, [investorId]);
      referralCode = u.rows[0]?.referral_code || null;
    }

    const roles = await this.pool.query(
      `SELECT role_code FROM user_roles WHERE user_id=$1`,
      [investorId],
    );
    const roleList = roles.rows.map((r) => r.role_code);
    const canCreateProject = roleList.includes('project_owner');

    const openSupport = await this.pool.query(
      `SELECT COUNT(*)::bigint AS c FROM support_cases
       WHERE opened_by=$1 AND status IN ('open','under_review','waiting_user')`,
      [investorId],
    );

    const pendingPayouts = await this.pool.query(
      `SELECT * FROM referral_reward_payout_requests
       WHERE investor_id=$1 AND status IN ('requested','under_review','approved')
       ORDER BY created_at DESC LIMIT 20`,
      [investorId],
    );

    const webBase =
      process.env.STAGING_WEB_BASE_URL || 'https://web-production-ba84bb.up.railway.app';
    const shareUrl = referralCode
      ? `${webBase.replace(/\/$/, '')}/?ref=${encodeURIComponent(referralCode)}`
      : null;

    return {
      investmentPoisha,
      shareUnits,
      projectedPoisha,
      confirmedPoisha,
      nextMaturityAt: nextMaturity ? nextMaturity.toISOString() : null,
      holdings: active.map((row) => {
        const m = metaById[row.projectId] || {};
        const remaining = Math.max(
          0,
          Number(m.total_units || 0) - Number(m.active_units || 0) - Number(m.reserved_units || 0),
        );
        return {
          allocationId: row.id,
          projectId: row.projectId,
          projectTitle: row.projectTitle || row.projectName || m.title,
          projectSlug: m.project_slug || null,
          projectStatus: m.project_status || null,
          units: Number(row.units),
          investmentPoisha: Number(row.investmentPoisha),
          lockInEndAt: row.lockInEndAt || null,
          unitInvestmentPoisha: Number(m.unit_investment_poisha || 0),
          unitsRemaining: remaining,
          canBuyMore: ['published', 'paused'].includes(m.project_status) && remaining > 0,
        };
      }),
      maturityReport,
      approvedReferralRewardTotalPoisha: Number(approvedTotal.rows[0].total),
      approvedReferralRewardAvailablePoisha: availableRewardPoisha,
      referralFundingDisclaimer: REFERRAL_FUNDING_DISCLAIMER,
      pendingReferralPayoutRequests: pendingPayouts.rows.map(mapPayoutRequest),
      myReferralCode: referralCode,
      referralShareUrl: shareUrl,
      canCreateProject,
      roles: roleList,
      openSupportCaseCount: Number(openSupport.rows[0].c),
      fictionalStaging: true,
      label: 'Investor home',
      rewardLabel: 'Approved referral reward',
    };
  };

  proto.getInvestorMaturityReport = async function getInvestorMaturityReport(investorId) {
    const home = await this.getInvestorHome(investorId);
    return {
      nextMaturityAt: home.nextMaturityAt,
      items: home.maturityReport,
      fictionalStaging: true,
    };
  };

  proto.createReferralRewardPayoutRequest = async function createReferralRewardPayoutRequest(
    investorId,
    input,
    meta = {},
  ) {
    const amountPoisha = assertSafePositivePoisha(input.amountPoisha);
    const note = optionalNote(input.note);
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const available = await this.getApprovedReferralRewardAvailablePoisha(investorId, client);
      if (amountPoisha > available) {
        throw new DomainError(
          'INSUFFICIENT_APPROVED_REWARD',
          `Requested amount exceeds available Approved referral reward (${available} poisha)`,
          409,
        );
      }
      const bank = await client.query(
        `SELECT account_holder_name, bank_name, branch_name, account_type,
                account_number_last4, routing_number_last4, verification_status
         FROM investor_bank_accounts WHERE user_id=$1`,
        [investorId],
      );
      const bankRow = bank.rows[0] || null;
      const bankSnapshot = bankRow
        ? {
            accountHolderName: bankRow.account_holder_name,
            bankName: bankRow.bank_name,
            branchName: bankRow.branch_name,
            accountType: bankRow.account_type,
            accountNumberLast4: bankRow.account_number_last4,
            routingNumberLast4: bankRow.routing_number_last4,
            verificationStatus: bankRow.verification_status,
          }
        : { note: 'No bank on file — admin will request KYC bank before paying' };

      const ins = await client.query(
        `INSERT INTO referral_reward_payout_requests(
           investor_id, amount_poisha, note, status, bank_snapshot_json, funds_moved
         ) VALUES ($1,$2,$3,'requested',$4::jsonb,false)
         RETURNING *`,
        [investorId, amountPoisha, note, JSON.stringify(bankSnapshot)],
      );
      const row = ins.rows[0];
      await audit(
        client,
        investorId,
        'referral_reward_payout.requested',
        'referral_reward_payout_request',
        row.id,
        mapPayoutRequest(row),
        { ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return mapPayoutRequest(row);
    });
  };

  proto.listMyReferralRewardPayoutRequests = async function listMyReferralRewardPayoutRequests(
    investorId,
    { limit = 50 } = {},
  ) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await this.pool.query(
      `SELECT * FROM referral_reward_payout_requests
       WHERE investor_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [investorId, lim],
    );
    return rows.rows.map(mapPayoutRequest);
  };

  proto.listAdminReferralRewardPayoutRequests = async function listAdminReferralRewardPayoutRequests({
    status = null,
    limit = 100,
  } = {}) {
    const params = [];
    let sql = `SELECT * FROM referral_reward_payout_requests WHERE 1=1`;
    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const rows = await this.pool.query(sql, params);
    return rows.rows.map(mapPayoutRequest);
  };

  proto.startReferralRewardPayoutReview = async function startReferralRewardPayoutReview(
    id,
    actorId,
    meta = {},
  ) {
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM referral_reward_payout_requests WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!locked.rowCount) throw new DomainError('NOT_FOUND', 'Payout request not found', 404);
      const before = locked.rows[0];
      if (before.status !== PAYOUT_STATUSES.REQUESTED) {
        throw new DomainError('INVALID_STATUS', 'Only requested payouts can start review', 409);
      }
      const upd = await client.query(
        `UPDATE referral_reward_payout_requests
         SET status='under_review', reviewed_by=$2, reviewed_at=now(), updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, actorId],
      );
      const after = mapPayoutRequest(upd.rows[0]);
      await audit(client, actorId, 'referral_reward_payout.under_review', 'referral_reward_payout_request', id, after, {
        before: mapPayoutRequest(before),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  };

  proto.approveReferralRewardPayoutRequest = async function approveReferralRewardPayoutRequest(
    id,
    actorId,
    input = {},
    meta = {},
  ) {
    const ctx = normalizeRequestContext(meta.requestContext);
    const reviewNote = optionalNote(input.reviewNote || input.note);
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM referral_reward_payout_requests WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!locked.rowCount) throw new DomainError('NOT_FOUND', 'Payout request not found', 404);
      const before = locked.rows[0];
      if (![PAYOUT_STATUSES.REQUESTED, PAYOUT_STATUSES.UNDER_REVIEW].includes(before.status)) {
        throw new DomainError('INVALID_STATUS', 'Payout cannot be approved from current status', 409);
      }
      const upd = await client.query(
        `UPDATE referral_reward_payout_requests
         SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, actorId, reviewNote],
      );
      const after = mapPayoutRequest(upd.rows[0]);
      await audit(client, actorId, 'referral_reward_payout.approved', 'referral_reward_payout_request', id, after, {
        before: mapPayoutRequest(before),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  };

  proto.rejectReferralRewardPayoutRequest = async function rejectReferralRewardPayoutRequest(
    id,
    actorId,
    input = {},
    meta = {},
  ) {
    const ctx = normalizeRequestContext(meta.requestContext);
    const reviewNote = requireReason(input.reason || input.reviewNote, 'reason');
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM referral_reward_payout_requests WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!locked.rowCount) throw new DomainError('NOT_FOUND', 'Payout request not found', 404);
      const before = locked.rows[0];
      if (
        ![PAYOUT_STATUSES.REQUESTED, PAYOUT_STATUSES.UNDER_REVIEW, PAYOUT_STATUSES.APPROVED].includes(
          before.status,
        )
      ) {
        throw new DomainError('INVALID_STATUS', 'Payout cannot be rejected from current status', 409);
      }
      const upd = await client.query(
        `UPDATE referral_reward_payout_requests
         SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, actorId, reviewNote],
      );
      const after = mapPayoutRequest(upd.rows[0]);
      await audit(client, actorId, 'referral_reward_payout.rejected', 'referral_reward_payout_request', id, after, {
        before: mapPayoutRequest(before),
        reason: reviewNote,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  };

  proto.recordReferralRewardPayoutPaid = async function recordReferralRewardPayoutPaid(
    id,
    actorId,
    input = {},
    meta = {},
  ) {
    const ctx = normalizeRequestContext(meta.requestContext);
    const payoutReference = optionalNote(input.payoutReference || input.reference, 'payoutReference', 200);
    const payoutMethod = input.payoutMethod || 'bank_transfer_record';
    if (!['bank_transfer_record', 'cash_record', 'other_record'].includes(payoutMethod)) {
      throw new DomainError('INVALID_METHOD', 'Invalid payoutMethod', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM referral_reward_payout_requests WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!locked.rowCount) throw new DomainError('NOT_FOUND', 'Payout request not found', 404);
      const before = locked.rows[0];
      if (before.status !== PAYOUT_STATUSES.APPROVED) {
        throw new DomainError('INVALID_STATUS', 'Only approved payouts can be recorded as paid', 409);
      }
      const upd = await client.query(
        `UPDATE referral_reward_payout_requests
         SET status='paid_recorded', paid_recorded_at=now(), paid_recorded_by=$2,
             payout_reference=$3, payout_method=$4, funds_moved=false, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, actorId, payoutReference, payoutMethod],
      );
      const after = mapPayoutRequest(upd.rows[0]);
      await audit(client, actorId, 'referral_reward_payout.paid_recorded', 'referral_reward_payout_request', id, after, {
        before: mapPayoutRequest(before),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  };

  /**
   * Apply Approved referral reward toward a new (or existing) share application.
   * amountPoisha must cover units * unit_investment_poisha and not exceed available reward.
   */
  proto.applyReferralRewardTowardShares = async function applyReferralRewardTowardShares(
    investorId,
    input,
    meta = {},
  ) {
    const units = Number(input.units);
    if (!Number.isSafeInteger(units) || units <= 0) {
      throw new DomainError('INVALID_UNITS', 'units must be a positive integer', 400);
    }
    const amountPoisha = assertSafePositivePoisha(input.amountPoisha);
    const projectId = input.projectId;
    if (!projectId) throw new DomainError('PROJECT_REQUIRED', 'projectId is required', 400);
    const note = optionalNote(input.note);
    const ctx = normalizeRequestContext(meta.requestContext);

    const project = await this.pool.query(
      `SELECT id, status, unit_investment_poisha, total_units, active_units, reserved_units, title
       FROM projects WHERE id=$1`,
      [projectId],
    );
    if (!project.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404);
    const p = project.rows[0];
    if (!['published', 'paused'].includes(p.status)) {
      throw new DomainError('PROJECT_NOT_OPEN', 'Project is not open for investment', 409);
    }
    const unitPrice = Number(p.unit_investment_poisha);
    const required = unitPrice * units;
    if (amountPoisha !== required) {
      throw new DomainError(
        'AMOUNT_MUST_MATCH_UNITS',
        `amountPoisha must equal unit price × units (${required} poisha)`,
        400,
      );
    }
    const remaining =
      Number(p.total_units) - Number(p.active_units) - Number(p.reserved_units);
    if (units > remaining) {
      throw new DomainError('INSUFFICIENT_UNITS', 'Not enough shares available', 409);
    }

    const available = await this.getApprovedReferralRewardAvailablePoisha(investorId);
    if (amountPoisha > available) {
      throw new DomainError(
        'INSUFFICIENT_APPROVED_REWARD',
        `Available Approved referral reward is ${available} poisha`,
        409,
      );
    }

    let applicationId = input.applicationId || null;
    let application = null;
    if (!applicationId) {
      application = await this.applyForUnits(
        {
          projectId,
          investorId,
          units,
          acceptedTermsVersion: input.acceptedTermsVersion || 1,
          agreementVersion: input.agreementVersion || 1,
          deviceMeta: { source: 'referral_reward_apply' },
          requestContext: meta.requestContext,
        },
        investorId,
      );
      applicationId = application.id || application.applicationId;
    }

    return withTransaction(this.pool, async (client) => {
      const stillAvailable = await this.getApprovedReferralRewardAvailablePoisha(investorId, client);
      if (amountPoisha > stillAvailable) {
        throw new DomainError(
          'INSUFFICIENT_APPROVED_REWARD',
          `Available Approved referral reward is ${stillAvailable} poisha`,
          409,
        );
      }
      const ins = await client.query(
        `INSERT INTO referral_reward_apply_ledger(
           investor_id, application_id, project_id, units, amount_poisha,
           unit_investment_poisha, note, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$1)
         RETURNING *`,
        [investorId, applicationId, projectId, units, amountPoisha, unitPrice, note],
      );
      const mapped = mapApplyLedger(ins.rows[0]);
      await audit(
        client,
        investorId,
        'referral_reward.applied_to_application',
        'referral_reward_apply_ledger',
        mapped.id,
        mapped,
        { ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return {
        ...mapped,
        applicationId,
        application: application || undefined,
        projectTitle: p.title,
        fundsMoved: false,
        payoutEnabled: false,
        label: 'Approved referral reward applied toward share application',
      };
    });
  };

  // ---- Support cases / messages ----
  proto.createSupportCase = async function createSupportCase(investorId, input, meta = {}) {
    const subject = requireReason(input.subject, 'subject', 3, 200);
    const description = requireReason(input.description || input.body, 'description', 5, 4000);
    const priority = ['low', 'normal', 'high', 'urgent'].includes(input.priority)
      ? input.priority
      : 'normal';
    const projectId = input.projectId || null;
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const ins = await client.query(
        `INSERT INTO support_cases(opened_by, project_id, subject, description, priority, status)
         VALUES ($1,$2,$3,$4,$5,'open') RETURNING *`,
        [investorId, projectId, subject, description, priority],
      );
      const c = ins.rows[0];
      await client.query(
        `INSERT INTO support_messages(case_id, sender_id, body, is_staff)
         VALUES ($1,$2,$3,false)`,
        [c.id, investorId, description],
      );
      await audit(client, investorId, 'support_case.opened', 'support_case', c.id, mapSupportCase(c), {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return mapSupportCase(c);
    });
  };

  proto.listMySupportCases = async function listMySupportCases(investorId, { limit = 50 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await this.pool.query(
      `SELECT * FROM support_cases WHERE opened_by=$1 ORDER BY opened_at DESC LIMIT $2`,
      [investorId, lim],
    );
    return rows.rows.map(mapSupportCase);
  };

  proto.getSupportCase = async function getSupportCase(caseId, actorId, { isStaff = false } = {}) {
    const c = await this.pool.query(`SELECT * FROM support_cases WHERE id=$1`, [caseId]);
    if (!c.rowCount) throw new DomainError('NOT_FOUND', 'Support case not found', 404);
    const row = c.rows[0];
    if (!isStaff && row.opened_by !== actorId) {
      throw new DomainError('FORBIDDEN', 'You can only view your own support cases', 403);
    }
    const msgs = await this.pool.query(
      `SELECT * FROM support_messages WHERE case_id=$1 ORDER BY created_at ASC`,
      [caseId],
    );
    return {
      ...mapSupportCase(row),
      messages: msgs.rows.map(mapSupportMessage),
    };
  };

  proto.addSupportMessage = async function addSupportMessage(
    caseId,
    actorId,
    input,
    { isStaff = false } = {},
    meta = {},
  ) {
    const body = requireReason(input.body || input.message, 'body', 1, 4000);
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const c = await client.query(`SELECT * FROM support_cases WHERE id=$1 FOR UPDATE`, [caseId]);
      if (!c.rowCount) throw new DomainError('NOT_FOUND', 'Support case not found', 404);
      const row = c.rows[0];
      if (!isStaff && row.opened_by !== actorId) {
        throw new DomainError('FORBIDDEN', 'You can only message your own support cases', 403);
      }
      if (['resolved', 'closed'].includes(row.status) && !isStaff) {
        throw new DomainError('CASE_CLOSED', 'This support case is closed', 409);
      }
      const msg = await client.query(
        `INSERT INTO support_messages(case_id, sender_id, body, is_staff)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [caseId, actorId, body, Boolean(isStaff)],
      );
      if (isStaff && row.status === 'open') {
        await client.query(
          `UPDATE support_cases SET status='under_review', assigned_to=COALESCE(assigned_to,$2) WHERE id=$1`,
          [caseId, actorId],
        );
      } else if (!isStaff && row.status === 'waiting_user') {
        await client.query(`UPDATE support_cases SET status='under_review' WHERE id=$1`, [caseId]);
      } else if (isStaff) {
        await client.query(`UPDATE support_cases SET status='waiting_user' WHERE id=$1`, [caseId]);
      }
      await audit(client, actorId, 'support_message.created', 'support_case', caseId, mapSupportMessage(msg.rows[0]), {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return mapSupportMessage(msg.rows[0]);
    });
  };

  proto.listAdminSupportCases = async function listAdminSupportCases({ status = null, limit = 100 } = {}) {
    const params = [];
    let sql = `SELECT * FROM support_cases WHERE 1=1`;
    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY opened_at DESC LIMIT $${params.length}`;
    const rows = await this.pool.query(sql, params);
    return rows.rows.map(mapSupportCase);
  };

  proto.closeSupportCase = async function closeSupportCase(caseId, actorId, input = {}, meta = {}) {
    const resolution = optionalNote(input.resolution || input.note);
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const upd = await client.query(
        `UPDATE support_cases
         SET status='closed', resolution=$2, resolved_at=now(), assigned_to=COALESCE(assigned_to,$3)
         WHERE id=$1 RETURNING *`,
        [caseId, resolution, actorId],
      );
      if (!upd.rowCount) throw new DomainError('NOT_FOUND', 'Support case not found', 404);
      const after = mapSupportCase(upd.rows[0]);
      await audit(client, actorId, 'support_case.closed', 'support_case', caseId, after, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  };

  // ---- Project owner access request ----
  proto.requestProjectOwnerAccess = async function requestProjectOwnerAccess(
    investorId,
    input,
    meta = {},
  ) {
    const reason = requireReason(input.reason, 'reason', 10);
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const has = await client.query(
        `SELECT 1 FROM user_roles WHERE user_id=$1 AND role_code='project_owner'`,
        [investorId],
      );
      if (has.rowCount) {
        throw new DomainError('ALREADY_OWNER', 'You already have project_owner role', 409);
      }
      const pending = await client.query(
        `SELECT id FROM investor_project_owner_access_requests
         WHERE investor_id=$1 AND status='requested' LIMIT 1`,
        [investorId],
      );
      if (pending.rowCount) {
        throw new DomainError('ALREADY_REQUESTED', 'You already have a pending access request', 409);
      }
      const ins = await client.query(
        `INSERT INTO investor_project_owner_access_requests(investor_id, reason, status)
         VALUES ($1,$2,'requested') RETURNING *`,
        [investorId, reason],
      );
      const row = ins.rows[0];
      await audit(
        client,
        investorId,
        'project_owner_access.requested',
        'investor_project_owner_access_request',
        row.id,
        { id: row.id, status: row.status },
        { ip: ctx.ip, userAgent: ctx.userAgent, reason },
      );
      return {
        id: row.id,
        investorId: row.investor_id,
        reason: row.reason,
        status: row.status,
        createdAt: row.created_at,
      };
    });
  };

  proto.listMyProjectOwnerAccessRequests = async function listMyProjectOwnerAccessRequests(investorId) {
    const rows = await this.pool.query(
      `SELECT * FROM investor_project_owner_access_requests
       WHERE investor_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [investorId],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      investorId: row.investor_id,
      reason: row.reason,
      status: row.status,
      reviewNote: row.review_note || null,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at || null,
    }));
  };

  proto.listAdminProjectOwnerAccessRequests = async function listAdminProjectOwnerAccessRequests({
    status = null,
    limit = 100,
  } = {}) {
    const params = [];
    let sql = `SELECT * FROM investor_project_owner_access_requests WHERE 1=1`;
    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const rows = await this.pool.query(sql, params);
    return rows.rows.map((row) => ({
      id: row.id,
      investorId: row.investor_id,
      reason: row.reason,
      status: row.status,
      reviewNote: row.review_note || null,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at || null,
    }));
  };

  proto.reviewProjectOwnerAccessRequest = async function reviewProjectOwnerAccessRequest(
    id,
    actorId,
    input,
    meta = {},
  ) {
    const decision = String(input.decision || input.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(decision)) {
      throw new DomainError('INVALID_DECISION', 'decision must be approved or rejected', 400);
    }
    const reviewNote = optionalNote(input.reviewNote || input.note);
    if (decision === 'rejected') requireReason(input.reason || reviewNote, 'reason');
    const ctx = normalizeRequestContext(meta.requestContext);
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM investor_project_owner_access_requests WHERE id=$1 FOR UPDATE`,
        [id],
      );
      if (!locked.rowCount) throw new DomainError('NOT_FOUND', 'Access request not found', 404);
      const before = locked.rows[0];
      if (before.status !== 'requested') {
        throw new DomainError('INVALID_STATUS', 'Request already reviewed', 409);
      }
      const upd = await client.query(
        `UPDATE investor_project_owner_access_requests
         SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, decision, actorId, reviewNote || input.reason || null],
      );
      if (decision === 'approved') {
        await client.query(
          `INSERT INTO user_roles(user_id, role_code, granted_by)
           VALUES ($1,'project_owner',$2)
           ON CONFLICT DO NOTHING`,
          [before.investor_id, actorId],
        );
        await client.query(
          `UPDATE users SET pending_owner_agreement=true, updated_at=now() WHERE id=$1`,
          [before.investor_id],
        );
      }
      const row = upd.rows[0];
      const after = {
        id: row.id,
        investorId: row.investor_id,
        status: row.status,
        reviewNote: row.review_note,
      };
      await audit(
        client,
        actorId,
        `project_owner_access.${decision}`,
        'investor_project_owner_access_request',
        id,
        after,
        { before: { status: before.status }, ip: ctx.ip, userAgent: ctx.userAgent },
      );
      return after;
    });
  };

  /** Privacy-safe referral purchase history for referrer. */
  proto.getReferralPurchaseHistory = async function getReferralPurchaseHistory(investorId) {
    const rows = await this.pool.query(
      `SELECT r.id AS referral_id, r.referral_code, r.created_at AS referred_at,
              u.email AS referred_email, u.mobile AS referred_mobile,
              a.id AS allocation_id, a.units, a.investment_poisha, a.status AS allocation_status,
              p.title AS project_title, p.id AS project_id,
              rr.status AS reward_status, rr.reward_poisha
       FROM referrals r
       JOIN users u ON u.id = r.referred_user_id
       LEFT JOIN allocations a
         ON a.investor_id = r.referred_user_id
        AND a.status IN ('active','matured')
       LEFT JOIN projects p ON p.id = a.project_id
       LEFT JOIN referral_rewards rr
         ON rr.referral_id = r.id
        AND (rr.qualifying_application_id = a.application_id OR rr.qualifying_application_id IS NULL)
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC, a.activated_at DESC NULLS LAST
       LIMIT 200`,
      [investorId],
    );
    const purchases = [];
    const seen = new Set();
    for (const row of rows.rows) {
      if (!row.allocation_id) continue;
      if (seen.has(row.allocation_id)) continue;
      seen.add(row.allocation_id);
      purchases.push({
        referralId: row.referral_id,
        referralCode: row.referral_code,
        referredAt: row.referred_at,
        referredEmailMasked: maskEmail(row.referred_email),
        referredPhoneMasked: maskPhone(row.referred_mobile),
        projectId: row.project_id,
        projectTitle: row.project_title,
        units: Number(row.units),
        investmentPoisha: Number(row.investment_poisha),
        allocationStatus: row.allocation_status,
        rewardStatus: row.reward_status || null,
        rewardPoisha: row.reward_poisha == null ? null : Number(row.reward_poisha),
      });
    }
    return {
      purchaseCount: purchases.length,
      purchases,
      privacyNote: 'Referred person email/phone are masked. Full KYC is never exposed to referrers.',
      fundingDisclaimer: REFERRAL_FUNDING_DISCLAIMER,
    };
  };
}

export {
  maskEmail,
  maskPhone,
  mapPayoutRequest,
  PAYOUT_STATUSES,
  REFERRAL_FUNDING_DISCLAIMER,
};
