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
import { AuthService } from '../../src/auth_service.js';
import { MemoryEmailAdapter } from '../../src/email/adapter.js';
import { createVerificationDelivery } from '../../src/verification_delivery.js';
import { withTransaction } from '../../src/db.js';

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

function attachPoolGuards(pool) {
  pool.on('error', () => {});
}

async function createDisposableDb() {
  if (!baseUrl) return null;
  process.env.JWT_SECRET = jwtSecret;
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_OTP_PREVIEW = 'true';
  process.env.OTP_PREVIEW_ALLOWLIST = '@example.invalid';
  process.env.STAGING_ACCESS_REQUIRED = 'false';
  process.env.ALLOW_DEV_USER_HEADER = 'false';
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
    connectionString: url.toString(),
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

async function seedActors(pool) {
  const ids = {
    admin: randomUUID(),
    owner: randomUUID(),
    investor: randomUUID(),
    reviewer: randomUUID(),
  };
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES
       ($1,'admin-cat@example.invalid','x','active',now()),
       ($2,'owner-cat@example.invalid','x','active',now()),
       ($3,'inv-cat@example.invalid','x','active',now()),
       ($4,'rev-cat@example.invalid','x','active',now())`,
      [ids.admin, ids.owner, ids.investor, ids.reviewer],
    );
    await client.query(
      `INSERT INTO user_roles(user_id,role_code) VALUES
       ($1,'super_admin'),($2,'project_owner'),($3,'investor'),($4,'project_reviewer')`,
      [ids.admin, ids.owner, ids.investor, ids.reviewer],
    );
  });
  return ids;
}

async function countAudits(pool, action) {
  const result = await pool.query('SELECT count(*)::int AS c FROM audit_logs WHERE action=$1', [action]);
  return result.rows[0].c;
}

test('categories service: create list update deactivate reorder + audits', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  const { pool, cleanup } = ctx;
  t.after(cleanup);
  const ids = await seedActors(pool);
  const service = new PostgresGrowBangladeshService(pool);

  const seeded = await service.listActiveCategories();
  assert.ok(seeded.length >= 5);

  const created = await service.createCategory(
    { name: 'Logistics', description: 'Warehousing and transport', iconUrl: null },
    ids.admin,
  );
  assert.equal(created.slug, 'logistics');
  assert.equal(created.isActive, true);
  assert.equal(await countAudits(pool, 'category.created'), 1);

  const updated = await service.updateCategory(
    created.id,
    { name: 'Logistics & Freight', description: 'Updated', displayOrder: 15 },
    ids.admin,
  );
  assert.equal(updated.name, 'Logistics & Freight');
  assert.equal(updated.displayOrder, 15);
  assert.equal(await countAudits(pool, 'category.updated'), 1);

  const deactivated = await service.setCategoryActive(created.id, false, ids.admin, {
    reason: 'seasonal pause',
  });
  assert.equal(deactivated.isActive, false);
  assert.equal(await countAudits(pool, 'category.deactivated'), 1);

  const active = await service.listActiveCategories();
  assert.equal(active.some((c) => c.id === created.id), false);

  const all = await service.listAdminCategories({ includeInactive: true });
  assert.equal(all.some((c) => c.id === created.id && c.isActive === false), true);

  await service.setCategoryActive(created.id, true, ids.admin);
  assert.equal(await countAudits(pool, 'category.activated'), 1);

  const beforeReorder = await service.listAdminCategories();
  const reversed = beforeReorder.map((c) => c.id).reverse();
  const reordered = await service.reorderCategories(reversed, ids.admin);
  assert.equal(reordered[0].id, reversed[0]);
  assert.equal(reordered[0].displayOrder, 10);
  assert.equal(await countAudits(pool, 'category.reordered'), 1);

  await assert.rejects(
    () => service.createCategory({ name: 'Logistics & Freight' }, ids.admin),
    (error) => error.code === 'CATEGORY_CONFLICT',
  );
});

test('categories HTTP authz: 401 unauthenticated mutate, 403 investor mutate, public list', async (t) => {
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

  // Mint JWTs via AuthService crypto path used by server
  const adminToken = auth.issueAccessToken({ id: ids.admin }, ['super_admin']);
  const investorToken = auth.issueAccessToken({ id: ids.investor }, ['investor']);
  const ownerToken = auth.issueAccessToken({ id: ids.owner }, ['project_owner']);

  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: connectionString,
      DATABASE_SSL: 'false',
      JWT_SECRET: jwtSecret,
      NODE_ENV: 'test',
      ALLOW_DEV_USER_HEADER: 'false',
      STAGING_ACCESS_REQUIRED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGTERM');
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 15000);
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

  const publicList = await httpJson('GET', '/categories');
  assert.equal(publicList.status, 200);
  assert.ok(Array.isArray(publicList.json.data));
  assert.ok(publicList.json.data.length >= 5);

  const unauthCreate = await httpJson('POST', '/admin/categories', {
    body: { name: 'Should Fail' },
  });
  assert.equal(unauthCreate.status, 401);

  const investorCreate = await httpJson('POST', '/admin/categories', {
    token: investorToken,
    body: { name: 'Investor Cat' },
  });
  assert.equal(investorCreate.status, 403);

  const ownerCreate = await httpJson('POST', '/admin/categories', {
    token: ownerToken,
    body: { name: 'Owner Cat' },
  });
  assert.equal(ownerCreate.status, 403);

  const adminCreate = await httpJson('POST', '/admin/categories', {
    token: adminToken,
    body: { name: 'Staging Specialty', description: 'Admin created' },
  });
  assert.equal(adminCreate.status, 201);
  assert.equal(adminCreate.json.data.slug, 'staging-specialty');

  const adminList = await httpJson('GET', '/admin/categories', { token: adminToken });
  assert.equal(adminList.status, 200);

  const deactivate = await httpJson('POST', `/admin/categories/${adminCreate.json.data.id}/deactivate`, {
    token: adminToken,
    body: { reason: 'test' },
  });
  assert.equal(deactivate.status, 200);
  assert.equal(deactivate.json.data.isActive, false);

  const update = await httpJson('POST', `/admin/categories/${adminCreate.json.data.id}`, {
    token: adminToken,
    body: { description: 'updated via http' },
  });
  assert.equal(update.status, 200);
  assert.equal(update.json.data.description, 'updated via http');

  const activate = await httpJson('POST', `/admin/categories/${adminCreate.json.data.id}/activate`, {
    token: adminToken,
    body: {},
  });
  assert.equal(activate.status, 200);
  assert.equal(activate.json.data.isActive, true);

  const freshList = await httpJson('GET', '/admin/categories', { token: adminToken });
  assert.equal(freshList.status, 200);
  const allIds = freshList.json.data.map((c) => c.id).reverse();
  const reorder = await httpJson('POST', '/admin/categories/reorder', {
    token: adminToken,
    body: { orderedIds: allIds },
  });
  assert.equal(reorder.status, 200);
  assert.equal(reorder.json.data[0].id, allIds[0]);

  const investorAdminList = await httpJson('GET', '/admin/categories', { token: investorToken });
  assert.equal(investorAdminList.status, 403);
});
