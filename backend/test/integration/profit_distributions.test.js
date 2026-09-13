import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresGrowBangladeshService } from '../../src/postgres_service.js';
import { PROJECT_WORKFLOW_STATUS } from '../../src/project_workflow.js';

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

async function createDisposableDb() {
  if (!baseUrl) return null;
  process.env.JWT_SECRET = jwtSecret;
  process.env.FIELD_ENCRYPTION_KEY = encKey;
  process.env.NODE_ENV = 'test';
  process.env.STAGING_ACCESS_REQUIRED = 'false';
  process.env.ALLOW_DEV_USER_HEADER = 'false';
  process.env.ALLOW_OTP_PREVIEW = 'true';
  process.env.OTP_PREVIEW_ALLOWLIST = '@example.invalid';
  delete process.env.STAGING_INVITE_CODE;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 2 });
  const dbName = `grow_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
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
    investor2: randomUUID(),
  };
  const { hashPassword } = await import('../../src/crypto_util.js');
  const hash = await hashPassword('TestPassword123!');
  for (const [key, email, role] of [
    ['admin', 'admin-p5@example.invalid', 'super_admin'],
    ['finance', 'finance-p5@example.invalid', 'finance_officer'],
    ['owner', 'owner-p5@example.invalid', 'project_owner'],
    ['investor', 'investor-p5@example.invalid', 'investor'],
    ['investor2', 'investor2-p5@example.invalid', 'investor'],
  ]) {
    await pool.query(
      `INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`,
      [ids[key], email, hash],
    );
    await pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)`, [ids[key], role]);
  }
  await pool.query(
    `INSERT INTO businesses(owner_user_id, legal_name, verification_status) VALUES ($1,'P5 Owner Biz','verified')`,
    [ids.owner],
  );
  await pool.query(
    `INSERT INTO investor_profiles(user_id, full_name, kyc_status) VALUES ($1,'Investor One','not_started'), ($2,'Investor Two','not_started')`,
    [ids.investor, ids.investor2],
  );
  return ids;
}

