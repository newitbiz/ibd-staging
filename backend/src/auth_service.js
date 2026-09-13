import { DomainError } from './domain.js';
import { withTransaction } from './db.js';
import { ALL_ROLES, ROLES } from './roles.js';
import {
  hashPassword,
  verifyPassword,
  randomToken,
  randomOtpCode,
  sha256Hex,
  signJwt,
  verifyJwt,
} from './crypto_util.js';
import { createEmailAdapter } from './email/adapter.js';
import { createVerificationDelivery } from './verification_delivery.js';
import {
  normalizeReferralCode,
  generateReferralCode,
  assertNotSelfReferral,
  mapReferral,
} from './referrals.js';

const ACCESS_TTL_SECONDS = Number(process.env.JWT_ACCESS_TTL_SECONDS || 900);
const REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TTL_DAYS || 30);
const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
const EMAIL_VERIFY_TTL_MINUTES = Number(process.env.EMAIL_VERIFY_TTL_MINUTES || 10);
const OTP_MAX_ATTEMPTS = 5;
const EMAIL_VERIFY_MAX_ATTEMPTS = 5;
const RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES || 30);

function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters');
  }
  return secret;
}

function mapUser(row, roles = []) {
  return {
    id: row.id,
    email: row.email,
    mobile: row.mobile,
    status: row.status,
    emailVerifiedAt: row.email_verified_at || null,
    displayName: row.display_name || null,
    createdByAdmin: Boolean(row.created_by_admin),
    adminCreatedLabel: row.admin_created_label || (row.created_by_admin ? 'Admin-created account' : null),
    mustChangePassword: Boolean(row.must_change_password) && Boolean(row.created_by_admin),
    pendingLegalAcceptance: Boolean(row.pending_legal_acceptance) || (Boolean(row.created_by_admin) && !row.legal_acceptance_completed_at),
    pendingOwnerAgreement: Boolean(row.pending_owner_agreement),
    preferredRoleShell: row.preferred_role_shell || null,
    // Activation ≠ KYC — never imply identity verified from admin create
    identityVerification: {
      nidVerified: false,
      selfieVerified: false,
      phoneVerified: Boolean(row.mobile_verified_at),
      kycVerified: false,
      note: row.created_by_admin
        ? 'Admin-created account — identity/KYC verification remains separate from activation'
        : undefined,
    },
    roles,
    createdAt: row.created_at,
  };
}

