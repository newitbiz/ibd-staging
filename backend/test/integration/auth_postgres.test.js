import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthService } from '../../src/auth_service.js';
import { MemoryEmailAdapter } from '../../src/email/adapter.js';
import { createVerificationDelivery } from '../../src/verification_delivery.js';
import { attachLegalToAuth, buildSignupAcceptances } from '../helpers/legal_acceptances.js';
import { PostgresGrowBangladeshService } from '../../src/postgres_service.js';
import { withTransaction } from '../../src/db.js';

const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET || 'integration-test-jwt-secret-at-least-32';

const directory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(directory, '..', '..', 'database', 'schema.sql');
const migrationsDir = path.join(directory, '..', '..', 'database', 'migrations');

async function applySchema(pool) {
  await pool.query(await readFile(schemaPath, 'utf8'));
  const files = (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(await readFile(path.join(migrationsDir, file), 'utf8'));
  }
}


function attachPoolGuards(pool) {
  pool.on('error', () => {
    // Ignore idle-client errors after DROP DATABASE ... FORCE during disposable cleanup.
  });
}

async function createDisposableDb() {
  if (!baseUrl) {
    return null;
  }
  process.env.JWT_SECRET = jwtSecret;
  process.env.NODE_ENV = 'test';
  // Integration tests need OTP preview for disposable *@example.invalid identities only.
  process.env.ALLOW_OTP_PREVIEW = 'true';
  process.env.OTP_PREVIEW_ALLOWLIST = 'rahim@example.invalid,@example.invalid';
  process.env.STAGING_ACCESS_REQUIRED = 'false';
  delete process.env.STAGING_INVITE_CODE;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 2 });
  const dbName = `grow_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  attachPoolGuards(pool);
  attachPoolGuards(admin);
  await applySchema(pool);
  return {
    pool,
    async cleanup() {
      try {
        await pool.end();
      } catch {
        /* ignore */
      }
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } catch {
        /* ignore */
      }
      try {
        await admin.end();
      } catch {
        /* ignore */
      }
    },
  };
}

test('auth registration, OTP, refresh rotation, logout, and password reset', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  const { pool, cleanup } = ctx;
  t.after(cleanup);
  const memory = new MemoryEmailAdapter();
  const auth = new AuthService(pool, {
    emailAdapter: memory,
    verificationDelivery: createVerificationDelivery({ emailAdapter: memory }),
  });
  const legalService = await attachLegalToAuth(auth, pool);

  const registered = await auth.register({
    email: 'rahim@example.invalid',
    mobile: '+8801711999001',
    password: 'InvestorPass123!',
    fullName: 'Rahim Investor',
    role: 'investor',
    legalAcceptances: await buildSignupAcceptances(legalService, 'investor'),
    marketingConsent: false,
  });
  assert.equal(registered.user.status, 'pending_verification');
  assert.equal(registered.accessToken, undefined);
  assert.ok(registered.emailVerification?.sent);
  assert.equal(registered.emailVerification?.previewCode, undefined);
  assert.equal(registered.otp, undefined);
  const emailMsg = memory.last();
  assert.ok(emailMsg);
  const codeMatch = emailMsg.text.match(/\b(\d{6})\b/);
  assert.ok(codeMatch);
  const verified = await auth.verifyEmailCode({
    email: 'rahim@example.invalid',
    code: codeMatch[1],
  });
  assert.equal(verified.user.status, 'active');
  assert.ok(verified.user.emailVerifiedAt);
  assert.ok(verified.accessToken);
  assert.ok(verified.refreshToken);

  const refreshed = await auth.refresh({ refreshToken: verified.refreshToken });
  assert.ok(refreshed.accessToken);
  assert.notEqual(refreshed.refreshToken, verified.refreshToken);

  await assert.rejects(
    () => auth.refresh({ refreshToken: verified.refreshToken }),
    (error) => error.code === 'REFRESH_REUSED',
  );

  const login = await auth.login({ email: 'rahim@example.invalid', password: 'InvestorPass123!' });
  assert.equal(login.requiresOtp, false);
  assert.ok(login.accessToken);

  await auth.logout({ refreshToken: login.refreshToken });
  await assert.rejects(
    () => auth.refresh({ refreshToken: login.refreshToken }),
    (error) => error.code === 'REFRESH_INVALID' || error.code === 'REFRESH_REUSED',
  );

  const forgot = await auth.requestPasswordReset({ email: 'rahim@example.invalid' });
  const otpReset = await auth.verifyOtp({ challengeId: forgot.challengeId, code: forgot.previewCode });
  assert.ok(otpReset.resetToken);
  await auth.resetPassword({ resetToken: otpReset.resetToken, newPassword: 'NewInvestorPass123!' });
  const relogin = await auth.login({ email: 'rahim@example.invalid', password: 'NewInvestorPass123!' });
  assert.ok(relogin.accessToken);
});

test('payment verification allocates units in one transaction and survives service restart semantics', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  const { pool, cleanup } = ctx;
  t.after(cleanup);

  const adminId = randomUUID();
  const ownerId = randomUUID();
  const investorId = randomUUID();
  const businessId = randomUUID();

  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id,email,password_hash,status) VALUES
       ($1,'a@ex.invalid','x','active'),
       ($2,'o@ex.invalid','x','active'),
       ($3,'i@ex.invalid','x','active')`,
      [adminId, ownerId, investorId],
    );
    await client.query(
      `INSERT INTO user_roles(user_id,role_code) VALUES
       ($1,'super_admin'),($2,'project_owner'),($3,'investor')`,
      [adminId, ownerId, investorId],
    );
    await client.query(
      `INSERT INTO businesses(id,owner_user_id,legal_name,verification_status)
       VALUES ($1,$2,'Biz','verified')`,
      [businessId, ownerId],
    );
  });

  const service = new PostgresGrowBangladeshService(pool);
  const project = await service.createProject({
    businessId,
    title: 'Integration Project',
    category: 'manufacturing',
    summary: 'Disposable integration project',
    totalUnits: 10,
    unitInvestmentPoisha: 850_000,
    administrationFeeBps: 1500,
    targetProfitBps: 2000,
    durationDays: 365,
  }, ownerId);
  await service.publishProject(project.id, adminId, { versionNote: 'v1' });
  const application = await service.applyForUnits({
    projectId: project.id,
    investorId,
    units: 2,
    acceptedTermsVersion: 1,
  }, investorId);
  await service.approveApplication(application.id, adminId);
  const payment = await service.submitPayment({
    applicationId: application.id,
    method: 'bank_transfer',
    reference: `REF-${randomUUID().slice(0, 8)}`,
    amountPoisha: 1_955_000,
    paidOn: '2026-09-07',
    evidenceStorageKey: 'evidence/integration-bank.pdf',
    idempotencyKey: `idem-${randomUUID()}`,
  }, investorId);
  const verified = await service.verifyPayment(payment.id, adminId, 'Matched bank statement', {
    actorRoles: ['super_admin'],
  });
  assert.equal(verified.allocation.units, 2);
  assert.equal(verified.payment.status, 'verified');

  // Re-open a new service instance against the same DB (restart simulation).
  const restarted = new PostgresGrowBangladeshService(pool);
  const investment = await restarted.getInvestment(verified.allocation.id, investorId);
  assert.equal(investment.units, 2);
  assert.equal(investment.investmentPoisha, 1_700_000);
  assert.equal(typeof investment.estimatedProfitPoisha, 'number');
  assert.equal(investment.confirmedProfitPoisha, 0);
});