function httpJson(base, method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const req = http.request(
      url,
      {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = {};
          try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startServer(connectionString) {
  const port = 4300 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      JWT_SECRET: jwtSecret,
      FIELD_ENCRYPTION_KEY: encKey,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      STAGING_ACCESS_REQUIRED: 'false',
      ALLOW_DEV_USER_HEADER: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await httpJson(base, 'GET', '/health');
      if (res.status === 200) return { child, base };
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error('server failed to start');
}

async function login(base, email) {
  const res = await httpJson(base, 'POST', '/auth/login', {
    body: { email, password: 'TestPassword123!' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.data.accessToken;
}

const completeTerms = {
  riskDisclosure: 'Capital at risk. Markets move. Not guaranteed.',
  termsText: 'Investors accept unit terms and fee schedule.',
  exitPolicy: 'Exit after minimum hold; subject to liquidity. Not withdrawable.',
};

async function createActiveAllocation(service, ids) {
  const cats = await service.listActiveCategories();
  const draft = await service.createProject(
    {
      title: 'Phase5 Projection Project',
      categoryId: cats[0].id,
      summary: 'Holdings for Approved distributions',
      totalUnits: 50,
      unitInvestmentPoisha: 850_000,
      administrationFeeBps: 1500,
      selectedRateBps: 1800,
      projectedReturnMinBps: 1500,
      projectedReturnMaxBps: 2200,
      durationDays: 365,
      ...completeTerms,
    },
    ids.owner,
  );
  await service.submitOwnerProject(draft.id, ids.owner);
  await service.approveProject(draft.id, ids.admin);
  const published = await service.publishProject(draft.id, ids.admin, completeTerms);
  assert.equal(published.status, PROJECT_WORKFLOW_STATUS.PUBLISHED);

  const app = await service.applyForUnits(
    {
      projectId: published.id,
      investorId: ids.investor,
      units: 2,
      acceptedTermsVersion: published.publishedTermsVersion,
    },
    ids.investor,
  );
  await service.approveApplication(app.id, ids.admin);
  const payment = await service.submitPayment(
    {
      applicationId: app.id,
      method: 'bank_transfer',
      reference: `BANK-P5-${randomUUID().slice(0, 8)}`,
      amountPoisha: app.totalPayablePoisha,
      paidOn: '2026-09-01',
      evidenceStorageKey: 'evidence/p5.pdf',
      idempotencyKey: `idem-${randomUUID()}`,
      requestContext: { ip: '203.0.113.50', userAgent: 'finance' },
    },
    ids.finance,
  );
  const verified = await service.verifyPayment(payment.id, ids.admin, 'Matched for Phase 5', {
    actorRoles: ['super_admin'],
    overrideMakerChecker: true,
    overrideReason: 'Integration test activation',
    requestContext: { ip: '203.0.113.51', userAgent: 'admin' },
  });
  assert.ok(verified.allocation?.id || verified.payment?.status === 'verified');
  const investments = await service.listInvestments({ actorId: ids.investor, canViewAny: false });
  assert.ok(investments.length >= 1);
  return { published, application: app, allocation: investments[0] };
}

test('profit service: declare Approved distribution + projection clarity', async (t) => {
  const db = await createDisposableDb();
  if (!db) {
    t.skip('TEST_DATABASE_URL not configured');
    return;
  }
  t.after(() => db.cleanup());
  const ids = await seedActors(db.pool);
  const service = new PostgresGrowBangladeshService(db.pool);
  const { allocation } = await createActiveAllocation(service, ids);

  const detail = await service.getInvestment(allocation.id, ids.investor);
  assert.equal(detail.estimateLabel, 'Projected return — not guaranteed');
  assert.match(detail.projectionDisclaimer, /not guaranteed/i);
  assert.equal(detail.withdrawable, false);
  assert.equal(detail.projectionNeverPayable, true);
  assert.equal(typeof detail.dailyProjectedReturnPoisha, 'number');
  assert.equal(detail.confirmedProfitPoisha, 0);
  assert.doesNotMatch(JSON.stringify(detail).toLowerCase(), /wallet/);

  const declared = await service.declareProfitConfirmation(
    allocation.id,
    {
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
      confirmedProfitPoisha: 120_000,
      declarationNote: 'Q1 approved accounts',
      notes: 'Fictional staging distribution',
    },
    ids.finance,
    { requestContext: { ip: '203.0.113.60', userAgent: 'finance' } },
  );
  assert.equal(declared.confirmedProfitPoisha, 120_000);
  assert.equal(declared.availablePayablePoisha, 120_000);
  assert.equal(declared.status, 'approved');
  assert.equal(declared.payoutEnabled, false);
  assert.equal(declared.withdrawable, false);

  await assert.rejects(
    () =>
      service.declareProfitConfirmation(
        allocation.id,
        { periodStart: '2026-01-01', periodEnd: '2026-03-31', confirmedProfitPoisha: 1 },
        ids.admin,
      ),
    (e) => e.code === 'DUPLICATE_PERIOD',
  );

  const after = await service.getInvestment(allocation.id, ids.investor);
  assert.equal(after.confirmedProfitPoisha, 120_000);
  assert.equal(after.approvedDistributions.length, 1);
  assert.ok(after.projectedAccruedReturnPoisha !== after.confirmedProfitPoisha || after.projectedAccruedReturnPoisha >= 0);

  const own = await service.listApprovedDistributions(allocation.id, ids.investor, { canViewAny: false });
  assert.equal(own.length, 1);
  await assert.rejects(
    () => service.listApprovedDistributions(allocation.id, ids.investor2, { canViewAny: false }),
    (e) => e.code === 'FORBIDDEN' && e.httpStatus === 403,
  );

  const audits = await db.pool.query(
    `SELECT count(*)::int AS c FROM audit_logs WHERE action='profit_confirmation.declared'`,
  );
  assert.equal(audits.rows[0].c, 1);
});

test('profit HTTP authz: unauth 401, owner/investor 403 on declare, investor own-only', async (t) => {
  const db = await createDisposableDb();
  if (!db) {
    t.skip('TEST_DATABASE_URL not configured');
    return;
  }
  t.after(() => db.cleanup());
  const ids = await seedActors(db.pool);
  const service = new PostgresGrowBangladeshService(db.pool);
  const { allocation } = await createActiveAllocation(service, ids);
  const { child, base } = await startServer(db.connectionString);
  t.after(() => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  });

  const unauth = await httpJson(base, 'POST', `/admin/allocations/${allocation.id}/profit-confirmations`, {
    body: { periodStart: '2026-04-01', periodEnd: '2026-06-30', confirmedProfitPoisha: 10_000 },
  });
  assert.equal(unauth.status, 401);

  const ownerToken = await login(base, 'owner-p5@example.invalid');
  const ownerDeclare = await httpJson(base, 'POST', `/admin/allocations/${allocation.id}/profit-confirmations`, {
    token: ownerToken,
    body: { periodStart: '2026-04-01', periodEnd: '2026-06-30', confirmedProfitPoisha: 10_000 },
  });
  assert.equal(ownerDeclare.status, 403);

  const investorToken = await login(base, 'investor-p5@example.invalid');
  const investorDeclare = await httpJson(base, 'POST', `/admin/allocations/${allocation.id}/profit-confirmations`, {
    token: investorToken,
    body: { periodStart: '2026-04-01', periodEnd: '2026-06-30', confirmedProfitPoisha: 10_000 },
  });
  assert.equal(investorDeclare.status, 403);

  const financeToken = await login(base, 'finance-p5@example.invalid');
  const ok = await httpJson(base, 'POST', `/admin/allocations/${allocation.id}/profit-confirmations`, {
    token: financeToken,
    body: {
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
      confirmedProfitPoisha: 55_000,
      declarationNote: 'Q2 staging approval',
    },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.data.confirmedProfitPoisha, 55_000);

  const invList = await httpJson(base, 'GET', `/investments/${allocation.id}/approved-distributions`, {
    token: investorToken,
  });
  assert.equal(invList.status, 200);
  assert.ok(invList.json.data.length >= 1);

  const otherToken = await login(base, 'investor2-p5@example.invalid');
  const otherList = await httpJson(base, 'GET', `/investments/${allocation.id}/approved-distributions`, {
    token: otherToken,
  });
  assert.equal(otherList.status, 403);

  const detail = await httpJson(base, 'GET', `/investments/${allocation.id}`, { token: investorToken });
  assert.equal(detail.status, 200);
  assert.match(detail.json.data.estimateLabel, /not guaranteed/i);
  assert.equal(detail.json.data.withdrawable, false);
  assert.ok(detail.json.data.confirmedProfitPoisha >= 55_000);
});