async function loadRoles(client, userId) {
  const result = await client.query(
    'SELECT role_code FROM user_roles WHERE user_id=$1 ORDER BY role_code',
    [userId],
  );
  return result.rows.map((row) => row.role_code);
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

function appPublicUrl() {
  const base = (process.env.APP_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  return base;
}

function buildVerifyLink(token) {
  return `${appPublicUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}

function otpPreviewAllowed(destination) {
  if (process.env.ALLOW_OTP_PREVIEW !== 'true') return false;
  const allowlist = (process.env.OTP_PREVIEW_ALLOWLIST || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!allowlist.length) return false;
  const dest = String(destination || '').trim().toLowerCase();
  if (!dest) return false;
  return allowlist.some((entry) => dest === entry || dest.endsWith(entry) || dest.includes(entry));
}

function maybeOtpPreview(code, destination) {
  return otpPreviewAllowed(destination) ? code : undefined;
}

function stagingAccessRequired() {
  return (
    process.env.STAGING_ACCESS_REQUIRED === 'true' ||
    process.env.NODE_ENV === 'staging'
  );
}

function assertStagingInvite(inviteCode) {
  if (!stagingAccessRequired()) return;
  const expected = process.env.STAGING_INVITE_CODE;
  if (!expected || !String(expected).trim()) {
    throw new DomainError(
      'INVITE_MISCONFIGURED',
      'Staging invite code is required but STAGING_INVITE_CODE is not configured',
      500,
    );
  }
  if (inviteCode === undefined || inviteCode === null || String(inviteCode).trim() === '') {
    throw new DomainError('INVITE_REQUIRED', 'A staging invite code is required to register', 403);
  }
  if (String(inviteCode) !== String(expected)) {
    throw new DomainError('INVITE_INVALID', 'Invalid staging invite code', 403);
  }
}

function validateRole(role) {
  if (!ALL_ROLES.includes(role)) {
    throw new DomainError('INVALID_ROLE', `Unsupported role: ${role}`);
  }
}

async function writeAudit(client, { actorId, action, subjectType, subjectId, reason, after, ip, userAgent }) {
  await client.query(
    `INSERT INTO audit_logs(actor_id, action, subject_type, subject_id, reason, after_json, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::inet,$8)`,
    [
      actorId || null,
      action,
      subjectType,
      subjectId,
      reason || null,
      after != null ? JSON.stringify(after) : null,
      ip || null,
      userAgent || null,
    ],
  );
}

const GENERIC_EMAIL_SENT = {
  accepted: true,
  message: 'If an account needs verification, a code was sent',
};

export class AuthService {
  /**
   * @param {import('pg').Pool} pool
   * @param {{ emailAdapter?: object, verificationDelivery?: object }} [deps]
   */
  constructor(pool, deps = {}) {
    this.pool = pool;
    this.emailAdapter = deps.emailAdapter || createEmailAdapter();
    this.verificationDelivery =
      deps.verificationDelivery || createVerificationDelivery({ emailAdapter: this.emailAdapter });
  }

  issueAccessToken(user, roles) {
    return signJwt(
      { sub: user.id, roles, typ: 'access' },
      requireJwtSecret(),
      ACCESS_TTL_SECONDS,
    );
  }

  verifyAccessToken(token) {
    const payload = verifyJwt(token, requireJwtSecret());
    if (!payload || payload.typ !== 'access' || !payload.sub) return null;
    return {
      userId: payload.sub,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
    };
  }

  async register({ email, mobile, password, fullName, role = ROLES.INVESTOR, inviteCode, referralCode, requestContext, legalAcceptances, marketingConsent }) {
    assertStagingInvite(inviteCode);
    validateRole(role);
    if (role === ROLES.SUPER_ADMIN || role === ROLES.FINANCE_OFFICER || role === ROLES.AUDITOR) {
      throw new DomainError('ROLE_NOT_SELF_ASSIGNABLE', 'Staff roles cannot be self-assigned', 403);
    }
    if (!Array.isArray(legalAcceptances) || legalAcceptances.length < 1) {
      throw new DomainError(
        'MISSING_CONSENT',
        'You must view and accept the required agreements before creating an account',
        400,
      );
    }
    if (!legalAcceptances.every((a) => a && (a.viewedAt || a.viewed === true) && a.documentType)) {
      throw new DomainError('VIEW_REQUIRED', 'Each required agreement must be viewed before the checkbox can be accepted', 400);
    }
    const normalizedEmail = normalizeEmail(email);
    const normalizedMobile = normalizeMobile(mobile);
    if (!normalizedEmail) {
      throw new DomainError('EMAIL_REQUIRED', 'Email is required for registration');
    }
    if (!normalizedMobile) {
      throw new DomainError('PHONE_REQUIRED', 'Phone number is required for registration');
    }
    if (!fullName || String(fullName).trim().length < 2) {
      throw new DomainError('NAME_REQUIRED', 'Full name is required');
    }
    const passwordHash = await hashPassword(password);
    const ip = requestContext?.ip || null;
    const userAgent = requestContext?.userAgent || null;

    const result = await withTransaction(this.pool, async (client) => {
      let user;
      try {
        const inserted = await client.query(
          `INSERT INTO users(email, mobile, password_hash, status)
           VALUES ($1,$2,$3,'pending_verification') RETURNING *`,
          [normalizedEmail, normalizedMobile, passwordHash],
        );
        user = inserted.rows[0];
      } catch (error) {
        if (error.code === '23505') {
          throw new DomainError('IDENTITY_TAKEN', 'Email or mobile is already registered', 409);
        }
        throw error;
      }
      await client.query(`INSERT INTO user_roles(user_id, role_code) VALUES ($1,$2)`, [user.id, role]);
      if (role === ROLES.INVESTOR) {
        await client.query(`INSERT INTO investor_profiles(user_id, full_name) VALUES ($1,$2)`, [
          user.id,
          String(fullName).trim(),
        ]);
        // Assign unique shareable referral code (investors only)
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const code = generateReferralCode(user.id);
          try {
            await client.query(`UPDATE users SET referral_code=$2, updated_at=now() WHERE id=$1`, [
              user.id,
              code,
            ]);
            break;
          } catch (error) {
            if (error.code === '23505') continue;
            throw error;
          }
        }
      }

      let attachedReferral = null;
      const normalizedReferral = referralCode ? normalizeReferralCode(referralCode) : null;
      if (normalizedReferral && role === ROLES.INVESTOR) {
        const referrer = await client.query(
          `SELECT id FROM users WHERE referral_code=$1 LIMIT 1`,
          [normalizedReferral],
        );
        if (!referrer.rowCount) {
          throw new DomainError('REFERRAL_CODE_NOT_FOUND', 'Referral code was not found', 404);
        }
        assertNotSelfReferral(referrer.rows[0].id, user.id);
        try {
          const inserted = await client.query(
            `INSERT INTO referrals(referrer_id, referred_user_id, referral_code, created_at)
             VALUES ($1,$2,$3,now()) RETURNING *`,
            [referrer.rows[0].id, user.id, normalizedReferral],
          );
          attachedReferral = mapReferral(inserted.rows[0]);
          await writeAudit(client, {
            actorId: user.id,
            action: 'referral.attached',
            subjectType: 'referral',
            subjectId: attachedReferral.id,
            after: { ...attachedReferral, via: 'register' },
            ip,
            userAgent,
          });
        } catch (error) {
          if (error.code === '23505') {
            throw new DomainError('ALREADY_REFERRED', 'This account is already linked to a referral', 409);
          }
          throw error;
        }
      }

      const verification = await this.#createEmailVerification(client, {
        userId: user.id,
        email: normalizedEmail,
        ip,
      });
      const roles = await loadRoles(client, user.id);
      await writeAudit(client, {
        actorId: user.id,
        action: 'auth.register',
        subjectType: 'user',
        subjectId: user.id,
        after: { status: 'pending_verification', channel: 'email' },
        ip,
        userAgent,
      });
      return {
        user: mapUser(user, roles),
        verification,
        attachedReferral,
        // No access/refresh tokens until email is verified.
      };
    });

    // Record signup legal acceptances (immutable). Admin cannot accept for self-serve signup.
    try {
      const legal = this.legalService || this.growService;
      if (!legal?.acceptSignupLegal) {
        throw new DomainError('LEGAL_SERVICE_UNAVAILABLE', 'Legal acceptance service unavailable', 503);
      }
      await legal.acceptSignupLegal(
        result.user.id,
        { role, acceptances: legalAcceptances, marketingConsent: Boolean(marketingConsent) },
        requestContext || {},
      );
    } catch (err) {
      await this.pool.query(
        `UPDATE users SET pending_legal_acceptance=true, updated_at=now() WHERE id=$1`,
        [result.user.id],
      );
      throw err;
    }

    await this.#deliverEmailVerification({
      email: normalizedEmail,
      code: result.verification.plainCode,
      token: result.verification.plainToken,
    });

    const previewCode = maybeOtpPreview(result.verification.plainCode, normalizedEmail);
    return {
      user: result.user,
      emailVerification: {
        sent: true,
        expiresAt: result.verification.expiresAt,
        // Staging-only: previewCode only when ALLOW_OTP_PREVIEW + OTP_PREVIEW_ALLOWLIST match.
        ...(previewCode ? { previewCode } : {}),
      },
      referral: result.attachedReferral,
    };
  }

  /**
   * POST /auth/email/send-verification — issue (or re-issue) a verification for a pending account.
   * Generic response to avoid email enumeration.
   */
  async sendEmailVerification({ email, requestContext }) {
    const normalizedEmail = normalizeEmail(email);
    const generic = { ...GENERIC_EMAIL_SENT };
    if (!normalizedEmail) return generic;

    const userResult = await this.pool.query(`SELECT * FROM users WHERE email=$1 LIMIT 1`, [
      normalizedEmail,
    ]);
    if (!userResult.rowCount) return generic;
    const user = userResult.rows[0];
    if (user.status !== 'pending_verification' || user.email_verified_at) {
      return generic;
    }

    const verification = await withTransaction(this.pool, async (client) => {
      return this.#createEmailVerification(client, {
        userId: user.id,
        email: normalizedEmail,
        ip: requestContext?.ip || null,
        invalidatePrevious: true,
      });
    });

    try {
      await this.#deliverEmailVerification({
        email: normalizedEmail,
        code: verification.plainCode,
        token: verification.plainToken,
      });
    } catch {
      // Still return generic — do not leak delivery failures that reveal accounts.
    }
    return { ...generic, expiresAt: verification.expiresAt };
  }

  async resendEmailVerification({ email, requestContext }) {
    // Same semantics as send; rate limits applied at the HTTP layer (max 3/hour).
    return this.sendEmailVerification({ email, requestContext });
  }

  async verifyEmailCode({ email, code, requestContext }) {
    if (!code) throw new DomainError('EMAIL_CODE_REQUIRED', 'Verification code is required');
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) throw new DomainError('EMAIL_REQUIRED', 'Email is required');

    // Commit attempt counters even on failure (must not roll back with DomainError).
    const outcome = await withTransaction(this.pool, async (client) => {
      const userResult = await client.query(`SELECT * FROM users WHERE email=$1 FOR UPDATE`, [
        normalizedEmail,
      ]);
      if (!userResult.rowCount) {
        return { type: 'invalid' };
      }
      const user = userResult.rows[0];
      if (user.email_verified_at && user.status === 'active') {
        return { type: 'already_verified' };
      }

      const locked = await client.query(
        `SELECT * FROM email_verifications
         WHERE user_id=$1 AND invalidated_at IS NULL AND used_at IS NULL
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [user.id],
      );
      if (!locked.rowCount) {
        await writeAudit(client, {
          actorId: user.id,
          action: 'auth.email_verify_failed',
          subjectType: 'user',
          subjectId: user.id,
          reason: 'no_active_challenge',
          ip: requestContext?.ip,
          userAgent: requestContext?.userAgent,
        });
        return { type: 'invalid' };
      }
      const challenge = locked.rows[0];
      return this.#consumeEmailVerification(client, {
        challenge,
        user,
        presented: String(code).trim(),
        mode: 'code',
        requestContext,
        deferThrow: true,
      });
    });

    if (outcome?.type === 'success') return outcome.result;
    if (outcome?.type === 'already_verified') {
      throw new DomainError('EMAIL_ALREADY_VERIFIED', 'Email is already verified', 409);
    }
    if (outcome?.type === 'expired') {
      throw new DomainError('EMAIL_VERIFY_EXPIRED', 'Verification code has expired', 410);
    }
    if (outcome?.type === 'used') {
      throw new DomainError('EMAIL_VERIFY_USED', 'Verification code already used', 409);
    }
    if (outcome?.type === 'locked') {
      throw new DomainError('EMAIL_VERIFY_LOCKED', 'Too many verification attempts', 429);
    }
    throw new DomainError('EMAIL_VERIFY_INVALID', 'Invalid or expired verification code', 401);
  }

  async verifyEmailToken({ token, requestContext }) {
    if (!token) throw new DomainError('EMAIL_TOKEN_REQUIRED', 'Verification token is required');
    const tokenHash = sha256Hex(String(token).trim());

    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM email_verifications WHERE token_hash=$1 FOR UPDATE`,
        [tokenHash],
      );
      if (!locked.rowCount) {
        throw new DomainError('EMAIL_VERIFY_INVALID', 'Invalid or expired verification link', 401);
      }
      const challenge = locked.rows[0];
      const userResult = await client.query(`SELECT * FROM users WHERE id=$1 FOR UPDATE`, [
        challenge.user_id,
      ]);
      if (!userResult.rowCount) {
        throw new DomainError('EMAIL_VERIFY_INVALID', 'Invalid or expired verification link', 401);
      }
      const user = userResult.rows[0];
      if (challenge.used_at) {
        throw new DomainError('EMAIL_VERIFY_USED', 'Verification link already used', 409);
      }
      if (challenge.invalidated_at) {
        throw new DomainError('EMAIL_VERIFY_INVALID', 'Invalid or expired verification link', 401);
      }
      if (user.email_verified_at && user.status === 'active') {
        throw new DomainError('EMAIL_ALREADY_VERIFIED', 'Email is already verified', 409);
      }
      // Token path: do not compare code; mark used after expiry/attempt checks.
      if (new Date(challenge.expires_at).getTime() < Date.now()) {
        await writeAudit(client, {
          actorId: user.id,
          action: 'auth.email_verify_failed',
          subjectType: 'user',
          subjectId: user.id,
          reason: 'expired_token',
          ip: requestContext?.ip,
          userAgent: requestContext?.userAgent,
        });
        throw new DomainError('EMAIL_VERIFY_EXPIRED', 'Verification link has expired', 410);
      }
      if (challenge.attempts >= EMAIL_VERIFY_MAX_ATTEMPTS) {
        throw new DomainError('EMAIL_VERIFY_LOCKED', 'Too many verification attempts', 429);
      }

      await client.query(
        `UPDATE email_verifications SET used_at=now(), attempts=attempts+1 WHERE id=$1`,
        [challenge.id],
      );
      await client.query(
        `UPDATE email_verifications SET invalidated_at=COALESCE(invalidated_at, now())
         WHERE user_id=$1 AND id<>$2 AND used_at IS NULL AND invalidated_at IS NULL`,
        [user.id, challenge.id],
      );
      await client.query(
        `UPDATE users SET status='active', email_verified_at=COALESCE(email_verified_at, now()), updated_at=now()
         WHERE id=$1`,
        [user.id],
      );
      const refreshed = await client.query('SELECT * FROM users WHERE id=$1', [user.id]);
      const activeUser = refreshed.rows[0];
      const roles = await loadRoles(client, activeUser.id);
      const session = await this.#createSession(client, activeUser, roles);
      await writeAudit(client, {
        actorId: activeUser.id,
        action: 'auth.email_verify_success',
        subjectType: 'user',
        subjectId: activeUser.id,
        after: { mode: 'token', status: 'active' },
        ip: requestContext?.ip,
        userAgent: requestContext?.userAgent,
      });
      return { purpose: 'email_verification', user: mapUser(activeUser, roles), ...session };
    });
  }

  async #consumeEmailVerification(client, { challenge, user, presented, mode, requestContext, deferThrow = false }) {
    const fail = (type) => {
      if (deferThrow) return { type };
      const map = {
        used: () => { throw new DomainError('EMAIL_VERIFY_USED', 'Verification code already used', 409); },
        invalid: () => { throw new DomainError('EMAIL_VERIFY_INVALID', 'Invalid or expired verification code', 401); },
        expired: () => { throw new DomainError('EMAIL_VERIFY_EXPIRED', 'Verification code has expired', 410); },
        locked: () => { throw new DomainError('EMAIL_VERIFY_LOCKED', 'Too many verification attempts', 429); },
      };
      return map[type]();
    };

    if (challenge.used_at) return fail('used');
    if (challenge.invalidated_at) return fail('invalid');
    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      await writeAudit(client, {
        actorId: user.id,
        action: 'auth.email_verify_failed',
        subjectType: 'user',
        subjectId: user.id,
        reason: 'expired',
        ip: requestContext?.ip,
        userAgent: requestContext?.userAgent,
      });
      return fail('expired');
    }
    if (Number(challenge.attempts) >= EMAIL_VERIFY_MAX_ATTEMPTS) {
      return fail('locked');
    }

    const ok = sha256Hex(presented) === challenge.code_hash;
    const bumped = await client.query(
      `UPDATE email_verifications SET attempts=attempts+1 WHERE id=$1 RETURNING attempts`,
      [challenge.id],
    );
    const attemptsNow = Number(bumped.rows[0].attempts);
    if (!ok) {
      await writeAudit(client, {
        actorId: user.id,
        action: 'auth.email_verify_failed',
        subjectType: 'user',
        subjectId: user.id,
        reason: attemptsNow >= EMAIL_VERIFY_MAX_ATTEMPTS ? 'locked' : 'bad_code',
        ip: requestContext?.ip,
        userAgent: requestContext?.userAgent,
      });
      if (attemptsNow >= EMAIL_VERIFY_MAX_ATTEMPTS) return fail('locked');
      return fail('invalid');
    }
    if (attemptsNow > EMAIL_VERIFY_MAX_ATTEMPTS) {
      return fail('locked');
    }

    await client.query(`UPDATE email_verifications SET used_at=now() WHERE id=$1`, [challenge.id]);
    await client.query(
      `UPDATE email_verifications SET invalidated_at=COALESCE(invalidated_at, now())
       WHERE user_id=$1 AND id<>$2 AND used_at IS NULL AND invalidated_at IS NULL`,
      [user.id, challenge.id],
    );
    await client.query(
      `UPDATE users SET status='active', email_verified_at=COALESCE(email_verified_at, now()), updated_at=now()
       WHERE id=$1`,
      [user.id],
    );
    const refreshed = await client.query('SELECT * FROM users WHERE id=$1', [user.id]);
    const activeUser = refreshed.rows[0];
    const roles = await loadRoles(client, activeUser.id);
    const session = await this.#createSession(client, activeUser, roles);
    await writeAudit(client, {
      actorId: activeUser.id,
      action: 'auth.email_verify_success',
      subjectType: 'user',
      subjectId: activeUser.id,
      after: { mode, status: 'active' },
      ip: requestContext?.ip,
      userAgent: requestContext?.userAgent,
    });
    const result = { purpose: 'email_verification', user: mapUser(activeUser, roles), ...session };
    if (deferThrow) return { type: 'success', result };
    return result;
  }

  async #createEmailVerification(client, { userId, email, ip, invalidatePrevious = true }) {
    if (invalidatePrevious) {
      await client.query(
        `UPDATE email_verifications SET invalidated_at=COALESCE(invalidated_at, now())
         WHERE user_id=$1 AND used_at IS NULL AND invalidated_at IS NULL`,
        [userId],
      );
    }
    const code = randomOtpCode();
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TTL_MINUTES * 60_000);
    const inserted = await client.query(
      `INSERT INTO email_verifications(user_id, email, code_hash, token_hash, expires_at, created_ip)
       VALUES ($1,$2,$3,$4,$5,$6::inet)
       RETURNING id, expires_at`,
      [userId, email, sha256Hex(code), sha256Hex(token), expiresAt, ip || null],
    );
    return {
      id: inserted.rows[0].id,
      expiresAt: inserted.rows[0].expires_at,
      plainCode: code,
      plainToken: token,
    };
  }

  async #deliverEmailVerification({ email, code, token }) {
    const verifyUrl = buildVerifyLink(token);
    await this.verificationDelivery.sendVerification({
      to: email,
      code,
      verifyUrl,
      expiresMinutes: EMAIL_VERIFY_TTL_MINUTES,
    });
  }

  /** Phone OTP — kept for password reset and secondary flows; not used to activate new registrations. */
  async verifyOtp({ challengeId, code }) {
    if (!challengeId || !code) throw new DomainError('OTP_REQUIRED', 'OTP challenge and code are required');
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query('SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE', [
        challengeId,
      ]);
      if (!locked.rowCount) throw new DomainError('OTP_NOT_FOUND', 'OTP challenge was not found', 404);
      const challenge = locked.rows[0];
      if (challenge.consumed_at) throw new DomainError('OTP_CONSUMED', 'OTP already used', 409);
      if (new Date(challenge.expires_at).getTime() < Date.now()) {
        throw new DomainError('OTP_EXPIRED', 'OTP has expired', 410);
      }
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
        throw new DomainError('OTP_LOCKED', 'Too many OTP attempts', 429);
      }
      const ok = sha256Hex(String(code).trim()) === challenge.code_hash;
      await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challengeId]);
      if (!ok) throw new DomainError('OTP_INVALID', 'Incorrect OTP code', 401);
      await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challengeId]);
      if (challenge.purpose === 'registration' || challenge.purpose === 'login') {
        await client.query(
          `UPDATE users SET status='active', updated_at=now()
           WHERE id=$1 AND status='pending_verification'`,
          [challenge.user_id],
        );
      }
      const userResult = await client.query('SELECT * FROM users WHERE id=$1', [challenge.user_id]);
      const user = userResult.rows[0];
      const roles = await loadRoles(client, user.id);
      if (challenge.purpose === 'password_reset') {
        const reset = await this.#createPasswordResetToken(client, user.id);
        return {
          purpose: challenge.purpose,
          user: mapUser(user, roles),
          resetToken: reset.token,
          resetExpiresAt: reset.expires_at,
        };
      }
      const session = await this.#createSession(client, user, roles);
      return { purpose: challenge.purpose, user: mapUser(user, roles), ...session };
    });
  }

  async login({ email, mobile, password, deviceLabel, requestContext }) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedMobile = normalizeMobile(mobile);
    if (!normalizedEmail && !normalizedMobile) {
      throw new DomainError('IDENTITY_REQUIRED', 'Email or mobile is required');
    }
    const userResult = await this.pool.query(
      `SELECT * FROM users
       WHERE ($1::text IS NOT NULL AND email=$1)
          OR ($2::text IS NOT NULL AND mobile=$2)
       LIMIT 1`,
      [normalizedEmail, normalizedMobile],
    );
    if (!userResult.rowCount) throw new DomainError('INVALID_CREDENTIALS', 'Invalid credentials', 401);
    const user = userResult.rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) throw new DomainError('INVALID_CREDENTIALS', 'Invalid credentials', 401);
    if (user.status === 'suspended' || user.status === 'closed') {
      throw new DomainError('ACCOUNT_DISABLED', 'Account is not allowed to sign in', 403);
    }
    return withTransaction(this.pool, async (client) => {
      const roles = await loadRoles(client, user.id);
      if (user.status === 'pending_verification') {
        // Primary path: email verification (no tokens, no code in response).
        if (user.email) {
          const verification = await this.#createEmailVerification(client, {
            userId: user.id,
            email: user.email,
            ip: requestContext?.ip || null,
            invalidatePrevious: true,
          });
          // Deliver outside would be nicer, but we need the plain code from this txn.
          // Schedule delivery after commit by returning it for the caller — handled below.
          return {
            requiresEmailVerification: true,
            requiresOtp: false,
            user: mapUser(user, roles),
            emailVerification: { sent: true, expiresAt: verification.expiresAt },
            _delivery: {
              email: user.email,
              code: verification.plainCode,
              token: verification.plainToken,
            },
          };
        }
        // Fallback for mobile-only legacy accounts: phone OTP (secondary).
        const otp = await this.#createOtp(
          client,
          user.id,
          'login',
          normalizedMobile || user.mobile,
        );
        return {
          requiresEmailVerification: false,
          requiresOtp: true,
          user: mapUser(user, roles),
          otp: {
            challengeId: otp.id,
            expiresAt: otp.expires_at,
            previewCode: maybeOtpPreview(otp.previewCode, normalizedMobile || user.mobile),
          },
        };
      }
      const session = await this.#createSession(client, user, roles, deviceLabel);
      const mapped = mapUser(user, roles);
      return {
        requiresOtp: false,
        requiresEmailVerification: false,
        mustChangePassword: Boolean(user.must_change_password) && Boolean(user.created_by_admin),
        pendingLegalAcceptance: Boolean(user.pending_legal_acceptance) || (Boolean(user.created_by_admin) && !user.legal_acceptance_completed_at),
        pendingOwnerAgreement: Boolean(user.pending_owner_agreement),
        user: mapped,
        ...session,
      };
    }).then(async (payload) => {
      if (payload._delivery) {
        try {
          await this.#deliverEmailVerification(payload._delivery);
        } catch {
          /* generic client response already set */
        }
        delete payload._delivery;
      }
      return payload;
    });
  }

  async refresh({ refreshToken }) {
    if (!refreshToken) throw new DomainError('REFRESH_REQUIRED', 'Refresh token is required');
    const tokenHash = sha256Hex(refreshToken);
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query(
        'SELECT * FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE',
        [tokenHash],
      );
      if (!existing.rowCount) throw new DomainError('REFRESH_INVALID', 'Refresh token is invalid', 401);
      const current = existing.rows[0];
      if (current.revoked_at) {
        await client.query(
          `UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at, now())
           WHERE family_id=$1 AND revoked_at IS NULL`,
          [current.family_id || current.id],
        );
        throw new DomainError('REFRESH_REUSED', 'Refresh token reuse detected; session family revoked', 401);
      }
      if (new Date(current.expires_at).getTime() < Date.now()) {
        throw new DomainError('REFRESH_EXPIRED', 'Refresh token expired', 401);
      }
      const userResult = await client.query('SELECT * FROM users WHERE id=$1', [current.user_id]);
      if (!userResult.rowCount || userResult.rows[0].status !== 'active') {
        throw new DomainError('ACCOUNT_DISABLED', 'Account is not allowed to refresh', 403);
      }
      const user = userResult.rows[0];
      const roles = await loadRoles(client, user.id);
      const nextRaw = randomToken(48);
      const nextHash = sha256Hex(nextRaw);
      const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);
      const inserted = await client.query(
        `INSERT INTO refresh_tokens(user_id, token_hash, device_label, expires_at, family_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [user.id, nextHash, current.device_label, expiresAt, current.family_id || current.id],
      );
      await client.query(`UPDATE refresh_tokens SET revoked_at=now(), replaced_by=$2 WHERE id=$1`, [
        current.id,
        inserted.rows[0].id,
      ]);
      return {
        user: mapUser(user, roles),
        accessToken: this.issueAccessToken(user, roles),
        refreshToken: nextRaw,
        refreshExpiresAt: expiresAt.toISOString(),
        accessExpiresIn: ACCESS_TTL_SECONDS,
      };
    });
  }

  async logout({ refreshToken, accessToken }) {
    return withTransaction(this.pool, async (client) => {
      if (refreshToken) {
        const tokenHash = sha256Hex(refreshToken);
        await client.query(
          `UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at, now())
           WHERE token_hash=$1`,
          [tokenHash],
        );
      }
      if (accessToken) {
        const payload = this.verifyAccessToken(accessToken);
        if (payload) {
          await client.query(
            `UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at, now())
             WHERE user_id=$1 AND revoked_at IS NULL`,
            [payload.userId],
          );
        }
      }
      return { ok: true };
    });
  }

  async requestPasswordReset({ email, mobile }) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedMobile = normalizeMobile(mobile);
    const userResult = await this.pool.query(
      `SELECT * FROM users
       WHERE ($1::text IS NOT NULL AND email=$1)
          OR ($2::text IS NOT NULL AND mobile=$2)
       LIMIT 1`,
      [normalizedEmail, normalizedMobile],
    );
    const generic = { accepted: true, message: 'If an account exists, a reset code was issued' };
    if (!userResult.rowCount) return generic;
    const user = userResult.rows[0];
    return withTransaction(this.pool, async (client) => {
      const otp = await this.#createOtp(
        client,
        user.id,
        'password_reset',
        normalizedEmail || normalizedMobile || user.email || user.mobile,
      );
      return {
        ...generic,
        challengeId: otp.id,
        expiresAt: otp.expires_at,
        previewCode: maybeOtpPreview(
          otp.previewCode,
          normalizedEmail || normalizedMobile || user.email || user.mobile,
        ),
      };
    });
  }

  async resetPassword({ resetToken, newPassword }) {
    if (!resetToken) throw new DomainError('RESET_TOKEN_REQUIRED', 'Reset token is required');
    const tokenHash = sha256Hex(resetToken);
    const passwordHash = await hashPassword(newPassword);
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        'SELECT * FROM password_reset_tokens WHERE token_hash=$1 FOR UPDATE',
        [tokenHash],
      );
      if (!locked.rowCount) throw new DomainError('RESET_INVALID', 'Reset token is invalid', 401);
      const row = locked.rows[0];
      if (row.used_at) throw new DomainError('RESET_USED', 'Reset token already used', 409);
      if (new Date(row.expires_at).getTime() < Date.now()) {
        throw new DomainError('RESET_EXPIRED', 'Reset token expired', 410);
      }
      await client.query(`UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1`, [
        row.user_id,
        passwordHash,
      ]);
      await client.query(`UPDATE password_reset_tokens SET used_at=now() WHERE id=$1`, [row.id]);
      await client.query(
        `UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at, now())
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [row.user_id],
      );
      return { ok: true };
    });
  }

  async changeRequiredPassword({ userId, currentPassword, newPassword }) {
    if (!currentPassword || !newPassword) {
      throw new DomainError('PASSWORD_REQUIRED', 'currentPassword and newPassword are required', 400);
    }
    if (String(newPassword).length < 10) {
      throw new DomainError('PASSWORD_WEAK', 'newPassword must be at least 10 characters', 400);
    }
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
      return { ok: true, mustChangePassword: false };
    });
  }

    async revokeAllSessions(userId, actorId) {
    if (!userId) throw new DomainError('USER_REQUIRED', 'User id is required');
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at, now())
       WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
    return { ok: true, userId, revokedBy: actorId };
  }

  async getUserById(userId) {
    const result = await this.pool.query('SELECT * FROM users WHERE id=$1', [userId]);
    if (!result.rowCount) return null;
    const roles = await loadRoles(this.pool, userId);
    return mapUser(result.rows[0], roles);
  }

  async #createOtp(client, userId, purpose, destination) {
    const code = randomOtpCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000);
    const inserted = await client.query(
      `INSERT INTO otp_challenges(user_id, purpose, destination, code_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
      [userId, purpose, String(destination), sha256Hex(code), expiresAt],
    );
    return { ...inserted.rows[0], previewCode: code };
  }

  async #createPasswordResetToken(client, userId) {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);
    await client.query(
      `INSERT INTO password_reset_tokens(user_id, token_hash, expires_at)
       VALUES ($1,$2,$3)`,
      [userId, sha256Hex(token), expiresAt],
    );
    return { token, expires_at: expiresAt.toISOString() };
  }

  async #createSession(client, user, roles, deviceLabel) {
    const refreshRaw = randomToken(48);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);
    const inserted = await client.query(
      `INSERT INTO refresh_tokens(user_id, token_hash, device_label, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [user.id, sha256Hex(refreshRaw), deviceLabel || null, expiresAt],
    );
    await client.query('UPDATE refresh_tokens SET family_id=$1 WHERE id=$1', [inserted.rows[0].id]);
    return {
      accessToken: this.issueAccessToken(user, roles),
      refreshToken: refreshRaw,
      refreshExpiresAt: expiresAt.toISOString(),
      accessExpiresIn: ACCESS_TTL_SECONDS,
    };
  }
}
