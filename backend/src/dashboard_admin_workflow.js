/**
 * Dashboard + Admin workflow pack — layouts, admin-created investors/projects,
 * messaging centre extensions, disbursement stages, owner investments,
 * verified funds raised, dual-role preference.
 * Attached onto PostgresGrowBangladeshService.prototype.
 */
import { DomainError } from './domain.js';
import { withTransaction } from './db.js';
import { hashPassword, randomToken } from './crypto_util.js';
import { ROLES } from './roles.js';
import {
  PROJECT_WORKFLOW_STATUS,
  mapProjectRow,
  validateProjectPayload,
  assertTransition,
  assertSafeInteger,
  slugifyTitle,
  buildProjectCode,
} from './project_workflow.js';
import { yearsToDurationDays } from './project_owner_pack.js';

export const DEFAULT_CARD_ORDER = Object.freeze({
  admin: [
    'pending_project_reviews',
    'correction_requests',
    'pending_investment_applications',
    'payment_verification_queue',
    'scheduled_disbursements',
    'investor_verification_queue',
    'owner_verification_queue',
    'unread_messages',
    'active_projects',
    'paused_projects',
    'completed_projects',
    'total_shares_sold',
    'total_funds_confirmed',
  ],
  investor: [
    'active_share_purchases',
    'pending_applications',
    'payments_due',
    'payment_verification_status',
    'confirmed_investment',
    'projected_profit',
    'maturity_schedule',
    'exit_requests',
    'referral_earnings',
    'unread_messages',
    'verification_completion',
  ],
  owner: [
    'draft',
    'submitted',
    'under_review',
    'correction_required',
    'approved',
    'published',
    'paused',
    'fully_funded',
    'rejected',
    'completed',
    'total_funds_raised',
    'unread_messages',
    'my_investments',
  ],
});

function uuidOrNull(v) {
  if (!v) return null;
  const s = String(v);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
}

