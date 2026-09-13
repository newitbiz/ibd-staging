import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresGrowBangladeshService } from '../../src/postgres_service.js';
import { withTransaction } from '../../src/db.js';

const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
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
  if (!baseUrl) return null;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 2 });
  const dbName = `grow_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
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

test('concurrent approveApplication cannot oversubscribe a 2-unit project', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  const { pool, cleanup } = ctx;
  t.after(cleanup);

  const adminId = randomUUID();
  const ownerId = randomUUID();
  const investorA = randomUUID();
  const investorB = randomUUID();
  const businessId = randomUUID();

  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id,email,password_hash,status) VALUES
       ($1,'a@ex.invalid','x','active'),
       ($2,'o@ex.invalid','x','active'),
       ($3,'ia@ex.invalid','x','active'),
       ($4,'ib@ex.invalid','x','active')`,
      [adminId, ownerId, investorA, investorB],
    );
    await client.query(
      `INSERT INTO user_roles(user_id,role_code) VALUES
       ($1,'super_admin'),($2,'project_owner'),($3,'investor'),($4,'investor')`,
      [adminId, ownerId, investorA, investorB],
    );
    await client.query(
      `INSERT INTO businesses(id,owner_user_id,legal_name,verification_status)
       VALUES ($1,$2,'Race Biz','verified')`,
      [businessId, ownerId],
    );
  });

  const service = new PostgresGrowBangladeshService(pool);
  const project = await service.createProject(
    {
      businessId,
      title: 'Race Project',
      category: 'manufacturing',
      summary: 'tiny inventory',
      totalUnits: 2,
      unitInvestmentPoisha: 850_000,
      administrationFeeBps: 1500,
      targetProfitBps: 2000,
      selectedRateBps: 2000,
      projectedReturnMinBps: 1500,
      projectedReturnMaxBps: 2500,
      durationDays: 365,
      riskDisclosure: 'Capital at risk. Not guaranteed.',
      termsText: 'Unit terms and fee schedule apply.',
      exitPolicy: 'Exit after minimum hold; liquidity review. Not withdrawable.',
    },
    ownerId,
  );
  await service.submitOwnerProject(project.id, ownerId);
  await service.approveProject(project.id, adminId);
  const published = await service.publishProject(project.id, adminId, {
    versionNote: 'v1',
    riskDisclosure: 'Capital at risk. Not guaranteed.',
    termsText: 'Unit terms and fee schedule apply.',
    exitPolicy: 'Exit after minimum hold; liquidity review. Not withdrawable.',
  });
  const appA = await service.applyForUnits(
    { projectId: project.id, investorId: investorA, units: 2, acceptedTermsVersion: published.publishedTermsVersion },
    investorA,
  );
  const appB = await service.applyForUnits(
    { projectId: project.id, investorId: investorB, units: 2, acceptedTermsVersion: published.publishedTermsVersion },
    investorB,
  );

  const settled = await Promise.allSettled([
    service.approveApplication(appA.id, adminId),
    service.approveApplication(appB.id, adminId),
  ]);

  const fulfilled = settled.filter((s) => s.status === 'fulfilled');
  const rejected = settled.filter((s) => s.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'INSUFFICIENT_UNITS');

  const row = (
    await pool.query('SELECT total_units, reserved_units, active_units FROM projects WHERE id=$1', [
      project.id,
    ])
  ).rows[0];
  assert.ok(row.reserved_units + row.active_units <= row.total_units);
  assert.equal(row.reserved_units, 2);
  assert.equal(row.active_units, 0);
});
