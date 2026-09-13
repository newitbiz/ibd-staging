import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const ids = { admin: randomUUID(), owner: randomUUID(), investor: randomUUID(), otherOwner: randomUUID() };
  const { hashPassword } = await import('../../src/crypto_util.js');
  const hash = await hashPassword('TestPassword123!');
  for (const [key, email, role] of [
    ['admin', 'admin-wf@example.invalid', 'super_admin'],
    ['owner', 'owner-wf@example.invalid', 'project_owner'],
    ['investor', 'investor-wf@example.invalid', 'investor'],
    ['otherOwner', 'owner2-wf@example.invalid', 'project_owner'],
  ]) {
    await pool.query(
      `INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`,
      [ids[key], email, hash],
    );
    await pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)`, [ids[key], role]);
  }
  await pool.query(
    `INSERT INTO businesses(owner_user_id, legal_name, verification_status) VALUES ($1,'Owner Biz','verified')`,
    [ids.owner],
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
  const port = 4100 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      JWT_SECRET: jwtSecret,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      STAGING_ACCESS_REQUIRED: 'false',
      ALLOW_DEV_USER_HEADER: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i += 1) {
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

test('project workflow service transitions + versioning', async (t) => {
  const db = await createDisposableDb();
  if (!db) {
    t.skip('TEST_DATABASE_URL not configured');
    return;
  }
  t.after(() => db.cleanup());
  const ids = await seedActors(db.pool);
  const service = new PostgresGrowBangladeshService(db.pool);
  const cats = await service.listActiveCategories();
  assert.ok(cats.length >= 1);

  const draft = await service.createProject(
    {
      title: 'Workflow Test Project Alpha',
      categoryId: cats[0].id,
      summary: 'Incomplete draft ok',
      totalUnits: 100,
      unitInvestmentPoisha: 500000,
      administrationFeeBps: 1000,
      selectedRateBps: 1800,
      projectedReturnMinBps: 1500,
      projectedReturnMaxBps: 2200,
      durationDays: 180,
    },
    ids.owner,
  );
  assert.equal(draft.status, PROJECT_WORKFLOW_STATUS.DRAFT);
  assert.ok(draft.categoryId);
  assert.ok(draft.slug);
  assert.equal(draft.fundingTargetPoisha, 500000 * 100);

  await assert.rejects(
    () => service.submitOwnerProject(draft.id, ids.otherOwner),
    /own projects|FORBIDDEN/i,
  );

  await service.updateOwnerProject(
    draft.id,
    { ...completeTerms, summary: 'Ready for review with commercial terms' },
    ids.owner,
  );

  const submitted = await service.submitOwnerProject(draft.id, ids.owner);
  assert.equal(submitted.status, PROJECT_WORKFLOW_STATUS.SUBMITTED_FOR_REVIEW);

  await assert.rejects(
    () => service.publishProject(draft.id, ids.admin, completeTerms),
    /transition|publishable/i,
  );

  const changes = await service.requestProjectChanges(draft.id, ids.admin, 'Please clarify exit liquidity rules.');
  assert.equal(changes.status, PROJECT_WORKFLOW_STATUS.CHANGES_REQUESTED);
  assert.match(changes.changeRequestReason, /liquidity/);

  await service.updateOwnerProject(draft.id, { exitPolicy: completeTerms.exitPolicy + ' Updated.' }, ids.owner);
  const resubmitted = await service.resubmitOwnerProject(draft.id, ids.owner);
  assert.equal(resubmitted.status, PROJECT_WORKFLOW_STATUS.RESUBMITTED);

  const approved = await service.approveProject(draft.id, ids.admin);
  assert.equal(approved.status, PROJECT_WORKFLOW_STATUS.APPROVED);
  assert.ok(approved.approvedAt);

  const published = await service.publishProject(draft.id, ids.admin, completeTerms);
  assert.equal(published.status, PROJECT_WORKFLOW_STATUS.PUBLISHED);
  assert.ok(published.publishedTermsVersion >= 1);

  const publicList = await service.listPublishedProjects();
  assert.ok(publicList.some((p) => p.id === draft.id));
  const bySlug = await service.getPublishedProjectBySlug(published.slug);
  assert.equal(bySlug.id, draft.id);
  assert.equal(bySlug.withdrawable, false);
  assert.match(bySlug.projectedReturnDisclaimer, /not guaranteed/i);

  const paused = await service.pauseProject(draft.id, ids.admin, 'Soft pause');
  assert.equal(paused.status, PROJECT_WORKFLOW_STATUS.PAUSED);
  const closed = await service.closeFunding(draft.id, ids.admin, 'Cap reached');
  assert.equal(closed.status, PROJECT_WORKFLOW_STATUS.FUNDING_CLOSED);

  const versions = await service.listProjectVersions(draft.id, { actorId: ids.owner, asAdmin: false });
  assert.ok(versions.versions.length >= 1);

  await assert.rejects(() => service.approveProject(draft.id, ids.owner), /transition/i);
});

test('project workflow HTTP authz + public published-only', async (t) => {
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

  const adminToken = await login(base, 'admin-wf@example.invalid');
  const ownerToken = await login(base, 'owner-wf@example.invalid');
  const investorToken = await login(base, 'investor-wf@example.invalid');

  const cats = await httpJson(base, 'GET', '/categories');
  assert.equal(cats.status, 200);
  const categoryId = cats.json.data[0].id;

  const created = await httpJson(base, 'POST', '/owner/projects', {
    token: ownerToken,
    body: {
      title: 'HTTP Workflow Project',
      categoryId,
      summary: 'HTTP draft',
      totalUnits: 40,
      unitInvestmentPoisha: 250000,
      administrationFeeBps: 1200,
      selectedRateBps: 1600,
      projectedReturnMinBps: 1400,
      projectedReturnMaxBps: 2000,
      durationDays: 120,
      ...completeTerms,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const projectId = created.json.data.id;

  const investorCreate = await httpJson(base, 'POST', '/owner/projects', {
    token: investorToken,
    body: { title: 'Nope Project Title', categoryId, summary: 'x', totalUnits: 1 },
  });
  assert.equal(investorCreate.status, 403);

  const unauthAdmin = await httpJson(base, 'GET', '/admin/projects');
  assert.equal(unauthAdmin.status, 401);

  const submit = await httpJson(base, 'POST', `/owner/projects/${projectId}/submit`, { token: ownerToken });
  assert.equal(submit.status, 200, JSON.stringify(submit.json));

  const ownerApprove = await httpJson(base, 'POST', `/admin/projects/${projectId}/approve`, { token: ownerToken });
  assert.equal(ownerApprove.status, 403);

  const reqChanges = await httpJson(base, 'POST', `/admin/projects/${projectId}/request-changes`, {
    token: adminToken,
    body: { reason: 'Need clearer risk disclosure wording.' },
  });
  assert.equal(reqChanges.status, 200);

  const resubmit = await httpJson(base, 'POST', `/owner/projects/${projectId}/resubmit`, { token: ownerToken });
  assert.equal(resubmit.status, 200);

  const approve = await httpJson(base, 'POST', `/admin/projects/${projectId}/approve`, { token: adminToken });
  assert.equal(approve.status, 200, JSON.stringify(approve.json));

  const beforePublish = await httpJson(base, 'GET', '/projects');
  assert.equal(beforePublish.status, 200);
  assert.ok(!beforePublish.json.data.some((p) => p.id === projectId));

  const publish = await httpJson(base, 'POST', `/admin/projects/${projectId}/publish`, {
    token: adminToken,
    body: completeTerms,
  });
  assert.equal(publish.status, 200, JSON.stringify(publish.json));
  const slug = publish.json.data.slug;

  const publicList = await httpJson(base, 'GET', '/projects');
  assert.ok(publicList.json.data.some((p) => p.id === projectId));
  const detail = await httpJson(base, 'GET', `/projects/${slug}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.withdrawable, false);

  const versions = await httpJson(base, 'GET', `/owner/projects/${projectId}/versions`, { token: ownerToken });
  assert.equal(versions.status, 200);
  assert.ok(versions.json.data.versions.length >= 1);

  const badTransition = await httpJson(base, 'POST', `/admin/projects/${projectId}/approve`, { token: adminToken });
  assert.equal(badTransition.status, 409);
});
