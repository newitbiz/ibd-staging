/**
 * Super Admin feature pack — overview metrics, owner disbursements (staging,
 * fundsMoved:false), service-charge settings, role-access checklist, share-unit
 * + disbursement-rules adjustments after review.
 * Attached onto PostgresGrowBangladeshService.prototype.
 */
import { DomainError } from './domain.js';
import { withTransaction } from './db.js';
import { hashPassword } from './crypto_util.js';
import { ROLES, isStaffRole } from './roles.js';
import { assertSafeInteger } from './project_workflow.js';

export const SERVICE_CHARGE_SETTING_KEY = 'default_administration_fee_bps';
export const ROLE_ACCESS_SETTING_KEY = 'role_route_access';
export const DEFAULT_SERVICE_CHARGE_BPS = 200;

export const ROUTE_GROUPS = Object.freeze([
  'overview',
  'projects',
  'payments',
  'allocations',
  'settings',
  'disbursements',
  'users',
  'audit',
  'referrals',
  'exits',
  'reports',
]);

export const DISBURSEMENT_STATUSES = Object.freeze({
  REQUESTED: 'requested',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAID_RECORDED: 'paid_recorded',
});

const DISBURSEMENT_ELIGIBLE_PROJECT_STATUSES = new Set([
  'published',
  'paused',
  'funding_closed',
  'active',
  'completed',
]);

const SHARE_UNITS_EDITABLE_STATUSES = new Set([
  'submitted_for_review',
  'resubmitted',
  'changes_requested',
  'approved',
  'published',
  'paused',
]);

const STAFF_ASSIGNABLE_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.COMPLIANCE_REVIEWER,
  ROLES.PROJECT_REVIEWER,
  ROLES.FINANCE_OFFICER,
  ROLES.SUPPORT,
  ROLES.AUDITOR,
]);

async function audit(client, actorId, action, subjectType, subjectId, detail = {}, meta = {}) {
  const afterPayload = meta.after != null ? meta.after : detail;
  const sid =
    subjectId &&
    String(subjectId).match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      ? subjectId
      : '00000000-0000-4000-8000-000000000017';
  await client.query(
    `INSERT INTO audit_logs(actor_id, action, subject_type, subject_id, reason, before_json, after_json, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::inet, $9)`,
    [
      actorId,
      action,
      subjectType,
      sid,
      meta.reason ?? null,
      meta.before != null ? JSON.stringify(meta.before) : null,
      afterPayload != null ? JSON.stringify(afterPayload) : null,
      meta.ip || null,
      meta.userAgent || null,
    ],
  );
}

function mapDisbursementRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    projectTitle: row.project_title || null,
    ownerUserId: row.owner_user_id,
    ownerEmail: row.owner_email || null,
    amountPoisha: Number(row.amount_poisha),
    approvedAmountPoisha:
      row.approved_amount_poisha != null ? Number(row.approved_amount_poisha) : null,
    explanation: row.explanation,
    projectUpdateText: row.project_update_text || null,
    status: row.status,
    projectStatusAtRequest: row.project_status_at_request,
    fundingProgress: row.funding_progress_json || {},
    stepHint: row.step_hint || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    reviewNote: row.review_note || null,
    paidRecordedAt: row.paid_recorded_at || null,
    paidRecordedBy: row.paid_recorded_by || null,
    payoutReference: row.payout_reference || null,
    payoutMethod: row.payout_method || null,
    fundsMoved: row.funds_moved === true ? true : false,
    ledgerNote: row.ledger_note || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fictionalStaging: true,
    note: 'Staging disbursement record — display-only; fundsMoved is always false (no live bank rails).',
  };
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) {
    throw new DomainError('INVALID_DISBURSEMENT_RULES', 'rules must be an array', 400);
  }
  if (rules.length > 20) {
    throw new DomainError('INVALID_DISBURSEMENT_RULES', 'At most 20 milestones', 400);
  }
  const normalized = rules.map((r, i) => {
    const label = String(r.label || r.title || `Milestone ${i + 1}`).trim().slice(0, 120);
    let percentBps = r.percentBps ?? r.percent_bps;
    if (percentBps == null && r.percent != null) {
      percentBps = Math.round(Number(r.percent) * 100);
    }
    percentBps = Number(percentBps);
    if (!Number.isSafeInteger(percentBps) || percentBps < 0 || percentBps > 10000) {
      throw new DomainError(
        'INVALID_DISBURSEMENT_RULES',
        `Milestone ${i + 1}: percentBps must be integer 0–10000`,
        400,
      );
    }
    const trigger = String(r.trigger || r.when || 'manual').trim().slice(0, 80);
    return { label, percentBps, trigger };
  });
  const sum = normalized.reduce((a, r) => a + r.percentBps, 0);
  if (normalized.length && (sum < 1 || sum > 10000)) {
    throw new DomainError(
      'INVALID_DISBURSEMENT_RULES',
      'Sum of percentBps must be between 1 and 10000 (0.01%–100%)',
      400,
    );
  }
  return normalized;
}

function stepHintForProject(status, progress) {
  const pct = progress?.percentFunded ?? 0;
  if (status === 'published' || status === 'paused') {
    if (pct < 25) return 'Early funding — prefer small milestone disbursements only after admin review.';
    if (pct < 75) return 'Mid funding — check disbursement rules % vs units sold before approving.';
    return 'Near/fully funded — may approve schedule milestones; record paid display-only.';
  }
  if (status === 'funding_closed' || status === 'active') {
    return 'Funding closed / active — follow disbursement rules milestones; admin records paid (fundsMoved:false).';
  }
  if (status === 'completed') {
    return 'Project completed — final disbursement records only; still display-only on staging.';
  }
  return 'Review project running status and funding progress before disbursement.';
}