test('email register never returns codes; phone OTP previewCode still gated by allowlist', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  const { pool, cleanup } = ctx;
  t.after(cleanup);
  const memory = new MemoryEmailAdapter();
  const auth = new AuthService(pool, {
    emailAdapter: memory,
    verificationDelivery: createVerificationDelivery({ emailAdapter: memory }),
  });
  const legalService = await attachLegalToAuth(auth, pool);

  process.env.ALLOW_OTP_PREVIEW = 'true';
  process.env.OTP_PREVIEW_ALLOWLIST = '@example.invalid';
  const registered = await auth.register({
    email: 'nopreview@example.invalid',
    mobile: '+8801711888001',
    password: 'InvestorPass123!',
    fullName: 'No Preview',
    role: 'investor',
    legalAcceptances: await buildSignupAcceptances(legalService, 'investor'),
    marketingConsent: false,
  });
  // Email verification must never leak codes/tokens even when OTP preview is on.
  assert.equal(registered.otp, undefined);
  assert.equal(registered.emailVerification?.previewCode, undefined);
  assert.equal(registered.emailVerification?.code, undefined);
  assert.equal(registered.accessToken, undefined);
  assert.ok(registered.emailVerification?.sent);

  // Activate so password-reset OTP path can be exercised.
  const codeMatch = memory.last().text.match(/\b(\d{6})\b/);
  await auth.verifyEmailCode({ email: 'nopreview@example.invalid', code: codeMatch[1] });

  process.env.ALLOW_OTP_PREVIEW = 'false';
  process.env.OTP_PREVIEW_ALLOWLIST = '';
  const hiddenReset = await auth.requestPasswordReset({ email: 'nopreview@example.invalid' });
  assert.equal(hiddenReset.previewCode, undefined);
  assert.ok(hiddenReset.challengeId);

  process.env.ALLOW_OTP_PREVIEW = 'true';
  process.env.OTP_PREVIEW_ALLOWLIST = 'nopreview@example.invalid';
  const shownReset = await auth.requestPasswordReset({ email: 'nopreview@example.invalid' });
  assert.match(shownReset.previewCode, /^\d{6}$/);
});

test('staging invite code is required when STAGING_ACCESS_REQUIRED=true', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  const { pool, cleanup } = ctx;
  t.after(cleanup);
  const memory = new MemoryEmailAdapter();
  const auth = new AuthService(pool, {
    emailAdapter: memory,
    verificationDelivery: createVerificationDelivery({ emailAdapter: memory }),
  });
  const legalService = await attachLegalToAuth(auth, pool);
  process.env.STAGING_ACCESS_REQUIRED = 'true';
  process.env.STAGING_INVITE_CODE = 'test-invite-code-xyz';
  await assert.rejects(
    () => auth.register({
      email: 'invite-missing@example.invalid',
      mobile: '+8801711888002',
      password: 'InvestorPass123!',
      fullName: 'Missing Invite',
      role: 'investor',
    }),
    (error) => error.code === 'INVITE_REQUIRED',
  );
  await assert.rejects(
    () => auth.register({
      email: 'invite-bad@example.invalid',
      mobile: '+8801711888003',
      password: 'InvestorPass123!',
      fullName: 'Bad Invite',
      role: 'investor',
      inviteCode: 'wrong',
    }),
    (error) => error.code === 'INVITE_INVALID',
  );
  const ok = await auth.register({
    email: 'invite-ok@example.invalid',
    mobile: '+8801711888004',
    password: 'InvestorPass123!',
    fullName: 'Good Invite',
    role: 'investor',
    inviteCode: 'test-invite-code-xyz',
    legalAcceptances: await buildSignupAcceptances(legalService, 'investor'),
    marketingConsent: false,
  });
  assert.ok(ok.emailVerification?.sent);
  assert.equal(ok.accessToken, undefined);
  process.env.STAGING_ACCESS_REQUIRED = 'false';
});
