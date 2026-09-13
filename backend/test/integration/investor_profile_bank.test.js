import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresGrowBangladeshService } from '../../src/postgres_service.js';
import { AuthService } from '../../src/auth_service.js';
import { MemoryEmailAdapter } from '../../src/email/adapter.js';
import { createVerificationDelivery } from '../../src/verification_delivery.js';
import { withTransaction } from '../../src/db.js';
import { resetFieldEncryptionKeyCache } from '../../src/field_encryption.js';

const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET || 'integration-test-jwt-secret-at-least-32';
const encKey = process.env.FIELD_ENCRYPTION_KEY || randomBytes(32).toString('base64');
const directory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(directory, '..', '..', 'database', 'schema.sql');
const migrationsDir = path.join(directory, '..', '..', 'database', 'migrations');
const serverPath = path.join(directory, '..', '..', 'src', 'server.js');

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
  process.env.FIELD_ENCRYPTION_KEY = encKey;
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_OTP_PREVIEW = 'true';
  process.env.OTP_PREVIEW_ALLOWLIST = '@example.invalid';
  process.env.STAGING_ACCESS_REQUIRED = 'false';
  process.env.ALLOW_DEV_USER_HEADER = 'false';
  delete process.env.STAGING_INVITE_CODE;
  resetFieldEncryptionKeyCache();
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
    connectionString: url.toString(),
    async cleanup() {
      try { await pool.end(); } catch { /* ignore */ }
      try { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } catch { /* ignore */ }
      try { await admin.end(); } catch { /* ignore */ }
    },
  };
}

async function seedActors(pool) {
  const ids = {
    admin: randomUUID(),
    finance: randomUUID(),
    owner: randomUUID(),
    investor: randomUUID(),
  };
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id,email,mobile,password_hash,status,email_verified_at) VALUES
       ($1,'admin-p3@example.invalid','+8801700000001','x','active',now()),
       ($2,'fin-p3@example.invalid','+8801700000002','x','active',now()),
       ($3,'owner-p3@example.invalid','+8801700000003','x','active',now()),
       ($4,'inv-p3@example.invalid','+8801700000004','x','active',now())`,
      [ids.admin, ids.finance, ids.owner, ids.investor],
    );
    await client.query(
      `INSERT INTO user_roles(user_id,role_code) VALUES
       ($1,'super_admin'),($2,'finance_officer'),($3,'project_owner'),($4,'investor')`,
      [ids.admin, ids.finance, ids.owner, ids.investor],
    );
    await client.query(
      `INSERT INTO investor_profiles(user_id, full_name, kyc_status) VALUES ($1,'Staging Investor','not_started')`,
      [ids.investor],
    );
  });
  return ids;
}

async function countAudits(pool, action) {
  const result = await pool.query('SELECT count(*)::int AS c FROM audit_logs WHERE action=$1', [action]);
  return result.rows[0].c;
}

async function waitForListen(child, timeoutMs = 15000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), timeoutMs);
    child.stdout.on('data', (buf) => {
      if (String(buf).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early: ${code}`));
    });
  });
}

test('profile + bank service: encrypt mask authz reset audit', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  const { pool, cleanup } = ctx;
  t.after(cleanup);
  const ids = await seedActors(pool);
  const service = new PostgresGrowBangladeshService(pool);

  const profile = await service.updateInvestorProfile(
    ids.investor,
    {
      fullName: 'Rahim Uddin Staging',
      phone: '+8801711002200',
      dateOfBirth: '1990-05-15',
      nationality: 'Bangladeshi',
      occupation: 'Engineer',
      presentAddress: '12 Test Road, Dhaka',
      permanentAddress: '45 Demo Village, Cumilla',
      nomineeName: 'Karim Uddin',
      nomineeRelationship: 'Brother',
      nomineePhone: '+8801711002211',
    },
    ids.investor,
  );
  assert.equal(profile.fullName, 'Rahim Uddin Staging');
  assert.equal(profile.kycStatus, 'not_started');
  assert.equal(profile.emailVerified, true);
  assert.ok(profile.completion.percent >= 60);
  assert.equal(await countAudits(pool, 'investor.profile.updated'), 1);

  const bankPlain = {
    accountHolderName: 'Rahim Uddin Staging',
    bankName: 'Demo Bank PLC',
    branchName: 'Gulshan',
    accountType: 'savings',
    accountNumber: '1234567890123',
    routingNumber: '090261234',
    mfsType: 'bkash',
    mfsNumber: '01711002200',
  };
  const upsert = await service.upsertInvestorBank(ids.investor, bankPlain, ids.investor);
  assert.equal(upsert.bank.accountNumberLast4, '0123');
  assert.equal(upsert.bank.accountNumberMasked, '****0123');
  assert.equal(upsert.bank.verificationStatus, 'pending');
  assert.equal(upsert.verificationReset, false);

  const raw = await pool.query(
    'SELECT account_number_ciphertext, routing_number_ciphertext, mfs_number_ciphertext FROM investor_bank_accounts WHERE user_id=$1',
    [ids.investor],
  );
  assert.ok(raw.rows[0].account_number_ciphertext.startsWith('v1:'));
  assert.equal(raw.rows[0].account_number_ciphertext.includes('1234567890123'), false);
  assert.equal(JSON.stringify(upsert).includes('1234567890123'), false);
  assert.equal(await countAudits(pool, 'investor.bank.upserted'), 1);

  const verified = await service.verifyInvestorBank(ids.investor, ids.finance, {
    status: 'verified',
    note: 'Matched staging statement',
  });
  assert.equal(verified.verificationStatus, 'verified');
  assert.equal(await countAudits(pool, 'investor.bank.verification_updated'), 1);

  const reset = await service.upsertInvestorBank(
    ids.investor,
    { ...bankPlain, accountNumber: '9876543210987' },
    ids.investor,
  );
  assert.equal(reset.verificationReset, true);
  assert.equal(reset.bank.verificationStatus, 'pending');
  assert.equal(reset.bank.accountNumberLast4, '0987');
  assert.equal(await countAudits(pool, 'investor.bank.updated_reset_pending'), 1);

  const withBank = await service.getInvestorProfile(ids.investor);
  assert.equal(withBank.completion.hasBank, true);
  assert.ok(withBank.completion.percent >= 90);

  const audits = await pool.query(
    `SELECT after_json::text AS t FROM audit_logs WHERE subject_type='investor_bank'`,
  );
  for (const row of audits.rows) {
    assert.equal(row.t.includes('1234567890123'), false);
    assert.equal(row.t.includes('9876543210987'), false);
  }
});