async function audit(client, actorId, action, subjectType, subjectId, detail = {}, meta = {}) {
  const afterPayload = meta.after != null ? meta.after : detail;
  const sid = uuidOrNull(subjectId) || '00000000-0000-4000-8000-000000000019';
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

function normalizeEmail(email) {
  if (!email) return null;
  return String(email).trim().toLowerCase();
}

function normalizeMobile(mobile) {
  if (!mobile) return null;
  const cleaned = String(mobile).replace(/[^\d+]/g, '');
  return cleaned || null;
}

function requireText(value, name, min = 1, max = 2000) {
  const t = String(value || '').trim();
  if (t.length < min || t.length > max) {
    throw new DomainError('INVALID_TEXT', `${name} must be ${min}–${max} characters`, 400);
  }
  return t;
}

/** Verified funds = sum of verified (non-reversed) payments for project(s). */
export async function sumVerifiedFundsPoisha(client, { projectId = null, ownerUserId = null } = {}) {
  const params = [];
  let sql = `
    SELECT COALESCE(SUM(pay.amount_poisha), 0)::bigint AS total
    FROM payments pay
    JOIN investment_applications ia ON ia.id = pay.application_id
    JOIN projects p ON p.id = ia.project_id
    JOIN businesses b ON b.id = p.business_id
    WHERE pay.status = 'verified'
      AND pay.status IS DISTINCT FROM 'reversed'
  `;
  // status already verified; reversed is separate status — keep explicit exclusion for clarity
  if (projectId) {
    params.push(projectId);
    sql += ` AND p.id = $${params.length}`;
  }
  if (ownerUserId) {
    params.push(ownerUserId);
    sql += ` AND b.owner_user_id = $${params.length}`;
  }
  const r = await client.query(sql, params);
  return Number(r.rows[0].total);
}

export function validateDisbursementStages(stages, { fundingTargetPoisha = null } = {}) {
  if (!Array.isArray(stages) || stages.length < 3) {
    throw new DomainError('STAGES_REQUIRED', 'At least 3 disbursement stages are required', 400);
  }
  if (stages.length > 20) {
    throw new DomainError('STAGES_TOO_MANY', 'At most 20 disbursement stages allowed', 400);
  }
  let pctSum = 0;
  let amountSum = 0;
  let usePct = false;
  let useAmt = false;
  const normalized = stages.map((s, i) => {
    const stageNumber = assertSafeInteger(s.stageNumber ?? i + 1, 'stageNumber', 1);
    const title = requireText(s.title, 'title', 1, 200);
    const percentBps = s.percentBps != null ? assertSafeInteger(s.percentBps, 'percentBps', 0) : null;
    const amountPoisha = s.amountPoisha != null ? assertSafeInteger(s.amountPoisha, 'amountPoisha', 0) : null;
    if (percentBps == null && amountPoisha == null) {
      throw new DomainError('STAGE_VALUE_REQUIRED', `Stage ${stageNumber} needs percentBps or amountPoisha`, 400);
    }
    if (percentBps != null) {
      usePct = true;
      pctSum += percentBps;
    }
    if (amountPoisha != null) {
      useAmt = true;
      amountSum += amountPoisha;
    }
    return {
      stageNumber,
      title,
      percentBps,
      amountPoisha,
      expectedReleaseDate: s.expectedReleaseDate || null,
      conditions: s.conditions ? String(s.conditions).slice(0, 4000) : null,
      status: s.status || 'planned',
      adminNote: s.adminNote ? String(s.adminNote).slice(0, 2000) : null,
    };
  });
  if (usePct && pctSum !== 10000) {
    throw new DomainError(
      'STAGES_PERCENT_INVALID',
      `Scheduled percentages must total exactly 100% (10000 bps); got ${pctSum}`,
      400,
    );
  }
  if (useAmt && fundingTargetPoisha != null && amountSum !== Number(fundingTargetPoisha)) {
    throw new DomainError(
      'STAGES_AMOUNT_INVALID',
      `Scheduled amounts must equal funding target ${fundingTargetPoisha}; got ${amountSum}`,
      400,
    );
  }
  return normalized;
}

export function calcInvestmentBreakdown({ units, unitInvestmentPoisha, administrationFeeBps }) {
  const u = assertSafeInteger(units, 'units', 1);
  const price = assertSafeInteger(unitInvestmentPoisha, 'unitInvestmentPoisha', 1);
  const feeBps = assertSafeInteger(administrationFeeBps, 'administrationFeeBps', 0);
  const base = u * price;
  const fee = Math.trunc((base * feeBps) / 10000);
  return {
    units: u,
    unitInvestmentPoisha: price,
    baseInvestmentPoisha: base,
    administrationFeeBps: feeBps,
    administrationFeePoisha: fee,
    totalPayablePoisha: base + fee,
  };
}

/**
 * @param {import('./postgres_service.js').PostgresGrowBangladeshService} proto
 */
export function attachDashboardAdminWorkflowMethods(proto) {
  // ---- Dashboard layouts ----
  proto.getDashboardLayout = async function getDashboardLayout(userId, roleShell) {
    const shell = String(roleShell || '').trim();
    if (!['admin', 'investor', 'owner'].includes(shell)) {
      throw new DomainError('INVALID_ROLE_SHELL', 'roleShell must be admin|investor|owner', 400);
    }
    const row = await this.pool.query(
      `SELECT card_order, updated_at FROM dashboard_layouts WHERE user_id=$1 AND role_shell=$2`,
      [userId, shell],
    );
    const defaults = [...DEFAULT_CARD_ORDER[shell]];
    if (!row.rowCount) {
      return { roleShell: shell, cardOrder: defaults, isDefault: true, updatedAt: null };
    }
    const order = Array.isArray(row.rows[0].card_order) ? row.rows[0].card_order.map(String) : defaults;
    // Keep unknown keys dropped; append any missing defaults at end
    const known = new Set(defaults);
    const cleaned = order.filter((k) => known.has(k));
    for (const k of defaults) if (!cleaned.includes(k)) cleaned.push(k);
    return {
      roleShell: shell,
      cardOrder: cleaned,
      isDefault: false,
      updatedAt: row.rows[0].updated_at,
    };
  };

  proto.putDashboardLayout = async function putDashboardLayout(userId, roleShell, cardOrder, meta = {}) {
    const shell = String(roleShell || '').trim();
    if (!['admin', 'investor', 'owner'].includes(shell)) {
      throw new DomainError('INVALID_ROLE_SHELL', 'roleShell must be admin|investor|owner', 400);
    }
    const defaults = DEFAULT_CARD_ORDER[shell];
    const known = new Set(defaults);
    if (!Array.isArray(cardOrder) || !cardOrder.length) {
      throw new DomainError('CARD_ORDER_REQUIRED', 'cardOrder array is required', 400);
    }
    const cleaned = [];
    for (const k of cardOrder) {
      const key = String(k);
      if (!known.has(key)) {
        throw new DomainError('UNKNOWN_CARD', `Unknown card key for ${shell}: ${key}`, 400);
      }
      if (!cleaned.includes(key)) cleaned.push(key);
    }
    for (const k of defaults) if (!cleaned.includes(k)) cleaned.push(k);
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO dashboard_layouts(user_id, role_shell, card_order, updated_at)
         VALUES ($1,$2,$3::jsonb,now())
         ON CONFLICT (user_id, role_shell)
         DO UPDATE SET card_order=EXCLUDED.card_order, updated_at=now()`,
        [userId, shell, JSON.stringify(cleaned)],
      );
      await audit(client, userId, 'dashboard_layout.saved', 'user', userId, { roleShell: shell, cardOrder: cleaned }, meta);
      return { roleShell: shell, cardOrder: cleaned, isDefault: false, updatedAt: new Date().toISOString() };
    });
  };

  proto.resetDashboardLayout = async function resetDashboardLayout(userId, roleShell, meta = {}) {
    const shell = String(roleShell || '').trim();
    if (!['admin', 'investor', 'owner'].includes(shell)) {
      throw new DomainError('INVALID_ROLE_SHELL', 'roleShell must be admin|investor|owner', 400);
    }
    return withTransaction(this.pool, async (client) => {
      await client.query(`DELETE FROM dashboard_layouts WHERE user_id=$1 AND role_shell=$2`, [userId, shell]);
      await audit(client, userId, 'dashboard_layout.reset', 'user', userId, { roleShell: shell }, meta);
      return {
        roleShell: shell,
        cardOrder: [...DEFAULT_CARD_ORDER[shell]],
        isDefault: true,
        updatedAt: null,
      };
    });
  };

  // ---- Preferred role shell (Investor / Project Owner / Admin) ----
  proto.getPreferredRoleShell = async function getPreferredRoleShell(userId) {
    const u = await this.pool.query(
      `SELECT preferred_role_shell FROM users WHERE id=$1`,
      [userId],
    );
    if (!u.rowCount) throw new DomainError('USER_NOT_FOUND', 'User not found', 404);
    const roles = await this.pool.query(`SELECT role_code FROM user_roles WHERE user_id=$1`, [userId]);
    const codes = roles.rows.map((r) => r.role_code);
    return {
      preferredRoleShell: u.rows[0].preferred_role_shell || null,
      availableShells: [
        ...(codes.includes(ROLES.INVESTOR) || codes.includes('investor') ? ['investor'] : []),
        ...(codes.includes(ROLES.PROJECT_OWNER) || codes.includes('project_owner') ? ['owner'] : []),
        ...(codes.includes(ROLES.SUPER_ADMIN) || codes.includes('super_admin') ? ['admin'] : []),
      ],
      roles: codes,
    };
  };

  proto.putPreferredRoleShell = async function putPreferredRoleShell(userId, shell, meta = {}) {
    const wanted = String(shell || '').trim();
    const map = { invest: 'investor', fundraise: 'owner', investor: 'investor', owner: 'owner', admin: 'admin' };
    const normalized = map[wanted];
    if (!normalized) {
      throw new DomainError('INVALID_ROLE_SHELL', 'preferredRoleShell must be investor|owner|admin (or invest|fundraise)', 400);
    }
    const roles = await this.pool.query(`SELECT role_code FROM user_roles WHERE user_id=$1`, [userId]);
    const codes = new Set(roles.rows.map((r) => r.role_code));
    const required =
      normalized === 'investor'
        ? 'investor'
        : normalized === 'owner'
          ? 'project_owner'
          : 'super_admin';
    if (!codes.has(required) && !(normalized === 'admin' && [...codes].some((c) => ['super_admin', 'finance_officer', 'support'].includes(c)))) {
      throw new DomainError(
        'ROLE_NOT_GRANTED',
        `Cannot select ${normalized} shell — account lacks required role (never auto-granted)`,
        403,
      );
    }
    return withTransaction(this.pool, async (client) => {
      await client.query(`UPDATE users SET preferred_role_shell=$2, updated_at=now() WHERE id=$1`, [
        userId,
        normalized,
      ]);
      await audit(client, userId, 'user.preferred_role_shell_set', 'user', userId, { preferredRoleShell: normalized }, meta);
      return { preferredRoleShell: normalized };
    });
  };

  // ---- Admin create investor ----
  proto.adminCreateInvestor = async function adminCreateInvestor(actorId, input = {}, meta = {}) {
    const fullName = requireText(input.fullName || input.displayName, 'fullName', 2, 200);
    const email = normalizeEmail(input.email);
    if (!email) throw new DomainError('EMAIL_REQUIRED', 'Email address is required', 400);
    const phone = normalizeMobile(input.phone || input.mobile);
    if (!phone) throw new DomainError('PHONE_REQUIRED', 'Phone number is required', 400);
    const reason = requireText(input.reason || 'Admin-created investor account', 'reason', 3, 2000);
    const referralSource = input.referralSource ? String(input.referralSource).slice(0, 200) : null;
    const accountStatus = ['active', 'pending_verification'].includes(input.accountStatus)
      ? input.accountStatus
      : 'active';
    const tempPassword =
      input.temporaryPassword && String(input.temporaryPassword).length >= 10
        ? String(input.temporaryPassword)
        : `Tmp!${randomToken(12)}`;
    const passwordHash = await hashPassword(tempPassword);

    const result = await withTransaction(this.pool, async (client) => {
      const dup = await client.query(
        `SELECT id FROM users WHERE email=$1 OR mobile=$2 LIMIT 1`,
        [email, phone],
      );
      if (dup.rowCount) {
        throw new DomainError('USER_EXISTS', 'A user with this email or phone already exists', 409);
      }
      const lifecycle = accountStatus === 'active' ? 'active' : 'pending';
      let ins;
      try {
        ins = await client.query(
          `INSERT INTO users(
             email, mobile, password_hash, status, display_name, account_lifecycle,
             created_by_admin, created_by_admin_id, created_by_admin_at, created_by_admin_reason,
             must_change_password, pending_legal_acceptance, admin_created_label, referral_source,
             email_verified_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,
             true,$7,now(),$8,
             true,true,'Admin-created account',$9,
             CASE WHEN $10::boolean THEN now() ELSE NULL END
           ) RETURNING *`,
          [email, phone, passwordHash, accountStatus, fullName, lifecycle, actorId, reason, referralSource, accountStatus === 'active'],
        );
      } catch (error) {
        if (error && error.code === '23505') {
          throw new DomainError('USER_EXISTS', 'A user with this email or phone already exists', 409);
        }
        throw new DomainError(
          'ADMIN_CREATE_INVESTOR_FAILED',
          `Admin create investor failed: ${error?.message || error}`,
          500,
        );
      }
      const user = ins.rows[0];
      await client.query(
        `INSERT INTO user_roles(user_id, role_code, granted_by) VALUES ($1,'investor',$2)
         ON CONFLICT DO NOTHING`,
        [user.id, actorId],
      );
      // Investor profile NOT marked verified — pending identity
      await client.query(
        `INSERT INTO investor_profiles(user_id, full_name, verification_status, kyc_status, phone)
         VALUES ($1,$2,'pending','not_started',$3)
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id, fullName, phone],
      );
      await audit(
        client,
        actorId,
        'admin.investor_created',
        'user',
        user.id,
        {
          email,
          phone,
          accountStatus,
          createdByAdmin: true,
          adminCreatedLabel: 'Admin-created account',
          mustChangePassword: true,
          kycVerified: false,
          nidVerified: false,
          selfieVerified: false,
          phoneVerified: false,
          note: 'Activation ≠ KYC — identity verification remains pending',
        },
        { ...meta, reason },
      );
      return {
        id: user.id,
        email: user.email,
        mobile: user.mobile,
        displayName: fullName,
        status: user.status,
        createdByAdmin: true,
        adminCreatedLabel: 'Admin-created account',
        mustChangePassword: true,
        kycStatus: 'not_started',
        identityVerification: {
          nidVerified: false,
          selfieVerified: false,
          phoneVerified: false,
          kycVerified: false,
        },
        temporaryPasswordIssued: true,
        // returned once to admin for staging invite; never log
        _temporaryPassword: tempPassword,
      };
    });

    let inviteEmail = { sent: false, adapter: 'none', detail: 'Invite not attempted' };
    try {
      const adapter = this.emailAdapter;
      if (adapter && typeof adapter.send === 'function') {
        const isMemory = adapter.constructor?.name === 'MemoryEmailAdapter' || !process.env.SMTP_HOST;
        await adapter.send({
          to: email,
          subject: 'Invest in Bangladesh — Admin-created account invitation (TEST/STAGING)',
          text: `Hello ${fullName},\n\nA Super Admin created an Invest in Bangladesh investor account for you (Admin-created account).\nYou must change your temporary password at first login.\nThis does NOT mean KYC/NID/phone are verified.\n\nEmail: ${email}\nTemporary password: ${result._temporaryPassword}\n\nStaging only — fictional TEST environment.`,
          html: `<p>Hello ${fullName},</p><p>A Super Admin created an <strong>Admin-created account</strong> for you on Invest in Bangladesh (TEST/STAGING).</p><p>You must change your temporary password at first login. <em>Activation ≠ KYC</em> — NID/selfie/phone remain unverified.</p><p>Email: ${email}<br/>Temporary password: <code>${result._temporaryPassword}</code></p>`,
        });
        inviteEmail = {
          sent: true,
          adapter: isMemory ? 'memory' : 'smtp',
          detail: isMemory
            ? 'Stored in memory email adapter (SMTP not configured) — honest staging status'
            : 'Invitation email sent via SMTP',
        };
      } else {
        inviteEmail = {
          sent: false,
          adapter: 'memory',
          detail: 'SMTP not configured — invite recorded as memory-adapter honest status (password returned to admin once)',
        };
      }
    } catch (err) {
      inviteEmail = {
        sent: false,
        adapter: process.env.SMTP_HOST ? 'smtp' : 'memory',
        detail: `Invite email failed: ${err?.message || 'unknown'}`,
      };
    }

    const { _temporaryPassword, ...safe } = result;
    return {
      ...safe,
      temporaryPassword: _temporaryPassword,
      inviteEmail,
    };
  };

  proto.changeRequiredPassword = async function changeRequiredPassword(userId, { currentPassword, newPassword }, meta = {}) {
    if (!currentPassword || !newPassword) {
      throw new DomainError('PASSWORD_REQUIRED', 'currentPassword and newPassword are required', 400);
    }
    if (String(newPassword).length < 10) {
      throw new DomainError('PASSWORD_WEAK', 'newPassword must be at least 10 characters', 400);
    }
    const { verifyPassword } = await import('./crypto_util.js');
    return withTransaction(this.pool, async (client) => {
      const u = await client.query(`SELECT * FROM users WHERE id=$1 FOR UPDATE`, [userId]);
      if (!u.rowCount) throw new DomainError('USER_NOT_FOUND', 'User not found', 404);
      const user = u.rows[0];
      if (!user.must_change_password) {
        throw new DomainError('PASSWORD_CHANGE_NOT_REQUIRED', 'Password change is not required', 409);
      }
      const ok = await verifyPassword(currentPassword, user.password_hash);
      if (!ok) throw new DomainError('INVALID_CREDENTIALS', 'Current password is incorrect', 401);
      const passwordHash = await hashPassword(newPassword);
      await client.query(
        `UPDATE users SET password_hash=$2, must_change_password=false, updated_at=now() WHERE id=$1`,
        [userId, passwordHash],
      );
      await client.query(
        `UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at, now())
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [userId],
      );
      await audit(client, userId, 'user.required_password_changed', 'user', userId, { mustChangePassword: false }, meta);
      return { ok: true, mustChangePassword: false };
    });
  };

  // ---- Admin create / lifecycle project ----
  proto.adminCreateProject = async function adminCreateProject(actorId, input = {}, meta = {}) {
    // Admin bypass of owner submission still requires mandatory commercial fields.
    // Use draft-level structural checks + explicit required fields (not full owner submit checklist).
    if (!input.summary) input.summary = input.overview || input.detailsText || input.description || '';
    if (!input.locationAddress) input.locationAddress = input.location || 'Staging address (admin-created)';
    if (!input.badLossSummary) input.badLossSummary = input.riskDisclosure || 'Staging risk summary — capital at risk.';
    if (!input.ownerExperience) input.ownerExperience = 'Assigned by Super Admin';
    if (!input.educationalBackground) input.educationalBackground = 'N/A — admin-created project';
    if (!input.categoryId && !input.category) input.category = 'manufacturing';
    if (input.selectedRateBps == null && input.estimatedYearlyProfitBps != null) {
      input.selectedRateBps = input.estimatedYearlyProfitBps;
    }
    if (input.selectedRateBps == null && input.targetProfitBps != null) {
      input.selectedRateBps = input.targetProfitBps;
    }
    if (input.selectedRateBps == null) input.selectedRateBps = 1200;
    if (input.administrationFeeBps == null) input.administrationFeeBps = 200;
    if (!input.riskDisclosure) input.riskDisclosure = 'Capital at risk. Staging fictional demo risk disclosure.';
    if (!input.termsText) input.termsText = 'Staging terms text for admin-created project.';
    if (!input.exitPolicy) input.exitPolicy = 'Exit subject to admin review on staging.';
    if (!input.title || String(input.title).trim().length < 5) {
      input.title = String(input.title || 'Admin project').trim() + ' staging';
    }
    try {
      validateProjectPayload(
        {
          ...input,
          fundingTargetException: Boolean(
            input.fundingTargetException || input.overrideReason || input.fundingTargetExceptionReason,
          ),
          fundingTargetExceptionReason:
            input.fundingTargetExceptionReason || input.overrideReason || input.fundingTargetOverrideReason,
        },
        input.publishNow || input.status === 'published' ? 'publish' : 'draft',
      );
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw err;
    }
    const title = requireText(input.title, 'title', 3, 200);
    const overview = requireText(input.overview || input.detailsText || input.description, 'overview', 10, 20000);
    const fundingPurpose = requireText(input.fundingPurpose || input.purpose || overview.slice(0, 500), 'fundingPurpose', 5, 4000);
    const totalUnits = assertSafeInteger(input.totalUnits, 'totalUnits', 1);
    const unitInvestmentPoisha = assertSafeInteger(input.unitInvestmentPoisha, 'unitInvestmentPoisha', 1);
    const administrationFeeBps = assertSafeInteger(input.administrationFeeBps ?? 200, 'administrationFeeBps', 0);
    const expectedTarget = totalUnits * unitInvestmentPoisha;
    let fundingTargetPoisha = assertSafeInteger(input.fundingTargetPoisha ?? expectedTarget, 'fundingTargetPoisha', 1);
    let overrideReason = null;
    if (fundingTargetPoisha !== expectedTarget) {
      overrideReason = requireText(
        input.fundingTargetExceptionReason || input.overrideReason || input.fundingTargetOverrideReason,
        'overrideReason',
        5,
        2000,
      );
    }
    const durationDays =
      input.durationDays != null
        ? assertSafeInteger(input.durationDays, 'durationDays', 1)
        : yearsToDurationDays(input.investmentYears ?? 1);
    const investmentYears =
      input.investmentYears != null
        ? assertSafeInteger(input.investmentYears, 'investmentYears', 1)
        : Math.max(1, Math.round(durationDays / 365));
    const projectedBps = assertSafeInteger(
      input.estimatedYearlyProfitBps ?? input.selectedRateBps ?? input.targetProfitBps ?? 1000,
      'projectedProfitBps',
      0,
    );
    const termsText = requireText(input.termsText || 'Staging terms — fictional TEST', 'termsText', 10, 50000);
    const riskText = requireText(input.riskDisclosure || input.riskText || 'Capital at risk. Staging fictional demo.', 'riskDisclosure', 10, 20000);
    const exitPolicy = requireText(input.exitPolicy || 'Exit subject to admin review. Staging only.', 'exitPolicy', 5, 20000);
    const ownerUserId = uuidOrNull(input.ownerUserId || input.projectOwnerId);
    if (!ownerUserId) {
      throw new DomainError('OWNER_REQUIRED', 'ownerUserId (project owner assignment) is required', 400);
    }
    const initialStatus = input.publishNow
      ? PROJECT_WORKFLOW_STATUS.PUBLISHED
      : input.status === 'draft' || !input.status
        ? PROJECT_WORKFLOW_STATUS.DRAFT
        : input.status === 'published'
          ? PROJECT_WORKFLOW_STATUS.PUBLISHED
          : PROJECT_WORKFLOW_STATUS.DRAFT;

    return withTransaction(this.pool, async (client) => {
      const owner = await client.query(`SELECT id FROM users WHERE id=$1`, [ownerUserId]);
      if (!owner.rowCount) throw new DomainError('OWNER_NOT_FOUND', 'Assigned owner user not found', 404);
      // Ensure owner role exists (do not grant investor)
      await client.query(
        `INSERT INTO user_roles(user_id, role_code, granted_by) VALUES ($1,'project_owner',$2)
         ON CONFLICT DO NOTHING`,
        [ownerUserId, actorId],
      );
      let biz = await client.query(
        `SELECT id FROM businesses WHERE owner_user_id=$1 ORDER BY created_at ASC LIMIT 1`,
        [ownerUserId],
      );
      let businessId;
      if (!biz.rowCount) {
        const created = await client.query(
          `INSERT INTO businesses(owner_user_id, legal_name, verification_status)
           VALUES ($1,$2,'pending') RETURNING id`,
          [ownerUserId, input.businessName || `${title} (admin-created)`],
        );
        businessId = created.rows[0].id;
      } else {
        businessId = biz.rows[0].id;
      }

      let category = input.category || null;
      let categoryId = uuidOrNull(input.categoryId);
      if (categoryId) {
        const cat = await client.query(`SELECT id, name, slug FROM categories WHERE id=$1`, [categoryId]);
        if (!cat.rowCount) throw new DomainError('CATEGORY_NOT_FOUND', 'Category not found', 404);
        category = cat.rows[0].slug || cat.rows[0].name;
      } else if (category) {
        const cat = await client.query(
          `SELECT id, name, slug FROM categories WHERE slug=$1 OR name=$1 LIMIT 1`,
          [String(category)],
        );
        if (cat.rowCount) {
          categoryId = cat.rows[0].id;
          category = cat.rows[0].slug || cat.rows[0].name;
        }
      }
      if (!category) category = 'general';

      const slugBase = slugifyTitle(title);
      const slug = `${slugBase}-${Date.now().toString(36)}`;
      const summary = requireText(input.summary || overview.slice(0, 500), 'summary', 5, 4000);
      const projectId = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
      const projectCode = buildProjectCode(projectId);
      let ins;
      try {
        ins = await client.query(
          `INSERT INTO projects(
             id, business_id, title, summary, slug, project_code, category, category_id, status,
             total_units, reserved_units, active_units,
             unit_investment_poisha, administration_fee_bps, funding_target_poisha,
             funding_target_exception, funding_target_exception_reason,
             target_profit_bps, selected_rate_bps,
             projected_return_min_bps, projected_return_max_bps,
             duration_days, minimum_exit_days, investment_years, estimated_yearly_profit_bps,
             terms_text, risk_disclosure, exit_policy,
             details_text, location_address,
             bad_loss_summary, owner_experience, educational_background,
             funding_opens_at, funding_closes_at,
             version_number,
             created_by_admin, created_by_admin_id, created_by_admin_at,
             admin_created_label,
             application_payment_deadline_at,
             published_at, published_terms_version
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,
             $10,0,0,
             $11,$12,$13,
             $14,$15,
             $16,$16,
             $17,$18,
             $19,180,$20,$16,
             $21,$22,$23,
             $24,$25,
             $26,$27,$28,
             $29,$30,
             1,
             true,$31,now(),
             'Created by Super Admin',
             $32,
             CASE WHEN $9='published' THEN now() ELSE NULL END,
             CASE WHEN $9='published' THEN 1 ELSE NULL END
           ) RETURNING *`,
          [
            projectId,
            businessId,
            title,
            summary,
            slug,
            projectCode,
            category,
            categoryId,
            initialStatus,
            totalUnits,
            unitInvestmentPoisha,
            administrationFeeBps,
            fundingTargetPoisha,
            Boolean(overrideReason),
            overrideReason,
            projectedBps,
            assertSafeInteger(input.projectedReturnMinBps ?? Math.max(0, projectedBps - 200), 'projectedReturnMinBps', 0),
            assertSafeInteger(input.projectedReturnMaxBps ?? projectedBps + 200, 'projectedReturnMaxBps', 0),
            durationDays,
            investmentYears,
            termsText,
            riskText,
            exitPolicy,
            overview,
            input.locationAddress || 'Staging address (admin-created)',
            input.badLossSummary || riskText,
            input.ownerExperience || 'Assigned by Super Admin',
            input.educationalBackground || 'N/A — admin-created project',
            input.fundingOpensAt || null,
            input.fundingClosesAt || input.applicationPaymentDeadline || null,
            actorId,
            input.applicationPaymentDeadline || input.paymentDeadline || null,
          ],
        );
      } catch (error) {
        throw new DomainError(
          'ADMIN_CREATE_PROJECT_FAILED',
          `Admin create project failed: ${error?.message || error}`,
          500,
        );
      }
      const project = ins.rows[0];
      const code = project.project_code || projectCode;
      if (initialStatus === PROJECT_WORKFLOW_STATUS.PUBLISHED) {
        const { createHash } = await import('node:crypto');
        const termsJson = JSON.stringify({
          unitInvestmentPoisha,
          administrationFeeBps,
          totalUnits,
          fundingTargetPoisha,
          selectedRateBps: projectedBps,
          durationDays,
          riskDisclosure: riskText,
          termsText,
          exitPolicy,
          createdByAdmin: true,
        });
        const contentHash = createHash('sha256').update(termsJson).digest('hex');
        await client.query(
          `INSERT INTO project_terms(project_id, version, terms_json, content_hash, approved_by)
           VALUES ($1,1,$2::jsonb,$3,$4)
           ON CONFLICT (project_id, version) DO NOTHING`,
          [project.id, termsJson, contentHash, actorId],
        );
        await client.query(
          `UPDATE projects
           SET published_terms_version=1,
               published_at=COALESCE(published_at, now()),
               funding_opens_at=COALESCE(funding_opens_at, now()),
               funding_closes_at=COALESCE(funding_closes_at, now() + (duration_days || ' days')::interval),
               project_starts_at=COALESCE(project_starts_at, now()),
               project_ends_at=COALESCE(project_ends_at, now() + (duration_days || ' days')::interval)
           WHERE id=$1`,
          [project.id],
        );
      }
      await client.query(
        `INSERT INTO project_status_history(project_id, from_status, to_status, actor_id, reason, meta_json)
         VALUES ($1,NULL,$2,$3,$4,$5::jsonb)`,
        [
          project.id,
          initialStatus,
          actorId,
          'Admin-created project',
          JSON.stringify({ createdByAdmin: true, fundingPurpose }),
        ],
      );
      if (Array.isArray(input.disbursementStages) && input.disbursementStages.length) {
        const stages = validateDisbursementStages(input.disbursementStages, { fundingTargetPoisha });
        for (const st of stages) {
          await client.query(
            `INSERT INTO project_disbursement_stages(
               project_id, stage_number, title, percent_bps, amount_poisha,
               expected_release_date, conditions, status, admin_note, created_by, updated_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,'planned',$8,$9,$9)`,
            [
              project.id,
              st.stageNumber,
              st.title,
              st.percentBps,
              st.amountPoisha,
              st.expectedReleaseDate,
              st.conditions,
              st.adminNote,
              actorId,
            ],
          );
        }
      }
      await audit(
        client,
        actorId,
        'admin.project_created',
        'project',
        project.id,
        { ...mapProjectRow(project), createdByAdmin: true, adminCreatedLabel: 'Created by Super Admin' },
        { ...meta, reason: input.reason || 'Admin-created project' },
      );
      return {
        ...mapProjectRow(project),
        projectCode: code,
        createdByAdmin: true,
        adminCreatedLabel: 'Created by Super Admin',
        fundingPurpose,
      };
    });
  };

  proto.adminProjectLifecycle = async function adminProjectLifecycle(projectId, actorId, action, meta = {}) {
    const allowed = {
      publish: PROJECT_WORKFLOW_STATUS.PUBLISHED,
      pause: PROJECT_WORKFLOW_STATUS.PAUSED,
      deactivate: PROJECT_WORKFLOW_STATUS.FUNDING_CLOSED,
      archive: PROJECT_WORKFLOW_STATUS.ARCHIVED,
      draft: PROJECT_WORKFLOW_STATUS.DRAFT,
    };
    const to = allowed[action];
    if (!to) throw new DomainError('INVALID_ACTION', 'action must be publish|pause|deactivate|archive|draft', 400);
    return withTransaction(this.pool, async (client) => {
      const r = await client.query(`SELECT * FROM projects WHERE id=$1 FOR UPDATE`, [projectId]);
      if (!r.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404);
      const before = r.rows[0];
      // Admin bypass for admin-created; still record history. For non-admin-created use assertTransition when possible.
      try {
        if (before.status !== to) assertTransition(before.status, to);
      } catch (err) {
        if (!before.created_by_admin) throw err;
        // admin-created projects may jump draft→published
      }
      const upd = await client.query(
        `UPDATE projects SET status=$2,
           published_at=CASE WHEN $2='published' THEN COALESCE(published_at, now()) ELSE published_at END,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [projectId, to],
      );
      await client.query(
        `INSERT INTO project_status_history(project_id, from_status, to_status, actor_id, reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [projectId, before.status, to, actorId, meta.reason || `admin.${action}`],
      );
      await audit(client, actorId, `admin.project_${action}`, 'project', projectId, mapProjectRow(upd.rows[0]), {
        ...meta,
        before: { status: before.status },
      });
      return mapProjectRow(upd.rows[0]);
    });
  };

  // ---- Messaging centre extensions ----
  proto.adminMessagingOverview = async function adminMessagingOverview() {
    const r = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved'))::int AS open_count,
         COALESCE(SUM(unread_for_staff),0)::int AS unread_staff,
         COUNT(*) FILTER (WHERE assigned_to IS NULL AND status NOT IN ('closed','resolved'))::int AS unassigned
       FROM support_cases`,
    );
    return r.rows[0];
  };

  proto.adminAssignSupportCase = async function adminAssignSupportCase(caseId, actorId, assigneeId, meta = {}) {
    const assignee = uuidOrNull(assigneeId) || actorId;
    return withTransaction(this.pool, async (client) => {
      const upd = await client.query(
        `UPDATE support_cases SET assigned_to=$2, status=CASE WHEN status='open' THEN 'under_review' ELSE status END, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [caseId, assignee],
      );
      if (!upd.rowCount) throw new DomainError('NOT_FOUND', 'Support case not found', 404);
      await audit(client, actorId, 'support_case.assigned', 'support_case', caseId, { assignedTo: assignee }, meta);
      return upd.rows[0];
    });
  };

  proto.adminAddSupportInternalNote = async function adminAddSupportInternalNote(caseId, actorId, body, meta = {}) {
    const text = requireText(body, 'body', 1, 4000);
    return withTransaction(this.pool, async (client) => {
      const c = await client.query(`SELECT id FROM support_cases WHERE id=$1`, [caseId]);
      if (!c.rowCount) throw new DomainError('NOT_FOUND', 'Support case not found', 404);
      const msg = await client.query(
        `INSERT INTO support_messages(case_id, sender_id, body, is_staff, is_internal_note)
         VALUES ($1,$2,$3,true,true) RETURNING *`,
        [caseId, actorId, text],
      );
      await client.query(
        `UPDATE support_cases SET last_message_at=now(), updated_at=now() WHERE id=$1`,
        [caseId],
      );
      await audit(client, actorId, 'support_message.internal_note', 'support_case', caseId, { messageId: msg.rows[0].id }, meta);
      return {
        id: msg.rows[0].id,
        caseId,
        body: text,
        isStaff: true,
        isInternalNote: true,
        createdAt: msg.rows[0].created_at,
      };
    });
  };

  proto.adminReopenSupportCase = async function adminReopenSupportCase(caseId, actorId, meta = {}) {
    return withTransaction(this.pool, async (client) => {
      const upd = await client.query(
        `UPDATE support_cases
         SET status='open', reopened_at=now(), closed_at=NULL, resolved_at=NULL, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [caseId],
      );
      if (!upd.rowCount) throw new DomainError('NOT_FOUND', 'Support case not found', 404);
      await audit(client, actorId, 'support_case.reopened', 'support_case', caseId, {}, meta);
      return upd.rows[0];
    });
  };

  // Patch getSupportCase to hide internal notes from non-staff — wrap existing if present
  const prevGetSupportCase = proto.getSupportCase;
  if (typeof prevGetSupportCase === 'function') {
    proto.getSupportCase = async function getSupportCasePatched(caseId, actorId, opts = {}) {
      const data = await prevGetSupportCase.call(this, caseId, actorId, opts);
      if (!opts.isStaff && Array.isArray(data.messages)) {
        data.messages = data.messages.filter((m) => !m.isInternalNote && !m.is_internal_note);
      }
      return data;
    };
  }

  const prevAddSupportMessage = proto.addSupportMessage;
  if (typeof prevAddSupportMessage === 'function') {
    proto.addSupportMessage = async function addSupportMessagePatched(caseId, actorId, input, opts = {}, meta = {}) {
      const isInternal = Boolean(input.isInternalNote || input.internalNote);
      if (isInternal) {
        if (!opts.isStaff) throw new DomainError('FORBIDDEN', 'Only staff can add internal notes', 403);
        return this.adminAddSupportInternalNote(caseId, actorId, input.body || input.message, meta);
      }
      const msg = await prevAddSupportMessage.call(this, caseId, actorId, input, opts, meta);
      // bump unread counters
      try {
        if (opts.isStaff) {
          await this.pool.query(
            `UPDATE support_cases SET unread_for_user = unread_for_user + 1, last_message_at=now(), updated_at=now() WHERE id=$1`,
            [caseId],
          );
        } else {
          await this.pool.query(
            `UPDATE support_cases SET unread_for_staff = unread_for_staff + 1, last_message_at=now(), updated_at=now() WHERE id=$1`,
            [caseId],
          );
        }
      } catch {
        /* columns may not exist pre-migrate */
      }
      return msg;
    };
  }

  // ---- Owner status cards + funds raised (verified only) ----
  proto.getOwnerStatusCards = async function getOwnerStatusCards(ownerUserId) {
    const projects = await this.pool.query(
      `SELECT p.id, p.status, p.title, p.funding_target_poisha, p.total_units, p.active_units, p.reserved_units,
              p.unit_investment_poisha, p.updated_at, p.created_at
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       WHERE b.owner_user_id=$1`,
      [ownerUserId],
    );
    const rows = projects.rows;
    const count = (pred) => rows.filter(pred).length;
    const cards = {
      draft: count((r) => r.status === 'draft'),
      submitted: count((r) => ['submitted_for_review', 'resubmitted'].includes(r.status)),
      under_review: count((r) => ['submitted_for_review', 'resubmitted'].includes(r.status)),
      correction_required: count((r) => r.status === 'changes_requested'),
      approved: count((r) => r.status === 'approved'),
      published: count((r) => r.status === 'published'),
      paused: count((r) => r.status === 'paused'),
      fully_funded: count((r) => r.status === 'funding_closed' || (Number(r.active_units) >= Number(r.total_units) && Number(r.total_units) > 0)),
      rejected: count((r) => r.status === 'rejected'),
      completed: count((r) => r.status === 'completed'),
    };
    const verified = await sumVerifiedFundsPoisha(this.pool, { ownerUserId });
    const unreadMsg = await this.pool.query(
      `SELECT COALESCE(SUM(unread_for_user),0)::int AS c FROM support_cases WHERE opened_by=$1`,
      [ownerUserId],
    );
    const myInvestments = await this.pool.query(
      `SELECT COUNT(*)::int AS c FROM investment_applications WHERE investor_id=$1`,
      [ownerUserId],
    );
    return {
      cards,
      totalFundsRaisedPoisha: verified,
      totalFundsRaisedBasis: 'verified_payments_only',
      unreadMessages: unreadMsg.rows[0].c,
      myInvestmentsCount: myInvestments.rows[0].c,
      deepLinks: {
        draft: '/owner/projects?status=draft',
        submitted: '/owner/projects?status=submitted_for_review',
        under_review: '/owner/projects?status=submitted_for_review',
        correction_required: '/owner/projects?status=changes_requested',
        approved: '/owner/projects?status=approved',
        published: '/owner/projects?status=published',
        paused: '/owner/projects?status=paused',
        fully_funded: '/owner/projects?status=funding_closed',
        rejected: '/owner/projects?status=rejected',
        completed: '/owner/projects?status=completed',
        total_funds_raised: '/owner/funds-raised',
        my_investments: '/owner/investments',
        unread_messages: '/owner/support',
      },
    };
  };

  proto.listOwnerProjectsByStatus = async function listOwnerProjectsByStatus(ownerUserId, status = null) {
    const params = [ownerUserId];
    let sql = `
      SELECT p.*,
             (SELECT json_agg(h ORDER BY h.occurred_at DESC)
              FROM (
                SELECT from_status, to_status, reason, occurred_at, actor_id
                FROM project_status_history
                WHERE project_id = p.id
                ORDER BY occurred_at DESC
                LIMIT 50
              ) h) AS status_timeline
      FROM projects p
      JOIN businesses b ON b.id = p.business_id
      WHERE b.owner_user_id=$1`;
    if (status) {
      const map = {
        submitted: ['submitted_for_review', 'resubmitted'],
        under_review: ['submitted_for_review', 'resubmitted'],
        correction_required: ['changes_requested'],
        fully_funded: ['funding_closed'],
      };
      const statuses = map[status] || [status];
      params.push(statuses);
      sql += ` AND p.status = ANY($${params.length}::text[])`;
    }
    sql += ` ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC LIMIT 200`;
    const r = await this.pool.query(sql, params);
    return {
      items: r.rows.map((row) => ({
        ...mapProjectRow(row),
        statusTimeline: row.status_timeline || [],
        lastAction: Array.isArray(row.status_timeline) && row.status_timeline[0]
          ? row.status_timeline[0]
          : null,
      })),
    };
  };

  proto.getOwnerFundsRaisedDetail = async function getOwnerFundsRaisedDetail(ownerUserId) {
    const projects = await this.pool.query(
      `SELECT p.id, p.title, p.status, p.funding_target_poisha, p.total_units,
              p.active_units, p.reserved_units, p.unit_investment_poisha
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       WHERE b.owner_user_id=$1
       ORDER BY p.created_at DESC`,
      [ownerUserId],
    );
    const items = [];
    let totalVerified = 0;
    for (const p of projects.rows) {
      const verified = await sumVerifiedFundsPoisha(this.pool, { projectId: p.id });
      totalVerified += verified;
      const target = Number(p.funding_target_poisha) || 0;
      const allocatedUnits = Number(p.active_units) || 0;
      const reservedUnits = Number(p.reserved_units) || 0;
      const totalUnits = Number(p.total_units) || 0;
      const investors = await this.pool.query(
        `SELECT COUNT(DISTINCT investor_id)::int AS c
         FROM allocations WHERE project_id=$1 AND status='active'`,
        [p.id],
      );
      items.push({
        projectId: p.id,
        title: p.title,
        status: p.status,
        fundingTargetPoisha: target,
        verifiedAmountRaisedPoisha: verified,
        remainingPoisha: Math.max(0, target - verified),
        fundingPercentageBps: target > 0 ? Math.min(10000, Math.trunc((verified * 10000) / target)) : 0,
        totalAvailableShares: totalUnits,
        sharesReserved: reservedUnits,
        sharesSoldAndPaid: allocatedUnits,
        sharesRemaining: Math.max(0, totalUnits - allocatedUnits - reservedUnits),
        confirmedInvestors: investors.rows[0].c,
        basis: 'verified_payments_only',
      });
    }
    return {
      totalVerifiedFundsRaisedPoisha: totalVerified,
      basis: 'verified_payments_only',
      items,
    };
  };

  // ---- Owner Investments (own applications into other projects) ----
  proto.listOwnerInvestments = async function listOwnerInvestments(ownerUserId) {
    const r = await this.pool.query(
      `SELECT ia.*, p.title AS project_title, p.id AS project_id,
              p.unit_investment_poisha AS project_unit_price
       FROM investment_applications ia
       JOIN projects p ON p.id = ia.project_id
       JOIN businesses b ON b.id = p.business_id
       WHERE ia.investor_id=$1
         AND b.owner_user_id IS DISTINCT FROM $1
       ORDER BY ia.created_at DESC
       LIMIT 200`,
      [ownerUserId],
    );
    return {
      section: 'Investments',
      renamedFrom: 'Interest Inbox',
      note: "Shows this owner's applications to invest in other projects (not interest in their own projects).",
      items: r.rows.map((row) => ({
        applicationId: row.id,
        projectId: row.project_id,
        projectTitle: row.project_title,
        status: row.status,
        units: Number(row.units),
        unitInvestmentPoisha: Number(row.unit_investment_poisha),
        investmentPoisha: Number(row.investment_poisha),
        administrationFeePoisha: Number(row.administration_fee_poisha),
        totalPayablePoisha: Number(row.total_payable_poisha),
        paymentDeadlineAt: row.payment_deadline_at || row.expires_at || null,
        paymentInstructions: row.payment_instructions || null,
        createdAt: row.created_at,
        decidedAt: row.decided_at || null,
      })),
    };
  };

  // ---- Disbursement stages ----
  proto.setProjectDisbursementStages = async function setProjectDisbursementStages(
    projectId,
    actorId,
    stagesInput,
    meta = {},
  ) {
    return withTransaction(this.pool, async (client) => {
      const p = await client.query(
        `SELECT id, funding_target_poisha, status FROM projects WHERE id=$1 FOR UPDATE`,
        [projectId],
      );
      if (!p.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404);
      const fundingTargetPoisha = Number(p.rows[0].funding_target_poisha);
      const stages = validateDisbursementStages(stagesInput, { fundingTargetPoisha });
      await client.query(`DELETE FROM project_disbursement_stages WHERE project_id=$1`, [projectId]);
      const created = [];
      for (const st of stages) {
        const ins = await client.query(
          `INSERT INTO project_disbursement_stages(
             project_id, stage_number, title, percent_bps, amount_poisha,
             expected_release_date, conditions, status, admin_note, created_by, updated_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
          [
            projectId,
            st.stageNumber,
            st.title,
            st.percentBps,
            st.amountPoisha,
            st.expectedReleaseDate,
            st.conditions,
            st.status || 'planned',
            st.adminNote,
            actorId,
          ],
        );
        created.push(ins.rows[0]);
        await client.query(
          `INSERT INTO project_disbursement_stage_history(stage_id, project_id, from_status, to_status, actor_id, after_json)
           VALUES ($1,$2,NULL,$3,$4,$5::jsonb)`,
          [ins.rows[0].id, projectId, ins.rows[0].status, actorId, JSON.stringify(ins.rows[0])],
        );
      }
      await audit(client, actorId, 'project.disbursement_stages_set', 'project', projectId, { stages: created.length }, meta);
      return { projectId, stages: created.map(mapStage) };
    });
  };

  proto.listProjectDisbursementStages = async function listProjectDisbursementStages(projectId, { ownerUserId = null } = {}) {
    if (ownerUserId) await this._assertOwnsProject(projectId, ownerUserId);
    const r = await this.pool.query(
      `SELECT * FROM project_disbursement_stages WHERE project_id=$1 ORDER BY stage_number ASC`,
      [projectId],
    );
    const verified = await sumVerifiedFundsPoisha(this.pool, { projectId });
    const released = r.rows
      .filter((s) => s.status === 'released')
      .reduce((sum, s) => sum + Number(s.amount_poisha || 0), 0);
    return {
      projectId,
      verifiedFundsPoisha: verified,
      releasedAmountPoisha: released,
      remainingReleasablePoisha: Math.max(0, verified - released),
      ownerReadOnly: true,
      stages: r.rows.map(mapStage),
    };
  };

  proto.updateDisbursementStageStatus = async function updateDisbursementStageStatus(
    stageId,
    actorId,
    { status, paymentReference, adminNote, actualReleaseDate } = {},
    meta = {},
  ) {
    const allowed = ['planned', 'pending_review', 'approved', 'released', 'held', 'cancelled'];
    if (!allowed.includes(status)) {
      throw new DomainError('INVALID_STATUS', `status must be one of ${allowed.join(',')}`, 400);
    }
    return withTransaction(this.pool, async (client) => {
      const cur = await client.query(
        `SELECT * FROM project_disbursement_stages WHERE id=$1 FOR UPDATE`,
        [stageId],
      );
      if (!cur.rowCount) throw new DomainError('NOT_FOUND', 'Disbursement stage not found', 404);
      const before = cur.rows[0];
      if (status === 'released') {
        const verified = await sumVerifiedFundsPoisha(client, { projectId: before.project_id });
        const already = await client.query(
          `SELECT COALESCE(SUM(amount_poisha),0)::bigint AS t
           FROM project_disbursement_stages
           WHERE project_id=$1 AND status='released' AND id IS DISTINCT FROM $2`,
          [before.project_id, stageId],
        );
        const thisAmount =
          before.amount_poisha != null
            ? Number(before.amount_poisha)
            : Math.trunc(
                (Number(
                  (
                    await client.query(`SELECT funding_target_poisha FROM projects WHERE id=$1`, [
                      before.project_id,
                    ])
                  ).rows[0].funding_target_poisha,
                ) *
                  Number(before.percent_bps || 0)) /
                  10000,
              );
        if (Number(already.rows[0].t) + thisAmount > verified) {
          throw new DomainError(
            'RELEASE_EXCEEDS_VERIFIED',
            `Released amount cannot exceed verified funds received (${verified} poisha)`,
            409,
          );
        }
      }
      const upd = await client.query(
        `UPDATE project_disbursement_stages
         SET status=$2,
             payment_reference=COALESCE($3, payment_reference),
             admin_note=COALESCE($4, admin_note),
             actual_release_date=COALESCE($5::date, actual_release_date),
             funds_moved=false,
             updated_by=$6,
             updated_at=now()
         WHERE id=$1 RETURNING *`,
        [
          stageId,
          status,
          paymentReference || null,
          adminNote || null,
          actualReleaseDate || null,
          actorId,
        ],
      );
      await client.query(
        `INSERT INTO project_disbursement_stage_history(stage_id, project_id, from_status, to_status, actor_id, note, before_json, after_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
        [
          stageId,
          before.project_id,
          before.status,
          status,
          actorId,
          adminNote || null,
          JSON.stringify(before),
          JSON.stringify(upd.rows[0]),
        ],
      );
      await audit(client, actorId, 'project.disbursement_stage_status', 'disbursement_stage', stageId, mapStage(upd.rows[0]), meta);
      return mapStage(upd.rows[0]);
    });
  };

  // ---- Admin overview card bundle (extends metrics) ----
  proto.getAdminDashboardCards = async function getAdminDashboardCards() {
    const q = async (sql, params = []) => (await this.pool.query(sql, params)).rows[0];
    const pendingReviews = await q(
      `SELECT COUNT(*)::int AS c FROM projects WHERE status IN ('submitted_for_review','resubmitted')`,
    );
    const corrections = await q(
      `SELECT COUNT(*)::int AS c FROM projects WHERE status='changes_requested'`,
    );
    const pendingApps = await q(
      `SELECT COUNT(*)::int AS c FROM investment_applications WHERE status IN ('submitted','under_review')`,
    );
    const paymentQueue = await q(
      `SELECT COUNT(*)::int AS c FROM payments WHERE status IN ('verification_pending','created')`,
    );
    const scheduledDisb = await q(
      `SELECT COUNT(*)::int AS c FROM project_disbursement_stages WHERE status IN ('planned','pending_review','approved')`,
    );
    const investorKyc = await q(
      `SELECT COUNT(*)::int AS c FROM investor_profiles WHERE verification_status IN ('pending','under_review')`,
    );
    const ownerBiz = await q(
      `SELECT COUNT(*)::int AS c FROM businesses WHERE verification_status IN ('pending','under_review')`,
    );
    const unread = await q(
      `SELECT COALESCE(SUM(unread_for_staff),0)::int AS c FROM support_cases`,
    );
    const active = await q(`SELECT COUNT(*)::int AS c FROM projects WHERE status='active'`);
    const paused = await q(`SELECT COUNT(*)::int AS c FROM projects WHERE status='paused'`);
    const completed = await q(`SELECT COUNT(*)::int AS c FROM projects WHERE status='completed'`);
    const shares = await q(
      `SELECT COALESCE(SUM(units),0)::bigint AS c FROM allocations WHERE status='active'`,
    );
    const funds = await q(
      `SELECT COALESCE(SUM(amount_poisha),0)::bigint AS c FROM payments WHERE status='verified'`,
    );
    return {
      cards: {
        pending_project_reviews: { value: pendingReviews.c, href: '/admin/projects?tab=review' },
        correction_requests: { value: corrections.c, href: '/admin/projects?tab=correction' },
        pending_investment_applications: { value: pendingApps.c, href: '/admin/applications' },
        payment_verification_queue: { value: paymentQueue.c, href: '/admin/payments' },
        scheduled_disbursements: { value: scheduledDisb.c, href: '/admin/disbursement-requests' },
        investor_verification_queue: { value: investorKyc.c, href: '/admin/users?filter=investor_kyc' },
        owner_verification_queue: { value: ownerBiz.c, href: '/admin/users?filter=owner_biz' },
        unread_messages: { value: unread.c, href: '/admin/support/cases' },
        active_projects: { value: active.c, href: '/admin/projects?status=active' },
        paused_projects: { value: paused.c, href: '/admin/projects?status=paused' },
        completed_projects: { value: completed.c, href: '/admin/projects?status=completed' },
        total_shares_sold: { value: Number(shares.c), href: '/admin/overview/allocations' },
        total_funds_confirmed: {
          value: Number(funds.c),
          href: '/admin/overview/allocations',
          basis: 'verified_payments_only',
        },
      },
    };
  };

  // ---- Approve application with payment deadline ----
  const prevApprove = proto.approveApplication;
  if (typeof prevApprove === 'function') {
    proto.approveApplicationWithDeadline = async function approveApplicationWithDeadline(
      applicationId,
      actorId,
      { paymentDeadlineAt, paymentInstructions, daysUntilDeadline } = {},
      meta = {},
    ) {
      const approved = await prevApprove.call(this, applicationId, actorId);
      let deadline = paymentDeadlineAt ? new Date(paymentDeadlineAt) : null;
      if (!deadline && daysUntilDeadline != null) {
        const d = assertSafeInteger(daysUntilDeadline, 'daysUntilDeadline', 1);
        deadline = new Date(Date.now() + d * 86_400_000);
      }
      if (!deadline) {
        deadline = new Date(Date.now() + 7 * 86_400_000);
      }
      const instructions =
        paymentInstructions ||
        'Staging TEST: pay via cash or bank transfer only. Live gateways OFF. Submit payment evidence in-app.';
      await this.pool.query(
        `UPDATE investment_applications
         SET payment_deadline_at=$2, payment_instructions=$3, expires_at=COALESCE(expires_at,$2)
         WHERE id=$1`,
        [applicationId, deadline.toISOString(), instructions],
      );
      await audit(
        this.pool,
        actorId,
        'application.payment_deadline_set',
        'application',
        applicationId,
        { paymentDeadlineAt: deadline.toISOString(), paymentInstructions: instructions },
        meta,
      );
      return {
        ...approved,
        paymentDeadlineAt: deadline.toISOString(),
        paymentInstructions: instructions,
        allocateOnlyAfterVerifiedPayment: true,
      };
    };
  }

  // Patch owner home metrics to use verified payments for funds raised
  const prevOwnerHome = proto.getOwnerHomeMetrics;
  if (typeof prevOwnerHome === 'function') {
    proto.getOwnerHomeMetrics = async function getOwnerHomeMetricsVerified(ownerUserId) {
      const base = await prevOwnerHome.call(this, ownerUserId);
      const verified = await sumVerifiedFundsPoisha(this.pool, { ownerUserId });
      return {
        ...base,
        totalFundraisedPoisha: verified,
        totalFundraisedBasis: 'verified_payments_only',
        note: 'Interest Inbox renamed to Investments for owner own applications — see /owner/investments',
      };
    };
  }
}

function mapStage(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    stageNumber: Number(row.stage_number),
    title: row.title,
    percentBps: row.percent_bps == null ? null : Number(row.percent_bps),
    amountPoisha: row.amount_poisha == null ? null : Number(row.amount_poisha),
    expectedReleaseDate: row.expected_release_date || null,
    conditions: row.conditions || null,
    status: row.status,
    actualReleaseDate: row.actual_release_date || null,
    paymentReference: row.payment_reference || null,
    adminNote: row.admin_note || null,
    fundsMoved: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
