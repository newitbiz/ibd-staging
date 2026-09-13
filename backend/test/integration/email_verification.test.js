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
import { authRateLimiter } from '../../src/rate_limit.js';
import { sha256Hex } from '../../src/crypto_util.js';

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
  pool.on('error', () => {});
}

async function createDisposableDb() {
  if (!baseUrl) return null;
  process.env.JWT_SECRET = jwtSecret;
  process.env.NODE_ENV = 'test';
  process.env.APP_PUBLIC_URL = 'https://staging.example.invalid';
  process.env.ALLOW_OTP_PREVIEW = 'true';
  process.env.OTP_PREVIEW_ALLOWLIST = '@example.invalid';
  process.env.STAGING_ACCESS_REQUIRED = 'false';
  delete process.env.STAGING_INVITE_CODE;
  process.env.EMAIL_ADAPTER = 'memory';

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

function extractCodeFromEmail(message) {
  assert.ok(message, 'expected an email message');
  const match = message.text.match(/\b(\d{6})\b/);
  assert.ok(match, 'expected 6-digit code in email text');
  return match[1];
}

function extractTokenFromEmail(message) {
  assert.ok(message, 'expected an email message');
  const match = message.text.match(/token=([A-Za-z0-9_-]+)/);
  assert.ok(match, 'expected verify token in email text');
  return match[1];
}

function assertNoSecretsInPayload(payload) {
  const json = JSON.stringify(payload);
  assert.equal(payload?.emailVerification?.code, undefined);
  assert.equal(payload?.emailVerification?.token, undefined);
  assert.equal(payload?.emailVerification?.previewCode, undefined);
  assert.equal(payload?.previewCode, undefined);
  assert.equal(payload?.verificationToken, undefined);
  assert.equal(payload?.plainCode, undefined);
  assert.equal(payload?.plainToken, undefined);
  // Codes are 6 digits — ensure response body does not embed a standalone code field.
  assert.doesNotMatch(json, /"code"\s*:\s*"\d{6}"/);
  assert.doesNotMatch(json, /"token"\s*:\s*"[A-Za-z0-9_-]{20,}"/);
}

async function makeAuth(pool, memory) {
  const delivery = createVerificationDelivery({ emailAdapter: memory });
  const auth = new AuthService(pool, { emailAdapter: memory, verificationDelivery: delivery });
  const legalService = await attachLegalToAuth(auth, pool);
  return { auth, legalService };
}

test('email verification: valid code activates and issues tokens; secrets never in API', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const memory = new MemoryEmailAdapter();
  const { auth, legalService } = await makeAuth(ctx.pool, memory);

  const registered = await auth.register({
    email: 'verify-code@example.invalid',
    mobile: '+8801711000001',
    password: 'InvestorPass123!',
    fullName: 'Code Verifier',
    role: 'investor',
    legalAcceptances: await buildSignupAcceptances(legalService, 'investor'),
    marketingConsent: false,
  });
  assert.equal(registered.user.status, 'pending_verification');
  assert.equal(registered.accessToken, undefined);
  assert.equal(registered.refreshToken, undefined);
  assertNoSecretsInPayload(registered);

  const code = extractCodeFromEmail(memory.last());
  const verified = await auth.verifyEmailCode({
    email: 'verify-code@example.invalid',
    code,
  });
  assert.equal(verified.user.status, 'active');
  assert.ok(verified.user.emailVerifiedAt);
  assert.ok(verified.accessToken);
  assert.ok(verified.refreshToken);
  assertNoSecretsInPayload(verified);
});

test('email verification: valid link activates; reuse rejected', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const memory = new MemoryEmailAdapter();
  const { auth, legalService } = await makeAuth(ctx.pool, memory);

  await auth.register({
    email: 'verify-link@example.invalid',
    mobile: '+8801711000002',
    password: 'InvestorPass123!',
    fullName: 'Link Verifier',
    legalAcceptances: await buildSignupAcceptances(legalService, 'investor'),
    marketingConsent: false,
  });
  const token = extractTokenFromEmail(memory.last());
  const verified = await auth.verifyEmailToken({ token });
  assert.equal(verified.user.status, 'active');
  assert.ok(verified.accessToken);

  await assert.rejects(
    () => auth.verifyEmailToken({ token }),
    (error) => error.code === 'EMAIL_VERIFY_USED' || error.code === 'EMAIL_ALREADY_VERIFIED',
  );
});

test('email verification: expired code rejected', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const memory = new MemoryEmailAdapter();
  const { auth, legalService } = await makeAuth(ctx.pool, memory);

  await auth.register({
    email: 'expired@example.invalid',
    mobile: '+8801711000003',
    password: 'InvestorPass123!',
    fullName: 'Expired User',
    legalAcceptances: await buildSignupAcceptances(legalService, 'investor'),
    marketingConsent: false,
  });
  const code = extractCodeFromEmail(memory.last());
  await ctx.pool.query(
    `UPDATE email_verifications
     SET created_at = now() - interval '20 minutes',
         expires_at = now() - interval '1 minute'`,
  );
  await assert.rejects(
    () => auth.verifyEmailCode({ email: 'expired@example.invalid', code }),
    (error) => error.code === 'EMAIL_VERIFY_EXPIRED',
  );
});