export function attachSuperAdminPackMethods(proto) {
  proto.getAdminOverview = async function getAdminOverview() {
    const sold = await this.pool.query(
      `SELECT
         COALESCE(SUM(a.units), 0)::bigint AS share_units_sold,
         COUNT(*)::bigint AS share_count,
         COALESCE(SUM(a.investment_poisha), 0)::bigint AS investment_poisha,
         COUNT(DISTINCT a.investor_id)::bigint AS distinct_investors
       FROM allocations a
       WHERE a.status = 'active'`,
    );
    const projects = await this.pool.query(
      `SELECT status, COUNT(*)::bigint AS c FROM projects GROUP BY status`,
    );
    const byStatus = {};
    let projectCount = 0;
    for (const row of projects.rows) {
      byStatus[row.status] = Number(row.c);
      projectCount += Number(row.c);
    }
    const publishedCount = ['published', 'paused', 'funding_closed', 'active', 'completed'].reduce(
      (n, s) => n + (byStatus[s] || 0),
      0,
    );
    const reviewQueueCount = ['submitted_for_review', 'resubmitted'].reduce(
      (n, s) => n + (byStatus[s] || 0),
      0,
    );
    // Short overview "Total Project Request": review queue + changes_requested
    const totalProjectRequest = reviewQueueCount + (byStatus.changes_requested || 0);
    const pendingDisbursements = await this.pool.query(
      `SELECT COUNT(*)::bigint AS c FROM owner_disbursement_requests
       WHERE status IN ('requested','under_review','approved')`,
    );
    // Platform admin fee collected from verified payments (via applications)
    const earnings = await this.pool.query(
      `SELECT COALESCE(SUM(ia.administration_fee_poisha), 0)::bigint AS fee_poisha
       FROM payments p
       JOIN investment_applications ia ON ia.id = p.application_id
       WHERE p.status = 'verified'`,
    );
    const investorRoleUsers = await this.pool.query(
      `SELECT COUNT(DISTINCT ur.user_id)::bigint AS c
       FROM user_roles ur
       WHERE ur.role_code = 'investor'`,
    );
    const ownerRoleUsers = await this.pool.query(
      `SELECT COUNT(DISTINCT ur.user_id)::bigint AS c
       FROM user_roles ur
       WHERE ur.role_code = 'project_owner'`,
    );
    const publishedOwners = await this.pool.query(
      `SELECT COUNT(DISTINCT b.owner_user_id)::bigint AS c
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       WHERE p.status = ANY($1::text[])`,
      [['published', 'paused', 'funding_closed', 'active', 'completed']],
    );
    const overdueProjects = await this.pool.query(
      `SELECT COUNT(*)::bigint AS c
       FROM projects p
       WHERE p.status = ANY($1::text[])
         AND COALESCE(p.last_owner_status_update_at, p.published_at, p.created_at)
             < (now() - make_interval(days => COALESCE(p.status_update_cadence_days, 15)))`,
      [['published', 'paused', 'funding_closed', 'active']],
    );
    const s = sold.rows[0];
    const totalFundRaisePoisha = Number(s.investment_poisha);
    const totalShareSold = Number(s.share_units_sold);
    // Total Investor number = all accounts with investor role (signups), not allocations-only.
    const totalInvestorNumber = Number(investorRoleUsers.rows[0].c);
    const iecConnectEarningPoisha = Number(earnings.rows[0].fee_poisha);
    const totalProjectOwners = Number(ownerRoleUsers.rows[0].c);
    const publishedProjectOwners = Number(publishedOwners.rows[0].c);
    return {
      // Legacy / detail-card fields
      shareUnitsSold: totalShareSold,
      shareCount: Number(s.share_count),
      investmentPoisha: totalFundRaisePoisha,
      projectCount,
      publishedProjectCount: publishedCount,
      reviewQueueCount,
      rejectedCount: byStatus.rejected || 0,
      changesRequestedCount: byStatus.changes_requested || 0,
      projectCountsByStatus: byStatus,
      pendingDisbursementCount: Number(pendingDisbursements.rows[0].c),
      // Compact short-overview card (Admin Home)
      totalFundRaisePoisha,
      totalShareSold,
      totalInvestorNumber,
      totalInvestorNumberBasis: 'investor_role_signups',
      totalInvestorRoleUsers: totalInvestorNumber,
      distinctInvestorsWithActiveAllocations: Number(s.distinct_investors),
      totalProjectOwners,
      publishedProjectOwners,
      projectUpdateOverdueCount: Number(overdueProjects.rows[0].c),
      totalPublishedProject: publishedCount,
      totalProjectRequest,
      iecConnectEarningPoisha,
      clickThrough: {
        projects: '/admin/overview/projects',
        allocations: '/admin/overview/allocations',
        disbursements: '/admin/disbursement-requests',
        investors: '/admin/overview/investors',
        owners: '/admin/overview/owners',
        overdue: '/admin/overview/project-update-overdue',
      },
      fictionalStaging: true,
    };
  };

  proto.listAdminOverviewProjects = async function listAdminOverviewProjects({
    status = null,
    tab = null,
    limit = 100,
  } = {}) {
    const params = [];
    let sql = `SELECT p.id, p.title, p.status, p.category, p.total_units, p.active_units, p.reserved_units,
                      p.unit_investment_poisha, p.updated_at, p.created_at, p.version_number,
                      b.owner_user_id, u.email AS owner_email
               FROM projects p
               JOIN businesses b ON b.id = p.business_id
               JOIN users u ON u.id = b.owner_user_id
               WHERE 1=1`;
    if (tab === 'published') {
      sql += ` AND p.status = ANY($${params.push(['published', 'paused', 'funding_closed', 'active', 'completed'])}::text[])`;
    } else if (tab === 'review' || tab === 'review_queue') {
      sql += ` AND p.status = ANY($${params.push(['submitted_for_review', 'resubmitted'])}::text[])`;
    } else if (tab === 'rejected') {
      sql += ` AND p.status = 'rejected'`;
    } else if (tab === 'correction' || tab === 'changes_requested') {
      sql += ` AND p.status = 'changes_requested'`;
    } else if (status) {
      params.push(status);
      sql += ` AND p.status = $${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY p.updated_at DESC NULLS LAST LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      category: row.category,
      totalUnits: Number(row.total_units),
      activeUnits: Number(row.active_units),
      reservedUnits: Number(row.reserved_units),
      unitInvestmentPoisha: Number(row.unit_investment_poisha),
      versionNumber: row.version_number,
      ownerUserId: row.owner_user_id,
      ownerEmail: row.owner_email,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      complianceNote:
        row.status === 'changes_requested'
          ? 'Correction requested — owner must address compliance/content notes before resubmit.'
          : row.status === 'rejected'
            ? 'Rejected — not eligible for publish; audit trail retained.'
            : row.status === 'submitted_for_review' || row.status === 'resubmitted'
              ? 'In review queue — verify disclosures, fees, and unit inventory before approve/publish.'
              : null,
    }));
  };

  proto.listAdminOverviewAllocations = async function listAdminOverviewAllocations({
    projectId = null,
    limit = 100,
  } = {}) {
    return this.listAdminAllocations({
      status: 'active',
      projectId,
      limit,
    });
  };

  // ---- Service charge (administration fee bps platform default) ----
  proto.getServiceChargeSettings = async function getServiceChargeSettings() {
    const result = await this.pool.query(
      `SELECT value_json, updated_at, updated_by FROM platform_settings WHERE key=$1 LIMIT 1`,
      [SERVICE_CHARGE_SETTING_KEY],
    );
    let bps = DEFAULT_SERVICE_CHARGE_BPS;
    let updatedAt = null;
    let updatedBy = null;
    if (result.rowCount) {
      const raw = result.rows[0].value_json;
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isSafeInteger(n) && n >= 0 && n <= 3000) bps = n;
      updatedAt = result.rows[0].updated_at;
      updatedBy = result.rows[0].updated_by;
    }
    return {
      key: SERVICE_CHARGE_SETTING_KEY,
      administrationFeeBps: bps,
      serviceChargePercent: bps / 100,
      updatedAt,
      updatedBy,
      note: 'Default platform service charge (administration fee) in bps. Per-project fee may still be set on the project.',
    };
  };

  proto.updateServiceChargeSettings = async function updateServiceChargeSettings(actorId, bps) {
    const n = Number(bps);
    if (!Number.isSafeInteger(n) || n < 0 || n > 3000) {
      throw new DomainError(
        'FEE_OUT_OF_RANGE',
        'administrationFeeBps must be an integer between 0 and 3000 (0–30%)',
        400,
      );
    }
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO platform_settings(key, value_json, updated_at, updated_by)
         VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [SERVICE_CHARGE_SETTING_KEY, JSON.stringify(n), actorId],
      );
      await audit(client, actorId, 'platform_settings.service_charge_updated', 'platform_settings', null, {
        administrationFeeBps: n,
      });
      return this.getServiceChargeSettings();
    });
  };

  // ---- Role route access checklist ----
  proto.getRoleRouteAccess = async function getRoleRouteAccess() {
    const rows = await this.pool.query(
      `SELECT role_code, route_group, allowed FROM role_route_access ORDER BY role_code, route_group`,
    );
    const byRole = {};
    for (const row of rows.rows) {
      if (!byRole[row.role_code]) byRole[row.role_code] = {};
      byRole[row.role_code][row.route_group] = row.allowed === true;
    }
    // Also expose allowlist arrays
    const allowlists = {};
    for (const [role, groups] of Object.entries(byRole)) {
      allowlists[role] = Object.entries(groups)
        .filter(([, ok]) => ok)
        .map(([g]) => g);
    }
    return {
      routeGroups: [...ROUTE_GROUPS],
      byRole,
      allowlists,
      note: 'Checklist of which admin route groups each staff role may access. Enforced on new Super Admin routes where practical.',
    };
  };

  proto.updateRoleRouteAccess = async function updateRoleRouteAccess(actorId, payload) {
    // payload: { allowlists: { role: [groups...] } } or { byRole: { role: { group: bool } } }
    const allowlists = payload?.allowlists || null;
    const byRole = payload?.byRole || null;
    if (!allowlists && !byRole) {
      throw new DomainError('INVALID_ROLE_ACCESS', 'Provide allowlists or byRole object', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const roles = Object.keys(allowlists || byRole);
      for (const role of roles) {
        if (!STAFF_ASSIGNABLE_ROLES.has(role) && role !== 'auditor') {
          // allow known staff only
          if (!Object.values(ROLES).includes(role) || !isStaffRole(role)) {
            throw new DomainError('INVALID_ROLE', `Unknown or non-staff role: ${role}`, 400);
          }
        }
        const groups = allowlists
          ? new Set((allowlists[role] || []).map(String))
          : new Set(
              Object.entries(byRole[role] || {})
                .filter(([, ok]) => ok)
                .map(([g]) => g),
            );
        for (const g of groups) {
          if (!ROUTE_GROUPS.includes(g)) {
            throw new DomainError('INVALID_ROUTE_GROUP', `Unknown route group: ${g}`, 400);
          }
        }
        await client.query(`DELETE FROM role_route_access WHERE role_code=$1`, [role]);
        for (const g of ROUTE_GROUPS) {
          const allowed = groups.has(g);
          await client.query(
            `INSERT INTO role_route_access(role_code, route_group, allowed, updated_at, updated_by)
             VALUES ($1,$2,$3,now(),$4)`,
            [role, g, allowed, actorId],
          );
        }
      }
      // Mirror into platform_settings
      const refreshed = await client.query(
        `SELECT role_code, route_group FROM role_route_access WHERE allowed=true ORDER BY role_code, route_group`,
      );
      const mirror = {};
      for (const row of refreshed.rows) {
        if (!mirror[row.role_code]) mirror[row.role_code] = [];
        mirror[row.role_code].push(row.route_group);
      }
      await client.query(
        `INSERT INTO platform_settings(key, value_json, updated_at, updated_by)
         VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [ROLE_ACCESS_SETTING_KEY, JSON.stringify(mirror), actorId],
      );
      await audit(client, actorId, 'platform_settings.role_route_access_updated', 'platform_settings', null, {
        allowlists: mirror,
      });
      return this.getRoleRouteAccess();
    });
  };

  proto.assertRoleRouteAccess = async function assertRoleRouteAccess(roles, routeGroup) {
    if (!roles?.length) {
      throw new DomainError('FORBIDDEN', 'Insufficient role for this operation', 403);
    }
    if (roles.includes(ROLES.SUPER_ADMIN)) return true;
    const result = await this.pool.query(
      `SELECT 1 FROM role_route_access
       WHERE role_code = ANY($1::text[]) AND route_group=$2 AND allowed=true
       LIMIT 1`,
      [roles, routeGroup],
    );
    if (!result.rowCount) {
      throw new DomainError(
        'FORBIDDEN',
        `Role checklist denies access to route group '${routeGroup}'`,
        403,
      );
    }
    return true;
  };

  // ---- Create staff user ----
  proto.createStaffUser = async function createStaffUser(actorId, input = {}) {
    const email = String(input.email || '')
      .trim()
      .toLowerCase();
    const mobile = String(input.mobile || '')
      .trim()
      .replace(/\s+/g, '');
    const fullName = String(input.fullName || input.full_name || 'Staff User').trim();
    const password = String(input.password || '');
    let roles = input.roles || input.roleCodes || [];
    if (typeof roles === 'string') roles = [roles];
    roles = [...new Set(roles.map(String))];
    if (!email || !email.includes('@')) {
      throw new DomainError('EMAIL_REQUIRED', 'Valid email required', 400);
    }
    if (!mobile || mobile.length < 8) {
      throw new DomainError('PHONE_REQUIRED', 'Mobile required (min 8 digits)', 400);
    }
    if (password.length < 10) {
      throw new DomainError('WEAK_PASSWORD', 'Password must be at least 10 characters', 400);
    }
    if (!roles.length) {
      throw new DomainError('ROLES_REQUIRED', 'At least one staff role required', 400);
    }
    for (const r of roles) {
      if (!STAFF_ASSIGNABLE_ROLES.has(r)) {
        throw new DomainError('INVALID_ROLE', `Cannot assign non-staff role: ${r}`, 400);
      }
    }
    const passwordHash = await hashPassword(password);
    return withTransaction(this.pool, async (client) => {
      let user;
      try {
        const inserted = await client.query(
          `INSERT INTO users(email, mobile, password_hash, status)
           VALUES ($1,$2,$3,'active') RETURNING *`,
          [email, mobile, passwordHash],
        );
        user = inserted.rows[0];
      } catch (error) {
        if (error.code === '23505') {
          throw new DomainError('IDENTITY_TAKEN', 'Email or mobile is already registered', 409);
        }
        throw error;
      }
      for (const r of roles) {
        await client.query(
          `INSERT INTO user_roles(user_id, role_code, granted_by) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, role_code) DO NOTHING`,
          [user.id, r, actorId],
        );
      }
      await audit(client, actorId, 'staff_user.created', 'user', user.id, {
        email,
        roles,
        fullName,
      });
      return {
        id: user.id,
        email: user.email,
        mobile: user.mobile,
        status: user.status,
        roles,
        fullName,
        fictionalStaging: true,
        note: 'Staff user created on staging — no production identity.',
      };
    });
  };

  // ---- Share units after review ----
  proto.setProjectShareUnits = async function setProjectShareUnits(projectId, actorId, totalUnits) {
    const n = Number(totalUnits);
    assertSafeInteger(n, 'totalUnits');
    if (n < 1) throw new DomainError('INVALID_TOTAL_UNITS', 'totalUnits must be >= 1', 400);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT id, status, total_units, reserved_units, active_units FROM projects WHERE id=$1 FOR UPDATE`,
        [projectId],
      );
      if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
      const row = result.rows[0];
      if (!SHARE_UNITS_EDITABLE_STATUSES.has(row.status)) {
        throw new DomainError(
          'PROJECT_NOT_EDITABLE',
          `Cannot adjust share units in status ${row.status}`,
          409,
        );
      }
      const floor = Number(row.reserved_units) + Number(row.active_units);
      if (n < floor) {
        throw new DomainError(
          'TOTAL_UNITS_TOO_LOW',
          `totalUnits cannot be below reserved+active (${floor})`,
          409,
        );
      }
      await client.query(
        `UPDATE projects
         SET total_units=$2::integer,
             funding_target_poisha = unit_investment_poisha * ($2::bigint),
             updated_at=now()
         WHERE id=$1`,
        [projectId, n],
      );
      await audit(
        client,
        actorId,
        'project.share_units_adjusted',
        'project',
        projectId,
        { totalUnits: n },
        { before: { totalUnits: Number(row.total_units) }, after: { totalUnits: n } },
      );
      const refreshed = await client.query(
        `SELECT id, status, total_units, reserved_units, active_units, unit_investment_poisha, funding_target_poisha
         FROM projects WHERE id=$1`,
        [projectId],
      );
      const p = refreshed.rows[0];
      return {
        projectId: p.id,
        status: p.status,
        totalUnits: Number(p.total_units),
        reservedUnits: Number(p.reserved_units),
        activeUnits: Number(p.active_units),
        unitInvestmentPoisha: Number(p.unit_investment_poisha),
        fundingTargetPoisha: Number(p.funding_target_poisha),
      };
    });
  };

  // ---- Disbursement rules ----
  proto.getProjectDisbursementRules = async function getProjectDisbursementRules(projectId) {
    const result = await this.pool.query(
      `SELECT id, title, status, disbursement_rules_json, disbursement_rules_set_at,
              disbursement_rules_set_by, disbursement_rules_notes
       FROM projects WHERE id=$1`,
      [projectId],
    );
    if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    const row = result.rows[0];
    const rules = Array.isArray(row.disbursement_rules_json) ? row.disbursement_rules_json : [];
    return {
      projectId: row.id,
      title: row.title,
      status: row.status,
      rules,
      setAt: row.disbursement_rules_set_at,
      setBy: row.disbursement_rules_set_by,
      notes: row.disbursement_rules_notes || null,
      fictionalStaging: true,
    };
  };

  proto.setProjectDisbursementRules = async function setProjectDisbursementRules(
    projectId,
    actorId,
    { rules, notes } = {},
  ) {
    const normalized = normalizeRules(rules || []);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT id, status, disbursement_rules_json FROM projects WHERE id=$1 FOR UPDATE`,
        [projectId],
      );
      if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
      const before = result.rows[0];
      if (!SHARE_UNITS_EDITABLE_STATUSES.has(before.status) && before.status !== 'funding_closed') {
        throw new DomainError(
          'PROJECT_NOT_EDITABLE',
          `Cannot set disbursement rules in status ${before.status}`,
          409,
        );
      }
      await client.query(
        `UPDATE projects
         SET disbursement_rules_json=$2::jsonb,
             disbursement_rules_set_at=now(),
             disbursement_rules_set_by=$3,
             disbursement_rules_notes=$4,
             updated_at=now()
         WHERE id=$1`,
        [projectId, JSON.stringify(normalized), actorId, notes != null ? String(notes).slice(0, 2000) : null],
      );
      await audit(
        client,
        actorId,
        'project.disbursement_rules_set',
        'project',
        projectId,
        { rules: normalized, notes },
        { before: { rules: before.disbursement_rules_json }, after: { rules: normalized } },
      );
      return this.getProjectDisbursementRules(projectId);
    });
  };

  // ---- Owner disbursement requests ----
  proto.createOwnerDisbursementRequest = async function createOwnerDisbursementRequest(
    projectId,
    ownerUserId,
    { amountPoisha, explanation, projectUpdateText } = {},
  ) {
    const amount = Number(amountPoisha);
    assertSafeInteger(amount, 'amountPoisha');
    if (amount < 1) throw new DomainError('INVALID_AMOUNT', 'amountPoisha must be > 0', 400);
    const expl = String(explanation || '').trim();
    if (expl.length < 10) {
      throw new DomainError('EXPLANATION_REQUIRED', 'explanation must be at least 10 characters', 400);
    }
    const owned = await this._assertOwnsProject(projectId, ownerUserId);
    if (!DISBURSEMENT_ELIGIBLE_PROJECT_STATUSES.has(owned.status)) {
      throw new DomainError(
        'PROJECT_NOT_ELIGIBLE',
        `Disbursement requests allowed when project is published/active/etc. Current: ${owned.status}`,
        409,
      );
    }
    const total = Number(owned.total_units) || 1;
    const sold = Number(owned.active_units) || 0;
    const progress = {
      unitsSold: sold,
      unitsTarget: total,
      unitsRemaining: Math.max(0, total - sold - Number(owned.reserved_units || 0)),
      percentFunded: Math.round((sold / total) * 10000) / 100,
    };
    const hint = stepHintForProject(owned.status, progress);
    const result = await withTransaction(this.pool, async (client) => {
      const open = await client.query(
        `SELECT id FROM owner_disbursement_requests
         WHERE project_id=$1 AND status IN ('requested','under_review','approved')
         LIMIT 1`,
        [projectId],
      );
      if (open.rowCount) {
        throw new DomainError(
          'DISBURSEMENT_ALREADY_OPEN',
          'An open disbursement request already exists for this project',
          409,
        );
      }
      const inserted = await client.query(
        `INSERT INTO owner_disbursement_requests(
           project_id, owner_user_id, amount_poisha, explanation, project_update_text,
           status, project_status_at_request, funding_progress_json, step_hint, funds_moved
         ) VALUES ($1,$2,$3,$4,$5,'requested',$6,$7::jsonb,$8,false)
         RETURNING *`,
        [
          projectId,
          ownerUserId,
          amount,
          expl.slice(0, 4000),
          projectUpdateText != null ? String(projectUpdateText).slice(0, 4000) : null,
          owned.status,
          JSON.stringify(progress),
          hint,
        ],
      );
      const row = inserted.rows[0];
      await audit(client, ownerUserId, 'owner_disbursement.requested', 'owner_disbursement_request', row.id, {
        amountPoisha: amount,
        projectId,
        progress,
      });
      return row;
    });
    return mapDisbursementRow({ ...result, project_title: owned.title });
  };

  proto.listOwnerDisbursementRequests = async function listOwnerDisbursementRequests(
    ownerUserId,
    { status = null } = {},
  ) {
    const params = [ownerUserId];
    let sql = `SELECT d.*, p.title AS project_title, u.email AS owner_email
               FROM owner_disbursement_requests d
               JOIN projects p ON p.id = d.project_id
               JOIN users u ON u.id = d.owner_user_id
               WHERE d.owner_user_id=$1`;
    if (status) {
      params.push(status);
      sql += ` AND d.status=$${params.length}`;
    }
    sql += ' ORDER BY d.created_at DESC';
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapDisbursementRow);
  };

  proto.listAdminDisbursementRequests = async function listAdminDisbursementRequests({
    status = null,
    projectId = null,
    limit = 100,
  } = {}) {
    const params = [];
    let sql = `SELECT d.*, p.title AS project_title, u.email AS owner_email
               FROM owner_disbursement_requests d
               JOIN projects p ON p.id = d.project_id
               JOIN users u ON u.id = d.owner_user_id
               WHERE 1=1`;
    if (status) {
      params.push(status);
      sql += ` AND d.status=$${params.length}`;
    }
    if (projectId) {
      params.push(projectId);
      sql += ` AND d.project_id=$${params.length}`;
    }
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    params.push(lim);
    sql += ` ORDER BY d.created_at DESC LIMIT $${params.length}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapDisbursementRow);
  };

  proto.getAdminDisbursementLedger = async function getAdminDisbursementLedger({
    projectId = null,
    limit = 100,
  } = {}) {
    const rows = await this.listAdminDisbursementRequests({
      status: null,
      projectId,
      limit,
    });
    const paid = rows.filter((r) => r.status === 'paid_recorded');
    const approvedOpen = rows.filter((r) => r.status === 'approved');
    const sum = (list) => list.reduce((a, r) => a + (r.approvedAmountPoisha || r.amountPoisha || 0), 0);
    return {
      entries: rows,
      summary: {
        requestedCount: rows.filter((r) => r.status === 'requested').length,
        underReviewCount: rows.filter((r) => r.status === 'under_review').length,
        approvedCount: approvedOpen.length,
        rejectedCount: rows.filter((r) => r.status === 'rejected').length,
        paidRecordedCount: paid.length,
        paidRecordedPoisha: sum(paid),
        approvedOpenPoisha: sum(approvedOpen),
      },
      fundsMoved: false,
      note: 'Staging ledger — all payout rows are display-only records (fundsMoved:false). No live bank rails.',
    };
  };

  async function loadDisbursementForUpdate(client, id) {
    const result = await client.query(
      `SELECT d.*, p.title AS project_title, u.email AS owner_email
       FROM owner_disbursement_requests d
       JOIN projects p ON p.id = d.project_id
       JOIN users u ON u.id = d.owner_user_id
       WHERE d.id=$1 FOR UPDATE OF d`,
      [id],
    );
    if (!result.rowCount) {
      throw new DomainError('DISBURSEMENT_NOT_FOUND', 'Disbursement request not found', 404);
    }
    return result.rows[0];
  }

  proto.startDisbursementReview = async function startDisbursementReview(id, actorId, { note } = {}) {
    return withTransaction(this.pool, async (client) => {
      const row = await loadDisbursementForUpdate(client, id);
      if (row.status !== 'requested' && row.status !== 'under_review') {
        throw new DomainError(
          'INVALID_DISBURSEMENT_TRANSITION',
          `Cannot start review from status ${row.status}`,
          409,
        );
      }
      await client.query(
        `UPDATE owner_disbursement_requests
         SET status='under_review', reviewed_by=$2, reviewed_at=now(),
             review_note=COALESCE($3, review_note), updated_at=now()
         WHERE id=$1`,
        [id, actorId, note != null ? String(note).slice(0, 2000) : null],
      );
      await audit(client, actorId, 'owner_disbursement.under_review', 'owner_disbursement_request', id, {
        from: row.status,
      });
      const refreshed = await client.query(
        `SELECT d.*, p.title AS project_title, u.email AS owner_email
         FROM owner_disbursement_requests d
         JOIN projects p ON p.id=d.project_id
         JOIN users u ON u.id=d.owner_user_id
         WHERE d.id=$1`,
        [id],
      );
      return mapDisbursementRow(refreshed.rows[0]);
    });
  };

  proto.approveDisbursement = async function approveDisbursement(
    id,
    actorId,
    { note, approvedAmountPoisha } = {},
  ) {
    return withTransaction(this.pool, async (client) => {
      const row = await loadDisbursementForUpdate(client, id);
      if (!['requested', 'under_review'].includes(row.status)) {
        throw new DomainError(
          'INVALID_DISBURSEMENT_TRANSITION',
          `Cannot approve from status ${row.status}`,
          409,
        );
      }
      let approved = approvedAmountPoisha != null ? Number(approvedAmountPoisha) : Number(row.amount_poisha);
      assertSafeInteger(approved, 'approvedAmountPoisha');
      if (approved < 1) throw new DomainError('INVALID_AMOUNT', 'approvedAmountPoisha must be > 0', 400);
      await client.query(
        `UPDATE owner_disbursement_requests
         SET status='approved', reviewed_by=$2, reviewed_at=now(), review_note=$3,
             approved_amount_poisha=$4, updated_at=now()
         WHERE id=$1`,
        [id, actorId, note != null ? String(note).slice(0, 2000) : row.review_note, approved],
      );
      await audit(client, actorId, 'owner_disbursement.approved', 'owner_disbursement_request', id, {
        approvedAmountPoisha: approved,
      });
      const refreshed = await client.query(
        `SELECT d.*, p.title AS project_title, u.email AS owner_email
         FROM owner_disbursement_requests d
         JOIN projects p ON p.id=d.project_id
         JOIN users u ON u.id=d.owner_user_id
         WHERE d.id=$1`,
        [id],
      );
      return mapDisbursementRow(refreshed.rows[0]);
    });
  };

  proto.rejectDisbursement = async function rejectDisbursement(id, actorId, { note, reason } = {}) {
    const why = String(reason || note || '').trim();
    if (why.length < 3) {
      throw new DomainError('REASON_REQUIRED', 'Rejection reason required (min 3 chars)', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const row = await loadDisbursementForUpdate(client, id);
      if (!['requested', 'under_review'].includes(row.status)) {
        throw new DomainError(
          'INVALID_DISBURSEMENT_TRANSITION',
          `Cannot reject from status ${row.status}`,
          409,
        );
      }
      await client.query(
        `UPDATE owner_disbursement_requests
         SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_note=$3, updated_at=now()
         WHERE id=$1`,
        [id, actorId, why.slice(0, 2000)],
      );
      await audit(client, actorId, 'owner_disbursement.rejected', 'owner_disbursement_request', id, {
        reason: why,
      });
      const refreshed = await client.query(
        `SELECT d.*, p.title AS project_title, u.email AS owner_email
         FROM owner_disbursement_requests d
         JOIN projects p ON p.id=d.project_id
         JOIN users u ON u.id=d.owner_user_id
         WHERE d.id=$1`,
        [id],
      );
      return mapDisbursementRow(refreshed.rows[0]);
    });
  };

  proto.recordDisbursementPaid = async function recordDisbursementPaid(
    id,
    actorId,
    { payoutReference, payoutMethod, ledgerNote } = {},
  ) {
    return withTransaction(this.pool, async (client) => {
      const row = await loadDisbursementForUpdate(client, id);
      if (row.status !== 'approved') {
        throw new DomainError(
          'INVALID_DISBURSEMENT_TRANSITION',
          `Can only record paid from approved (current: ${row.status})`,
          409,
        );
      }
      const method = payoutMethod || 'bank_transfer_record';
      if (!['bank_transfer_record', 'cash_record', 'other_record'].includes(method)) {
        throw new DomainError('INVALID_PAYOUT_METHOD', 'Invalid payout method for staging record', 400);
      }
      await client.query(
        `UPDATE owner_disbursement_requests
         SET status='paid_recorded', paid_recorded_at=now(), paid_recorded_by=$2,
             payout_reference=$3, payout_method=$4, ledger_note=$5,
             funds_moved=false, updated_at=now()
         WHERE id=$1`,
        [
          id,
          actorId,
          payoutReference != null ? String(payoutReference).slice(0, 200) : null,
          method,
          ledgerNote != null ? String(ledgerNote).slice(0, 2000) : 'Staging display-only payout record',
        ],
      );
      await audit(client, actorId, 'owner_disbursement.paid_recorded', 'owner_disbursement_request', id, {
        fundsMoved: false,
        payoutMethod: method,
        payoutReference,
      });
      const refreshed = await client.query(
        `SELECT d.*, p.title AS project_title, u.email AS owner_email
         FROM owner_disbursement_requests d
         JOIN projects p ON p.id=d.project_id
         JOIN users u ON u.id=d.owner_user_id
         WHERE d.id=$1`,
        [id],
      );
      return mapDisbursementRow(refreshed.rows[0]);
    });
  };


  // ---- Investor / Owner directories + Customer Support profile ----

  proto.listAdminOverviewInvestors = async function listAdminOverviewInvestors({
    q = '',
    limit = 50,
    offset = 0,
  } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const params = [];
    const clauses = [`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_code='investor')`];
    if (q) {
      const raw = String(q).trim();
      params.push(`%${raw.toLowerCase()}%`);
      const p = params.length;
      clauses.push(`(
        lower(u.email) LIKE $${p}
        OR lower(coalesce(u.display_name,'')) LIKE $${p}
        OR coalesce(u.mobile,'') LIKE $${p}
        OR lower(coalesce(iv.legal_name,'')) LIKE $${p}
        OR lower(coalesce(ip.full_name,'')) LIKE $${p}
        OR lower(u.id::text) LIKE $${p}
      )`);
    }
    const whereSql = `WHERE ${clauses.join(' AND ')}`;
    params.push(lim, off);
    const result = await this.pool.query(
      `SELECT u.id, u.email, u.mobile, u.status, u.account_lifecycle, u.display_name, u.created_at,
              u.email_verified_at, u.phone_verified_at,
              iv.status AS identity_status, iv.legal_name,
              coalesce(ip.kyc_status, 'not_started') AS kyc_status,
              coalesce(ip.full_name, iv.legal_name, u.display_name) AS full_name,
              (SELECT COUNT(*)::int FROM allocations a WHERE a.investor_id=u.id AND a.status='active') AS active_allocations,
              (SELECT COUNT(*)::int FROM profile_review_requests pr
                WHERE pr.investor_user_id=u.id AND pr.status='pending') AS pending_review_requests
       FROM users u
       LEFT JOIN identity_verifications iv ON iv.user_id=u.id
       LEFT JOIN investor_profiles ip ON ip.user_id=u.id
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const countParams = params.slice(0, -2);
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::bigint AS c
       FROM users u
       LEFT JOIN identity_verifications iv ON iv.user_id=u.id
       LEFT JOIN investor_profiles ip ON ip.user_id=u.id
       ${whereSql}`,
      countParams,
    );
    return {
      items: result.rows.map((r) => ({
        id: r.id,
        email: r.email,
        mobile: r.mobile,
        displayName: r.full_name || r.display_name || r.email,
        status: r.status,
        accountLifecycle: r.account_lifecycle,
        identityStatus: r.identity_status || 'not_provided',
        kycStatus: r.kyc_status,
        emailVerified: Boolean(r.email_verified_at),
        phoneVerified: Boolean(r.phone_verified_at),
        activeAllocations: Number(r.active_allocations || 0),
        pendingReviewRequests: Number(r.pending_review_requests || 0),
        signupAt: r.created_at,
        role: 'investor',
      })),
      total: Number(countResult.rows[0].c),
      limit: lim,
      offset: off,
    };
  };

  proto.listAdminOverviewOwners = async function listAdminOverviewOwners({
    q = '',
    publishedOnly = false,
    limit = 50,
    offset = 0,
  } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const params = [];
    const clauses = [`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_code='project_owner')`];
    if (q) {
      const raw = String(q).trim();
      params.push(`%${raw.toLowerCase()}%`);
      const p = params.length;
      clauses.push(`(
        lower(u.email) LIKE $${p}
        OR lower(coalesce(u.display_name,'')) LIKE $${p}
        OR coalesce(u.mobile,'') LIKE $${p}
        OR lower(coalesce(iv.legal_name,'')) LIKE $${p}
        OR lower(u.id::text) LIKE $${p}
        OR EXISTS (
          SELECT 1 FROM businesses b2
          WHERE b2.owner_user_id=u.id AND lower(coalesce(b2.legal_name, b2.trade_name, '')) LIKE $${p}
        )
      )`);
    }
    if (publishedOnly === true || publishedOnly === 'true' || publishedOnly === '1') {
      params.push(['published', 'paused', 'funding_closed', 'active', 'completed']);
      clauses.push(`EXISTS (
        SELECT 1 FROM projects p
        JOIN businesses b ON b.id=p.business_id
        WHERE b.owner_user_id=u.id AND p.status = ANY($${params.length}::text[])
      )`);
    }
    const whereSql = `WHERE ${clauses.join(' AND ')}`;
    params.push(lim, off);
    const result = await this.pool.query(
      `SELECT u.id, u.email, u.mobile, u.status, u.account_lifecycle, u.display_name, u.created_at,
              u.email_verified_at, iv.status AS identity_status, iv.legal_name,
              (SELECT COUNT(*)::int FROM projects p JOIN businesses b ON b.id=p.business_id WHERE b.owner_user_id=u.id) AS project_count,
              (SELECT COUNT(*)::int FROM projects p JOIN businesses b ON b.id=p.business_id
                WHERE b.owner_user_id=u.id AND p.status = ANY(ARRAY['published','paused','funding_closed','active','completed'])) AS published_project_count,
              (SELECT b.verification_status FROM businesses b WHERE b.owner_user_id=u.id ORDER BY b.created_at DESC LIMIT 1) AS business_verification_status,
              (SELECT b.business_status FROM businesses b WHERE b.owner_user_id=u.id ORDER BY b.created_at DESC LIMIT 1) AS business_status
       FROM users u
       LEFT JOIN identity_verifications iv ON iv.user_id=u.id
       ${whereSql}
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const countParams = params.slice(0, -2);
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::bigint AS c
       FROM users u
       LEFT JOIN identity_verifications iv ON iv.user_id=u.id
       ${whereSql}`,
      countParams,
    );
    return {
      items: result.rows.map((r) => ({
        id: r.id,
        email: r.email,
        mobile: r.mobile,
        displayName: r.display_name || r.legal_name || r.email,
        status: r.status,
        accountLifecycle: r.account_lifecycle,
        identityStatus: r.identity_status || 'not_provided',
        businessVerificationStatus: r.business_verification_status || 'pending',
        businessStatus: r.business_status || null,
        projectCount: Number(r.project_count || 0),
        publishedProjectCount: Number(r.published_project_count || 0),
        emailVerified: Boolean(r.email_verified_at),
        signupAt: r.created_at,
        role: 'project_owner',
      })),
      total: Number(countResult.rows[0].c),
      limit: lim,
      offset: off,
      publishedOnly: Boolean(publishedOnly === true || publishedOnly === 'true' || publishedOnly === '1'),
    };
  };

  /**
   * Unified Admin Customer Support profile — support-safe (no private doc bytes).
   * Includes profile, transactions, owned projects, holdings/allocations, review requests, audit.
   */
  proto.getAdminCustomerSupportProfile = async function getAdminCustomerSupportProfile(userId) {
    const base = await this.getAdminUserProfile(userId);
    const roles = base.user?.roles || [];
    const isInvestor = roles.includes('investor');
    const isOwner = roles.includes('project_owner');

    // Enrich allocations with project titles
    const allocations = await this.pool.query(
      `SELECT a.id, a.project_id, a.units, a.investment_poisha, a.status, a.activated_at,
              p.title AS project_title, p.status AS project_status
       FROM allocations a
       JOIN projects p ON p.id = a.project_id
       WHERE a.investor_id = $1
       ORDER BY a.activated_at DESC NULLS LAST
       LIMIT 100`,
      [userId],
    ).catch(() => ({ rows: [] }));

    const applications = await this.pool.query(
      `SELECT ia.id, ia.project_id, ia.units, ia.status, ia.total_payable_poisha, ia.investment_poisha,
              ia.administration_fee_poisha, ia.created_at, ia.approved_at, ia.activated_at,
              p.title AS project_title
       FROM investment_applications ia
       JOIN projects p ON p.id = ia.project_id
       WHERE ia.investor_id = $1
       ORDER BY ia.created_at DESC
       LIMIT 100`,
      [userId],
    ).catch(() => ({ rows: [] }));

    const payments = await this.pool.query(
      `SELECT pay.id, pay.status, pay.amount_poisha, pay.method, pay.reference, pay.submitted_at,
              pay.verified_at, ia.id AS application_id, ia.project_id,
              p.title AS project_title
       FROM payments pay
       JOIN investment_applications ia ON ia.id = pay.application_id
       JOIN projects p ON p.id = ia.project_id
       WHERE ia.investor_id = $1
       ORDER BY pay.submitted_at DESC NULLS LAST
       LIMIT 100`,
      [userId],
    ).catch(() => ({ rows: [] }));

    const ownedProjects = await this.pool.query(
      `SELECT p.id, p.title, p.status, p.slug, p.total_units, p.active_units, p.reserved_units,
              p.unit_investment_poisha, p.created_at, p.updated_at, p.published_at,
              p.status_update_cadence_days, p.last_owner_status_update_at,
              p.status_update_overdue_flagged_at,
              CASE
                WHEN p.status = ANY(ARRAY['published','paused','funding_closed','active'])
                 AND COALESCE(p.last_owner_status_update_at, p.published_at, p.created_at)
                     < (now() - make_interval(days => COALESCE(p.status_update_cadence_days, 15)))
                THEN true ELSE false
              END AS status_update_overdue
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       WHERE b.owner_user_id = $1
       ORDER BY p.created_at DESC
       LIMIT 100`,
      [userId],
    ).catch(() => ({ rows: [] }));

    const businessesSafe = await this.pool.query(
      `SELECT id, legal_name, trade_name, verification_status, business_status, created_at
       FROM businesses WHERE owner_user_id=$1 ORDER BY created_at DESC`,
      [userId],
    ).catch(() => ({ rows: [] }));

    const kyc = await this.pool.query(
      `SELECT kyc_status, full_name, verification_status, created_at, updated_at
       FROM investor_profiles WHERE user_id=$1`,
      [userId],
    ).catch(() => ({ rows: [] }));

    const reviewRequests = await this.pool.query(
      `SELECT id, reason, required_fields, status, admin_note, created_at, updated_at,
              completed_at, completed_by, requested_by, support_case_id
       FROM profile_review_requests
       WHERE investor_user_id=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId],
    ).catch(() => ({ rows: [] }));

    // Strip private document fields from identity / businesses if present
    const identity = base.identity ? { ...base.identity } : null;
    if (identity) {
      for (const key of Object.keys(identity)) {
        if (/document|nid_image|selfie|file_bytes|storage_path|blob|scan/i.test(key)) {
          delete identity[key];
        }
      }
      // Keep status fields only for support
      identity.documentsPresent = Boolean(
        base.identity?.hasDocuments || base.identity?.documentCount || base.identity?.nidUploaded,
      );
    }

    return {
      supportSafe: true,
      note: 'Customer Support profile — statuses and transaction summaries only; private document bytes never returned.',
      user: base.user,
      identity,
      profileCompletion: base.profileCompletion,
      kyc: kyc.rows[0]
        ? {
            kycStatus: kyc.rows[0].kyc_status,
            fullName: kyc.rows[0].full_name,
            verificationStatus: kyc.rows[0].verification_status,
            updatedAt: kyc.rows[0].updated_at,
          }
        : { kycStatus: 'not_started' },
      businesses: businessesSafe.rows.map((b) => ({
        id: b.id,
        legalName: b.legal_name,
        tradeName: b.trade_name,
        verificationStatus: b.verification_status,
        businessStatus: b.business_status,
        createdAt: b.created_at,
      })),
      roles: {
        isInvestor,
        isOwner,
        codes: roles,
      },
      sections: {
        profile: true,
        transactions: isInvestor || payments.rows.length > 0 || applications.rows.length > 0,
        holdings: isInvestor || allocations.rows.length > 0,
        projects: isOwner || ownedProjects.rows.length > 0,
        reviewRequests: true,
        audit: true,
      },
      transactions: {
        applications: applications.rows.map((r) => ({
          id: r.id,
          projectId: r.project_id,
          projectTitle: r.project_title,
          units: Number(r.units),
          status: r.status,
          investmentPoisha: Number(r.investment_poisha),
          administrationFeePoisha: Number(r.administration_fee_poisha),
          totalPayablePoisha: Number(r.total_payable_poisha),
          createdAt: r.created_at,
          approvedAt: r.approved_at,
          activatedAt: r.activated_at,
        })),
        payments: payments.rows.map((r) => ({
          id: r.id,
          applicationId: r.application_id,
          projectId: r.project_id,
          projectTitle: r.project_title,
          status: r.status,
          amountPoisha: Number(r.amount_poisha),
          method: r.method,
          reference: r.reference ? String(r.reference).slice(0, 64) : null,
          submittedAt: r.submitted_at,
          verifiedAt: r.verified_at,
        })),
      },
      holdings: allocations.rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectTitle: r.project_title,
        projectStatus: r.project_status,
        units: Number(r.units),
        investmentPoisha: Number(r.investment_poisha),
        status: r.status,
        activatedAt: r.activated_at,
      })),
      projects: ownedProjects.rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        slug: r.slug,
        totalUnits: Number(r.total_units),
        activeUnits: Number(r.active_units),
        reservedUnits: Number(r.reserved_units),
        unitInvestmentPoisha: Number(r.unit_investment_poisha),
        statusUpdateCadenceDays: Number(r.status_update_cadence_days || 15),
        lastOwnerStatusUpdateAt: r.last_owner_status_update_at,
        statusUpdateOverdue: Boolean(r.status_update_overdue),
        statusUpdateOverdueFlaggedAt: r.status_update_overdue_flagged_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        publishedAt: r.published_at,
      })),
      profileReviewRequests: reviewRequests.rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        requiredFields: Array.isArray(r.required_fields) ? r.required_fields : r.required_fields || [],
        status: r.status,
        adminNote: r.admin_note,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        completedAt: r.completed_at,
        completedBy: r.completed_by,
        requestedBy: r.requested_by,
        supportCaseId: r.support_case_id,
      })),
      relatedPersonsSummary: (base.relatedPersonsSummary || []).map((rp) => ({
        id: rp.id,
        relationship: rp.relationship,
        fullName: rp.full_name,
        isMinor: rp.is_minor,
        createdAt: rp.created_at,
      })),
      auditLogs: (base.auditLogs || []).slice(0, 50).map((a) => ({
        id: a.id,
        action: a.action,
        subjectType: a.subject_type,
        subjectId: a.subject_id,
        reason: a.reason,
        occurredAt: a.occurred_at,
      })),
      hardDeleteBlocked: true,
    };
  };

  proto.createProfileReviewRequest = async function createProfileReviewRequest(
    actorId,
    investorUserId,
    { reason, requiredFields = [], adminNote = null } = {},
  ) {
    const why = String(reason || '').trim();
    if (why.length < 5) {
      throw new DomainError('REASON_REQUIRED', 'reason must be at least 5 characters', 400);
    }
    const fields = Array.isArray(requiredFields)
      ? requiredFields.map((f) => String(f).trim()).filter(Boolean).slice(0, 20)
      : [];
    const userCheck = await this.pool.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id=u.id AND ur.role_code='investor'
       WHERE u.id=$1 LIMIT 1`,
      [investorUserId],
    );
    if (!userCheck.rowCount) {
      throw new DomainError('INVESTOR_NOT_FOUND', 'Investor user not found', 404);
    }
    return withTransaction(this.pool, async (client) => {
      // Optional linked support case so investor sees a message
      const subject = `Profile review requested: ${why.slice(0, 80)}`;
      const desc = [
        'An administrator requested that you update your profile.',
        `Reason: ${why}`,
        fields.length ? `Required fields: ${fields.join(', ')}` : null,
        adminNote ? `Note: ${String(adminNote).slice(0, 500)}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      const sc = await client.query(
        `INSERT INTO support_cases(opened_by, subject, description, priority, status, category, unread_for_user, last_message_at, updated_at)
         VALUES ($1,$2,$3,'normal','waiting_user','kyc',1,now(),now())
         RETURNING id`,
        [investorUserId, subject, desc],
      );
      const supportCaseId = sc.rows[0].id;
      await client.query(
        `INSERT INTO support_messages(case_id, sender_id, body, is_staff, is_internal_note)
         VALUES ($1,$2,$3,true,false)`,
        [supportCaseId, actorId, desc],
      );

      const result = await client.query(
        `INSERT INTO profile_review_requests(
           investor_user_id, requested_by, reason, required_fields, status, support_case_id, admin_note
         ) VALUES ($1,$2,$3,$4::jsonb,'pending',$5,$6)
         RETURNING *`,
        [
          investorUserId,
          actorId,
          why,
          JSON.stringify(fields),
          supportCaseId,
          adminNote != null ? String(adminNote).slice(0, 2000) : null,
        ],
      );
      const row = result.rows[0];
      await audit(client, actorId, 'profile_review_request.created', 'profile_review_request', row.id, {
        investorUserId,
        reason: why,
        requiredFields: fields,
        supportCaseId,
      });
      return {
        id: row.id,
        investorUserId: row.investor_user_id,
        reason: row.reason,
        requiredFields: fields,
        status: row.status,
        supportCaseId,
        createdAt: row.created_at,
      };
    });
  };

  proto.completeProfileReviewRequest = async function completeProfileReviewRequest(
    actorId,
    requestId,
    { adminNote = null, status = 'done' } = {},
  ) {
    const st = String(status || 'done');
    if (!['done', 'cancelled'].includes(st)) {
      throw new DomainError('INVALID_STATUS', 'status must be done|cancelled', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const cur = await client.query(
        `SELECT * FROM profile_review_requests WHERE id=$1 FOR UPDATE`,
        [requestId],
      );
      if (!cur.rowCount) throw new DomainError('NOT_FOUND', 'Profile review request not found', 404);
      if (cur.rows[0].status !== 'pending') {
        throw new DomainError('INVALID_STATE', 'Request is not pending', 409);
      }
      const updated = await client.query(
        `UPDATE profile_review_requests
         SET status=$2, completed_at=now(), completed_by=$3, admin_note=COALESCE($4, admin_note), updated_at=now()
         WHERE id=$1
         RETURNING *`,
        [requestId, st, actorId, adminNote != null ? String(adminNote).slice(0, 2000) : null],
      );
      const row = updated.rows[0];
      await audit(client, actorId, `profile_review_request.${st}`, 'profile_review_request', row.id, {
        investorUserId: row.investor_user_id,
      });
      return {
        id: row.id,
        status: row.status,
        completedAt: row.completed_at,
        completedBy: row.completed_by,
      };
    });
  };

  proto.listMyProfileReviewRequests = async function listMyProfileReviewRequests(userId) {
    const result = await this.pool.query(
      `SELECT id, reason, required_fields, status, admin_note, created_at, completed_at
       FROM profile_review_requests
       WHERE investor_user_id=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      requiredFields: Array.isArray(r.required_fields) ? r.required_fields : r.required_fields || [],
      status: r.status,
      adminNote: r.admin_note,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }));
  };

  proto.listProjectUpdateOverdue = async function listProjectUpdateOverdue({ limit = 100 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const result = await this.pool.query(
      `SELECT p.id, p.title, p.status, p.status_update_cadence_days, p.last_owner_status_update_at,
              p.published_at, p.created_at, p.status_update_overdue_flagged_at,
              b.owner_user_id, u.email AS owner_email, u.display_name AS owner_name,
              EXTRACT(EPOCH FROM (
                now() - COALESCE(p.last_owner_status_update_at, p.published_at, p.created_at)
              )) / 86400.0 AS days_since_update
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       JOIN users u ON u.id = b.owner_user_id
       WHERE p.status = ANY($1::text[])
         AND COALESCE(p.last_owner_status_update_at, p.published_at, p.created_at)
             < (now() - make_interval(days => COALESCE(p.status_update_cadence_days, 15)))
       ORDER BY days_since_update DESC
       LIMIT $2`,
      [['published', 'paused', 'funding_closed', 'active'], lim],
    );
    return result.rows.map((r) => ({
      projectId: r.id,
      title: r.title,
      status: r.status,
      cadenceDays: Number(r.status_update_cadence_days || 15),
      lastOwnerStatusUpdateAt: r.last_owner_status_update_at,
      daysSinceUpdate: Math.floor(Number(r.days_since_update || 0)),
      overdueByDays: Math.max(
        0,
        Math.floor(Number(r.days_since_update || 0)) - Number(r.status_update_cadence_days || 15),
      ),
      flaggedAt: r.status_update_overdue_flagged_at,
      ownerUserId: r.owner_user_id,
      ownerEmail: r.owner_email,
      ownerName: r.owner_name,
    }));
  };

  proto.setProjectStatusUpdateCadence = async function setProjectStatusUpdateCadence(
    actorId,
    projectId,
    cadenceDays,
  ) {
    const n = Number(cadenceDays);
    if (![7, 15, 30].includes(n)) {
      throw new DomainError('INVALID_CADENCE', 'statusUpdateCadenceDays must be 7, 15, or 30', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE projects SET status_update_cadence_days=$2, updated_at=now()
         WHERE id=$1 RETURNING id, title, status_update_cadence_days`,
        [projectId, n],
      );
      if (!updated.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404);
      await audit(client, actorId, 'project.status_update_cadence_set', 'project', projectId, {
        statusUpdateCadenceDays: n,
      });
      return {
        projectId: updated.rows[0].id,
        title: updated.rows[0].title,
        statusUpdateCadenceDays: Number(updated.rows[0].status_update_cadence_days),
      };
    });
  };

  proto.actOnProjectUpdateOverdue = async function actOnProjectUpdateOverdue(
    actorId,
    projectId,
    { action, note = null } = {},
  ) {
    const act = String(action || '').trim();
    if (!['nudge', 'flag', 'unflag'].includes(act)) {
      throw new DomainError('INVALID_ACTION', 'action must be nudge|flag|unflag', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const proj = await client.query(
        `SELECT p.id, p.title, b.owner_user_id
         FROM projects p
         JOIN businesses b ON b.id=p.business_id
         WHERE p.id=$1
         FOR UPDATE OF p`,
        [projectId],
      );
      if (!proj.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404);
      const ownerId = proj.rows[0].owner_user_id;
      const title = proj.rows[0].title;
      let supportCaseId = null;

      if (act === 'nudge') {
        const body = [
          `Reminder: please post a status update for project "${title}".`,
          note ? `Admin note: ${String(note).slice(0, 500)}` : null,
          'Updates are required every 7/15/30 days per project cadence (default 15).',
        ]
          .filter(Boolean)
          .join('\n');
        const sc = await client.query(
          `INSERT INTO support_cases(opened_by, project_id, subject, description, priority, status, category, unread_for_user, last_message_at, updated_at)
           VALUES ($1,$2,$3,$4,'normal','waiting_user','project',1,now(),now())
           RETURNING id`,
          [ownerId, projectId, `Project update overdue: ${title}`.slice(0, 120), body],
        );
        supportCaseId = sc.rows[0].id;
        await client.query(
          `INSERT INTO support_messages(case_id, sender_id, body, is_staff, is_internal_note)
           VALUES ($1,$2,$3,true,false)`,
          [supportCaseId, actorId, body],
        );
      } else if (act === 'flag') {
        await client.query(
          `UPDATE projects SET status_update_overdue_flagged_at=now(), status_update_overdue_flagged_by=$2, updated_at=now()
           WHERE id=$1`,
          [projectId, actorId],
        );
      } else if (act === 'unflag') {
        await client.query(
          `UPDATE projects SET status_update_overdue_flagged_at=NULL, status_update_overdue_flagged_by=NULL, updated_at=now()
           WHERE id=$1`,
          [projectId],
        );
      }

      const actionRow = await client.query(
        `INSERT INTO project_update_overdue_actions(project_id, actor_id, action, note, support_case_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [projectId, actorId, act, note != null ? String(note).slice(0, 2000) : null, supportCaseId],
      );
      await client.query(
        `INSERT INTO project_status_update_history(project_id, author_id, source, body, meta)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          projectId,
          actorId,
          act === 'nudge' ? 'nudge' : act === 'flag' ? 'flag' : 'unflag',
          note || `${act} by admin`,
          JSON.stringify({ supportCaseId, actionId: actionRow.rows[0].id }),
        ],
      );
      await audit(client, actorId, `project_update_overdue.${act}`, 'project', projectId, {
        note,
        supportCaseId,
        actionId: actionRow.rows[0].id,
      });
      return {
        projectId,
        action: act,
        supportCaseId,
        actionId: actionRow.rows[0].id,
        createdAt: actionRow.rows[0].created_at,
      };
    });
  };

  proto.listProjectStatusUpdateHistory = async function listProjectStatusUpdateHistory(projectId, { limit = 50 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const result = await this.pool.query(
      `SELECT id, project_id, author_id, source, body, project_update_id, meta, occurred_at
       FROM project_status_update_history
       WHERE project_id=$1
       ORDER BY occurred_at DESC
       LIMIT $2`,
      [projectId, lim],
    );
    return result.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      authorId: r.author_id,
      source: r.source,
      body: r.body,
      projectUpdateId: r.project_update_id,
      meta: r.meta,
      occurredAt: r.occurred_at,
    }));
  };

    /** Filtered allocations list (extends base filters with investorId / q). */
  proto.listAdminAllocationsFiltered = async function listAdminAllocationsFiltered({
    status = 'active',
    projectId = null,
    investorId = null,
    q = null,
    limit = 100,
  } = {}) {
    const base = await this.listAdminAllocations({ status, projectId, limit: Math.min(Math.max(Number(limit) || 100, 1), 500) });
    let rows = base;
    if (investorId) {
      rows = rows.filter((r) => String(r.investorId || r.investor_id) === String(investorId));
    }
    if (q) {
      const needle = String(q).trim().toLowerCase();
      rows = rows.filter((r) => {
        const hay = `${r.investorEmail || ''} ${r.investorName || ''} ${r.projectTitle || ''}`.toLowerCase();
        return hay.includes(needle);
      });
    }
    return rows.map((r) => ({
      ...r,
      projectId: r.projectId || r.project_id,
      investorId: r.investorId || r.investor_id,
      projectTitle: r.projectTitle || r.project_title,
    }));
  };
}