test('HTTP authz: unauth 401, owner 403 on bank, investor ok, finance masked', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  const { pool, connectionString, cleanup } = ctx;
  t.after(cleanup);
  const ids = await seedActors(pool);

  const memory = new MemoryEmailAdapter();
  const auth = new AuthService(pool, {
    emailAdapter: memory,
    verificationDelivery: createVerificationDelivery({ emailAdapter: memory }),
  });
  const invTok = auth.issueAccessToken({ id: ids.investor }, ['investor']);
  const ownerTok = auth.issueAccessToken({ id: ids.owner }, ['project_owner']);
  const finTok = auth.issueAccessToken({ id: ids.finance }, ['finance_officer']);

  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: connectionString,
      DATABASE_SSL: 'false',
      JWT_SECRET: jwtSecret,
      FIELD_ENCRYPTION_KEY: encKey,
      NODE_ENV: 'test',
      ALLOW_DEV_USER_HEADER: 'false',
      STAGING_ACCESS_REQUIRED: 'false',
      LIVE_PAYMENT_GATEWAYS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGTERM');
  });
  await waitForListen(child);

  async function httpJson(method, pathname, { token, body } = {}) {
    const payload = body == null ? null : JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: payload,
    });
    const json = await response.json();
    return { status: response.status, json };
  }

  const unauth = await httpJson('GET', '/me/profile');
  assert.equal(unauth.status, 401);

  const ownerBank = await httpJson('GET', `/admin/investors/${ids.investor}/bank`, { token: ownerTok });
  assert.equal(ownerBank.status, 403);

  const ownerMeBank = await httpJson('GET', '/me/bank', { token: ownerTok });
  assert.equal(ownerMeBank.status, 403);

  const patch = await httpJson('PATCH', '/me/profile', {
    token: invTok,
    body: {
      fullName: 'HTTP Investor',
      phone: '+8801799001122',
      dateOfBirth: '1992-01-01',
      nationality: 'Bangladeshi',
      occupation: 'Trader',
      presentAddress: 'HTTP Present Address Line',
      permanentAddress: 'HTTP Permanent Address Line',
      nomineeName: 'Nominee One',
      nomineeRelationship: 'Spouse',
      nomineePhone: '+8801799001133',
    },
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  assert.equal(patch.json.data.fullName, 'HTTP Investor');

  const putBank = await httpJson('PUT', '/me/bank', {
    token: invTok,
    body: {
      accountHolderName: 'HTTP Investor',
      bankName: 'City Demo Bank',
      branchName: 'Banani',
      accountType: 'current',
      accountNumber: '5555666677778888',
      routingNumber: '110220330',
    },
  });
  assert.equal(putBank.status, 200, JSON.stringify(putBank.json));
  assert.equal(putBank.json.data.bank.accountNumberLast4, '8888');
  assert.equal(JSON.stringify(putBank.json).includes('5555666677778888'), false);

  const finGet = await httpJson('GET', `/admin/investors/${ids.investor}/bank`, { token: finTok });
  assert.equal(finGet.status, 200);
  assert.equal(finGet.json.data.accountNumberLast4, '8888');
  assert.equal(JSON.stringify(finGet.json).includes('5555666677778888'), false);

  const ownerVerify = await httpJson('POST', `/admin/investors/${ids.investor}/bank/verify`, {
    token: ownerTok,
    body: { status: 'verified' },
  });
  assert.equal(ownerVerify.status, 403);
});