test('email verification: resend invalidates previous code and link', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const memory = new MemoryEmailAdapter();
  const { auth, legalService } = await makeAuth(ctx.pool, memory);

  await auth.register({
    email: 'resend@example.invalid',
    mobile: '+8801711000004',
    password: 'InvestorPass123!',
    fullName: 'Resend User',
    legalAcceptances: await buildSignupAcceptances(legalService, 'investor'),
    marketingConsent: false,
  });
  const oldCode = extractCodeFromEmail(memory.messagesTo('resend@example.invalid')[0]);
  const oldToken = extractTokenFromEmail(memory.messagesTo('resend@example.invalid')[0]);

  const resent = await auth.resendEmailVerification({ email: 'resend@example.invalid' });
  assertNoSecretsInPayload(resent);
  assert.equal(resent.accepted, true);

  const newMsg = memory.messagesTo('resend@example.invalid').at(-1);
  const newCode = extractCodeFromEmail(newMsg);
  assert.notEqual(newCode, oldCode);

  await assert.rejects(
    () => auth.verifyEmailCode({ email: 'resend@example.invalid', code: oldCode }),
    (error) =>
      error.code === 'EMAIL_VERIFY_INVALID' || error.code === 'EMAIL_VERIFY_EXPIRED',
  );
  await assert.rejects(
    () => auth.verifyEmailToken({ token: oldToken }),
    (error) => error.code === 'EMAIL_VERIFY_INVALID' || error.code === 'EMAIL_VERIFY_EXPIRED',
  );

  const verified = await auth.verifyEmailCode({ email: 'resend@example.invalid', code: newCode });
  assert.equal(verified.user.status, 'active');
});

test('email verification: max attempts lockout', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const memory = new MemoryEmailAdapter();
  const { auth, legalService } = await makeAuth(ctx.pool, memory);

  await auth.register({
    email: 'attempts@example.invalid',
    mobile: '+8801711000005',
    password: 'InvestorPass123!',
    fullName: 'Attempts User',
    legalAcceptances: await buildSignupAcceptances(legalService, 'investor'),
    marketingConsent: false,
  });
  const realCode = extractCodeFromEmail(memory.last());
  const wrongCode = realCode === '111111' ? '222222' : '111111';

  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(
      () => auth.verifyEmailCode({ email: 'attempts@example.invalid', code: wrongCode }),
      (error) =>
        error.code === 'EMAIL_VERIFY_INVALID' || error.code === 'EMAIL_VERIFY_LOCKED',
    );
  }
  const attemptRow = await ctx.pool.query(
    `SELECT attempts FROM email_verifications WHERE email=$1 ORDER BY created_at DESC LIMIT 1`,
    ['attempts@example.invalid'],
  );
  assert.ok(attemptRow.rows[0].attempts >= 5);
  await assert.rejects(
    () => auth.verifyEmailCode({ email: 'attempts@example.invalid', code: realCode }),
    (error) => error.code === 'EMAIL_VERIFY_LOCKED',
  );
});

test('email verification: hashed storage only; ALLOW_OTP_PREVIEW never leaks email codes', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const memory = new MemoryEmailAdapter();
  const { auth, legalService } = await makeAuth(ctx.pool, memory);

  const registered = await auth.register({
    email: 'hashcheck@example.invalid',
    mobile: '+8801711000006',
    password: 'InvestorPass123!',
    fullName: 'Hash Check',
    legalAcceptances: await buildSignupAcceptances(legalService, 'investor'),
    marketingConsent: false,
  });
  assertNoSecretsInPayload(registered);
  // Even with ALLOW_OTP_PREVIEW=true, registration must not include previewCode.
  assert.equal(registered.otp, undefined);

  const code = extractCodeFromEmail(memory.last());
  const token = extractTokenFromEmail(memory.last());
  const rows = await ctx.pool.query(
    `SELECT code_hash, token_hash FROM email_verifications WHERE email=$1`,
    ['hashcheck@example.invalid'],
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].code_hash, sha256Hex(code));
  assert.equal(rows.rows[0].token_hash, sha256Hex(token));
  assert.notEqual(rows.rows[0].code_hash, code);
  assert.notEqual(rows.rows[0].token_hash, token);
});

test('email verification: generic send response avoids enumeration', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  authRateLimiter.reset();
  const memory = new MemoryEmailAdapter();
  const { auth, legalService } = await makeAuth(ctx.pool, memory);

  const unknown = await auth.sendEmailVerification({ email: 'nobody@example.invalid' });
  assert.equal(unknown.accepted, true);
  assert.match(unknown.message, /if an account/i);
});
