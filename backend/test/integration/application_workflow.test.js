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
import { APPLICATION_WORKFLOW_STATUS as AS } from '../../src/application_workflow.js';

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
    owner: randomUUID(),
    investor: randomUUID(),
    investor2: randomUUID(),
  };
  const { hashPassword } = await import('../../src/crypto_util.js');
  const hash = await hashPassword('TestPassword123!');
  for (const [key, email, role] of [
    ['admin', 'admin-app@example.invalid', 'super_admin'],
    ['owner', 'owner-app@example.invalid', 'project_owner'],
    ['investor', 'investor-app@example.invalid', 'investor'],
    ['investor2', 'investor2-app@example.invalid', 'investor'],
  ]) {
    await pool.query(
      `INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`,
      [ids[key], email, hash],
    );
    await pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)`, [ids[key], role]);
  }
  await pool.query(
    `INSERT INTO businesses(owner_user_id, legal_name, verification_status) VALUES ($1,'App Owner Biz','verified')`,
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
  const port = 4200 + Math.floor(Math.random() * 800);
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
    } catch {
      /* retry */
    }
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

async function publishProject(service, ownerId, adminId, overrides = {}) {
  const cats = await service.listActiveCategories();
  const draft = await service.createProject(
    {
      title: overrides.title || 'Phase4 Apply Project',
      categoryId: cats[0].id,
      summary: 'Published marketplace project for applications',
      totalUnits: overrides.totalUnits || 100,
      unitInvestmentPoisha: overrides.unitInvestmentPoisha || 850_000,
      administrationFeeBps: overrides.administrationFeeBps || 1500,
      selectedRateBps: 1800,
      projectedReturnMinBps: 1500,
      projectedReturnMaxBps: 2200,
      durationDays: overrides.durationDays || 365,
      ...completeTerms,
    },
    ownerId,
  );
  await service.submitOwnerProject(draft.id, ownerId);
  await service.approveProject(draft.id, adminId);
  return service.publishProject(draft.id, adminId, completeTerms);
}

async function countAudits(pool, action) {
  const result = await pool.query('SELECT count(*)::int AS c FROM audit_logs WHERE action=$1', [action]);
  return result.rows[0].c;
}

test('application service: preview apply decide authz audit', async (t) => {
  const db = await createDisposableDb();
  if (!db) {
    t.skip('TEST_DATABASE_URL not configured');
    return;
  }
  t.after(() => db.cleanup());
  const ids = await seedActors(db.pool);
  const service = new PostgresGrowBangladeshService(db.pool);
  const published = await publishProject(service, ids.owner, ids.admin);
  assert.equal(published.status, PROJECT_WORKFLOW_STATUS.PUBLISHED);

  const preview = await service.previewInvestmentForProject(published.id, 3);
  assert.equal(preview.investmentPoisha, 2_550_000);
  assert.equal(preview.administrationFeePoisha, 382_500);
  assert.equal(preview.totalPayablePoisha, 2_932_500);

  const filtered = await service.listPublishedProjects({
    termMinDays: 300,
    termMaxDays: 400,
    unitPriceMinPoisha: 800_000,
    unitPriceMaxPoisha: 900_000,
    status: 'published',
  });
  assert.ok(filtered.some((p) => p.id === published.id));
  assert.ok(filtered.every((p) => p.businessName));

  const app = await service.applyForUnits(
    {
      projectId: published.id,
      investorId: ids.investor,
      units: 3,
      acceptedTermsVersion: published.publishedTermsVersion,
    },
    ids.investor,
  );
  assert.equal(app.status, AS.SUBMITTED);
  assert.equal(app.totalPayablePoisha, 2_932_500);
  assert.ok(app.projectVersionNumber >= 1);
  assert.equal(await countAudits(db.pool, 'application.submitted'), 1);

  const changes = await service.requestApplicationChanges(app.id, ids.admin, 'Clarify bank evidence plan.');
  assert.equal(changes.status, AS.CHANGES_REQUESTED);
  assert.equal(await countAudits(db.pool, 'application.changes_requested'), 1);

  const resubmitted = await service.resubmitApplication(app.id, ids.investor, { units: 2 });
  assert.equal(resubmitted.status, AS.SUBMITTED);
  assert.equal(resubmitted.units, 2);

  await service.startApplicationReview(app.id, ids.admin);
  const approved = await service.approveApplication(app.id, ids.admin);
  assert.equal(approved.status, AS.APPROVED_PAYMENT_PENDING);
  assert.equal(await countAudits(db.pool, 'application.approved'), 1);

  const mine = await service.listMyApplications(ids.investor);
  assert.equal(mine.length, 1);
  await assert.rejects(() => service.getMyApplication(app.id, ids.investor2), /FORBIDDEN|own/i);

  const app2 = await service.applyForUnits(
    {
      projectId: published.id,
      investorId: ids.investor2,
      units: 1,
      acceptedTermsVersion: published.publishedTermsVersion,
    },
    ids.investor2,
  );
  const rejected = await service.rejectApplication(app2.id, ids.admin, 'Incomplete profile for staging.');
  assert.equal(rejected.status, AS.REJECTED);
  assert.equal(await countAudits(db.pool, 'application.rejected'), 1);
});

test('application HTTP authz + preview + decisions', async (t) => {
  const db = await createDisposableDb();
  if (!db) {
    t.skip('TEST_DATABASE_URL not configured');
    return;
  }
  t.after(() => db.cleanup());
  await seedActors(db.pool);
  const { child, base } = await startServer(db.connectionString);
  t.after(() => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  });

  const adminToken = await login(base, 'admin-app@example.invalid');
  const ownerToken = await login(base, 'owner-app@example.invalid');
  const investorToken = await login(base, 'investor-app@example.invalid');
  const investor2Token = await login(base, 'investor2-app@example.invalid');

  // Seed via service using same DB
  const service = new PostgresGrowBangladeshService(db.pool);
  const ids = {
    admin: (await db.pool.query(`SELECT id FROM users WHERE email='admin-app@example.invalid'`)).rows[0].id,
    owner: (await db.pool.query(`SELECT id FROM users WHERE email='owner-app@example.invalid'`)).rows[0].id,
    investor: (await db.pool.query(`SELECT id FROM users WHERE email='investor-app@example.invalid'`)).rows[0].id,
  };
  const published = await publishProject(service, ids.owner, ids.admin, { title: 'HTTP Apply Project' });

  const unauthMine = await httpJson(base, 'GET', '/applications/mine');
  assert.equal(unauthMine.status, 401);

  const ownerApply = await httpJson(base, 'POST', '/applications', {
    token: ownerToken,
    body: { projectId: published.id, units: 1, acceptedTermsVersion: published.publishedTermsVersion },
  });
  assert.equal(ownerApply.status, 403);

  const preview = await httpJson(base, 'GET', `/projects/${published.id}/investment-preview?units=3`);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.data.totalPayablePoisha, 2_932_500);

  const rawPreview = await httpJson(base, 'POST', '/investments/preview', {
    body: { unitInvestmentPoisha: 850_000, administrationFeeBps: 1500, units: 3 },
  });
  assert.equal(rawPreview.status, 200);
  assert.equal(rawPreview.json.data.investmentPoisha, 2_550_000);

  const applied = await httpJson(base, 'POST', '/applications', {
    token: investorToken,
    body: { projectId: published.id, units: 3, acceptedTermsVersion: published.publishedTermsVersion },
  });
  assert.equal(applied.status, 201, JSON.stringify(applied.json));
  const applicationId = applied.json.data.id;

  const ownerMine = await httpJson(base, 'GET', '/applications/mine', { token: ownerToken });
  assert.equal(ownerMine.status, 403);

  const ownerAdminQueue = await httpJson(base, 'GET', '/admin/applications', { token: ownerToken });
  assert.equal(ownerAdminQueue.status, 403);

  const otherDetail = await httpJson(base, 'GET', `/applications/mine/${applicationId}`, { token: investor2Token });
  assert.equal(otherDetail.status, 403);

  const ownDetail = await httpJson(base, 'GET', `/applications/mine/${applicationId}`, { token: investorToken });
  assert.equal(ownDetail.status, 200);
  assert.equal(ownDetail.json.data.status, AS.SUBMITTED);

  const rejectNoReason = await httpJson(base, 'POST', `/admin/applications/${applicationId}/reject`, {
    token: adminToken,
    body: { reason: 'no' },
  });
  assert.equal(rejectNoReason.status, 400);

  const changes = await httpJson(base, 'POST', `/admin/applications/${applicationId}/request-changes`, {
    token: adminToken,
    body: { reason: 'Need clearer unit count justification.' },
  });
  assert.equal(changes.status, 200, JSON.stringify(changes.json));
  assert.equal(changes.json.data.status, AS.CHANGES_REQUESTED);

  const resubmit = await httpJson(base, 'POST', `/applications/${applicationId}/resubmit`, {
    token: investorToken,
    body: { units: 2 },
  });
  assert.equal(resubmit.status, 200);
  assert.equal(resubmit.json.data.status, AS.SUBMITTED);

  const approve = await httpJson(base, 'POST', `/admin/applications/${applicationId}/approve`, {
    token: adminToken,
  });
  assert.equal(approve.status, 200, JSON.stringify(approve.json));
  assert.equal(approve.json.data.status, AS.APPROVED_PAYMENT_PENDING);

  const queue = await httpJson(base, 'GET', '/admin/applications', { token: adminToken });
  assert.equal(queue.status, 200);
  // approved apps leave default review queue
  assert.ok(!queue.json.data.some((row) => row.id === applicationId));

  const approvedList = await httpJson(base, 'GET', '/admin/applications?status=approved_payment_pending', {
    token: adminToken,
  });
  assert.equal(approvedList.status, 200);
  assert.ok(approvedList.json.data.some((row) => row.id === applicationId));
});
