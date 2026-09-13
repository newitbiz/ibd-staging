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
    ['admin', 'admin-p6@example.invalid', 'super_admin'],
    ['finance', 'finance-p6@example.invalid', 'finance_officer'],
    ['owner', 'owner-p6@example.invalid', 'project_owner'],
    ['investor', 'investor-p6@example.invalid', 'investor'],
    ['investor2', 'investor2-p6@example.invalid', 'investor'],
  ]) {
    await pool.query(
      `INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`,
      [ids[key], email, hash],
    );
    await pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)`, [ids[key], role]);
  }
  await pool.query(
    `INSERT INTO businesses(owner_user_id, legal_name, verification_status) VALUES ($1,'P6 Owner Biz','verified')`,
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
  const port = 4500 + Math.floor(Math.random() * 800);
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
  exitPolicy: 'Exit after minimum hold; liquidity not guaranteed. Not a withdrawable balance.',
};

async function createActiveAllocation(service, pool, ids, { minimumExitDays = 0 } = {}) {
  const cats = await service.listActiveCategories();
  const draft = await service.createProject(
    {
      title: 'Phase6 Exit Project',
      categoryId: cats[0].id,
      summary: 'Share holdings for exit requests',
      totalUnits: 50,
      unitInvestmentPoisha: 850_000,
      administrationFeeBps: 1500,
      selectedRateBps: 1800,
      projectedReturnMinBps: 1500,
      projectedReturnMaxBps: 2200,
      durationDays: 365,
      minimumExitDays,
      ...completeTerms,
    },
    ids.owner,
  );
  await service.submitOwnerProject(draft.id, ids.owner);
  await service.approveProject(draft.id, ids.admin);
  const published = await service.publishProject(draft.id, ids.admin, {
    ...completeTerms,
    minimumExitDays,
  });
  assert.equal(published.status, PROJECT_WORKFLOW_STATUS.PUBLISHED);
  await pool.query(`UPDATE projects SET minimum_exit_days=$2 WHERE id=$1`, [published.id, minimumExitDays]);

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
      reference: `BANK-P6-${randomUUID().slice(0, 8)}`,
      amountPoisha: app.totalPayablePoisha,
      paidOn: '2026-09-01',
      evidenceStorageKey: 'evidence/p6.pdf',
      idempotencyKey: `idem-${randomUUID()}`,
      requestContext: { ip: '203.0.113.50', userAgent: 'finance' },
    },
    ids.finance,
  );
  await service.verifyPayment(payment.id, ids.admin, 'Matched for Phase 6', {
    actorRoles: ['super_admin'],
    overrideMakerChecker: true,
    overrideReason: 'Integration test activation',
    requestContext: { ip: '203.0.113.51', userAgent: 'admin' },
  });
  const investments = await service.listInvestments({ actorId: ids.investor, canViewAny: false });
  assert.ok(investments.length >= 1);
  return { published, allocation: investments[0] };
}

test('exit service: hold reject, submit, cancel, double-open, approve+complete display-only', async (t) => {
  const db = await createDisposableDb();
  if (!db) {
    t.skip('TEST_DATABASE_URL not configured');
    return;
  }
  t.after(() => db.cleanup());
  const ids = await seedActors(db.pool);
  const service = new PostgresGrowBangladeshService(db.pool);

  const blocked = await createActiveAllocation(service, db.pool, ids, { minimumExitDays: 180 });
  await assert.rejects(
    () => service.submitExitRequest(blocked.allocation.id, { reason: 'Need funds' }, ids.investor),
    (e) => e.code === 'HOLD_PERIOD_NOT_MET',
  );

  const { allocation } = await createActiveAllocation(service, db.pool, ids, { minimumExitDays: 0 });
  const eligibility = await service.getExitEligibility(allocation.id, ids.investor);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.liquidityGuaranteed, false);
  assert.doesNotMatch(JSON.stringify(eligibility).toLowerCase(), /wallet/);

  const submitted = await service.submitExitRequest(
    allocation.id,
    { reason: 'Personal liquidity need' },
    ids.investor,
    { requestContext: { ip: '203.0.113.70', userAgent: 'investor' } },
  );
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.payoutEnabled, false);

  await assert.rejects(
    () => service.submitExitRequest(allocation.id, { reason: 'Again' }, ids.investor),
    (e) => e.code === 'EXIT_ALREADY_OPEN',
  );

  await assert.rejects(
    () => service.submitExitRequest(allocation.id, { reason: 'Steal' }, ids.investor2),
    (e) => e.code === 'FORBIDDEN',
  );

  const cancelled = await service.cancelExitRequest(submitted.id, ids.investor, {
    requestContext: { ip: '203.0.113.71', userAgent: 'investor' },
  });
  assert.equal(cancelled.status, 'cancelled');

  const again = await service.submitExitRequest(
    allocation.id,
    { reason: 'Retry after cancel' },
    ids.investor,
  );
  await service.startExitReview(again.id, ids.finance);
  const approved = await service.approveExitRequest(
    again.id,
    { waitForLiquidity: true, liquidityNote: 'Awaiting buyback', decisionNote: 'OK with wait' },
    ids.finance,
  );
  assert.equal(approved.status, 'approved_waiting_liquidity');

  const completed = await service.completeExitRequest(
    again.id,
    { decisionNote: 'Exit payment record only' },
    ids.admin,
  );
  assert.equal(completed.status, 'completed');
  assert.ok(completed.exitPayment);
  assert.equal(completed.exitPayment.payoutType, 'early_exit');
  assert.equal(completed.exitPayment.fundsMoved, false);
  assert.equal(completed.exitPayment.payoutEnabled, false);
  assert.equal(completed.exitPayment.status, 'approved');

  const allocAfter = await db.pool.query(`SELECT status FROM allocations WHERE id=$1`, [allocation.id]);
  assert.equal(allocAfter.rows[0].status, 'exited');

  const audits = await db.pool.query(
    `SELECT action FROM audit_logs WHERE subject_type='exit_request' ORDER BY created_at`,
  );
  const actions = audits.rows.map((r) => r.action);
  assert.ok(actions.includes('exit_request.submitted'));
  assert.ok(actions.includes('exit_request.cancelled'));
  assert.ok(actions.includes('exit_request.approved'));
  assert.ok(actions.includes('exit_request.completed'));
});

test('exit HTTP authz: 401/403/own-only + admin review flow', async (t) => {
  const db = await createDisposableDb();
  if (!db) {
    t.skip('TEST_DATABASE_URL not configured');
    return;
  }
  t.after(() => db.cleanup());
  const ids = await seedActors(db.pool);
  const service = new PostgresGrowBangladeshService(db.pool);
  const { allocation } = await createActiveAllocation(service, db.pool, ids, { minimumExitDays: 0 });
  const { child, base } = await startServer(db.connectionString);
  t.after(() => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  });

  const unauth = await httpJson(base, 'POST', `/investments/${allocation.id}/exit-requests`, {
    body: { reason: 'Unauth' },
  });
  assert.equal(unauth.status, 401);

  const ownerToken = await login(base, 'owner-p6@example.invalid');
  const ownerSubmit = await httpJson(base, 'POST', `/investments/${allocation.id}/exit-requests`, {
    token: ownerToken,
    body: { reason: 'Owner should fail' },
  });
  assert.equal(ownerSubmit.status, 403);

  const otherToken = await login(base, 'investor2-p6@example.invalid');
  const otherSubmit = await httpJson(base, 'POST', `/investments/${allocation.id}/exit-requests`, {
    token: otherToken,
    body: { reason: 'Not my holding' },
  });
  assert.equal(otherSubmit.status, 403);

  const investorToken = await login(base, 'investor-p6@example.invalid');
  const submit = await httpJson(base, 'POST', `/investments/${allocation.id}/exit-requests`, {
    token: investorToken,
    body: { reason: 'Need early exit' },
  });
  assert.equal(submit.status, 201, JSON.stringify(submit.json));
  assert.match(submit.json.data.liquidityDisclaimer, /not guaranteed/i);
  const exitId = submit.json.data.id;

  const otherGet = await httpJson(base, 'GET', `/exit-requests/${exitId}`, { token: otherToken });
  assert.equal(otherGet.status, 403);

  const financeToken = await login(base, 'finance-p6@example.invalid');
  const review = await httpJson(base, 'POST', `/admin/exit-requests/${exitId}/start-review`, {
    token: financeToken,
    body: {},
  });
  assert.equal(review.status, 200, JSON.stringify(review.json));

  const rejectBad = await httpJson(base, 'POST', `/admin/exit-requests/${exitId}/reject`, {
    token: investorToken,
    body: { reason: 'Investor cannot reject' },
  });
  assert.equal(rejectBad.status, 403);

  const approve = await httpJson(base, 'POST', `/admin/exit-requests/${exitId}/approve`, {
    token: financeToken,
    body: { waitForLiquidity: false, decisionNote: 'Approved for Exit payment record' },
  });
  assert.equal(approve.status, 200, JSON.stringify(approve.json));
  assert.equal(approve.json.data.status, 'approved');

  const complete = await httpJson(base, 'POST', `/admin/exit-requests/${exitId}/complete`, {
    token: financeToken,
    body: { decisionNote: 'Create display-only Exit payment' },
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.json));
  assert.equal(complete.json.data.status, 'completed');
  assert.equal(complete.json.data.exitPayment.fundsMoved, false);
  assert.doesNotMatch(JSON.stringify(complete.json).toLowerCase(), /wallet/);
});
