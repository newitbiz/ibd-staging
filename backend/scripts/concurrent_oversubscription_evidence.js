#!/usr/bin/env node
/**
 * Genuine concurrent oversubscription evidence.
 * Creates a disposable DB (or uses CONCURRENT_USE_LIVE=1 against DATABASE_URL with temp rows),
 * publishes a 2-unit project, creates two submitted applications for 2 units each,
 * fires Promise.all of two approveApplication calls, asserts exactly one succeeds and the
 * other fails with INSUFFICIENT_UNITS, and reserved+active never exceeds total.
 *
 * Usage:
 *   node --env-file=.env scripts/concurrent_oversubscription_evidence.js
 * Optional:
 *   EVIDENCE_OUT=/path/to/partial.json  — write JSON result
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresGrowBangladeshService } from '../src/postgres_service.js';
import { withTransaction } from '../src/db.js';
import { loadEnvFile } from '../src/load_env.js';

loadEnvFile();

const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const directory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(directory, '..', 'database', 'schema.sql');
const migrationsDir = path.join(directory, '..', 'database', 'migrations');

function fail(message, detail) {
  console.error('FAIL:', message, detail || '');
  process.exitCode = 1;
  return { ok: false, message, detail };
}

async function createDisposableDb() {
  if (!baseUrl) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');
  const admin = new pg.Pool({ connectionString: baseUrl, max: 2 });
  const dbName = `grow_conc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  await pool.query(await readFile(schemaPath, 'utf8'));
  for (const file of (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql')).sort()) {
    await pool.query(await readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return {
    pool,
    dbName,
    async cleanup() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
}

async function seedActors(pool) {
  const adminId = randomUUID();
  const ownerId = randomUUID();
  const investorA = randomUUID();
  const investorB = randomUUID();
  const businessId = randomUUID();
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id,email,password_hash,status) VALUES
       ($1,'conc-admin@example.invalid','x','active'),
       ($2,'conc-owner@example.invalid','x','active'),
       ($3,'conc-inv-a@example.invalid','x','active'),
       ($4,'conc-inv-b@example.invalid','x','active')`,
      [adminId, ownerId, investorA, investorB],
    );
    await client.query(
      `INSERT INTO user_roles(user_id,role_code) VALUES
       ($1,'super_admin'),($2,'project_owner'),($3,'investor'),($4,'investor')`,
      [adminId, ownerId, investorA, investorB],
    );
    await client.query(
      `INSERT INTO businesses(id,owner_user_id,legal_name,verification_status)
       VALUES ($1,$2,'Concurrent Evidence Biz','verified')`,
      [businessId, ownerId],
    );
  });
  return { adminId, ownerId, investorA, investorB, businessId };
}

async function main() {
  const startedAt = new Date().toISOString();
  const ctx = await createDisposableDb();
  const { pool, cleanup, dbName } = ctx;
  let result;
  try {
    const actors = await seedActors(pool);
    const service = new PostgresGrowBangladeshService(pool);
    const project = await service.createProject(
      {
        businessId: actors.businessId,
        title: 'Concurrent Oversubscription Probe',
        category: 'manufacturing',
        summary: '2-unit project for concurrent approve race',
        totalUnits: 2,
        unitInvestmentPoisha: 850_000,
        administrationFeeBps: 1500,
        targetProfitBps: 2000,
        durationDays: 365,
      },
      actors.ownerId,
    );
    await service.publishProject(project.id, actors.adminId, { versionNote: 'concurrent-evidence-v1' });

    const appA = await service.applyForUnits(
      {
        projectId: project.id,
        investorId: actors.investorA,
        units: 2,
        acceptedTermsVersion: 1,
      },
      actors.investorA,
    );
    const appB = await service.applyForUnits(
      {
        projectId: project.id,
        investorId: actors.investorB,
        units: 2,
        acceptedTermsVersion: 1,
      },
      actors.investorB,
    );

    const before = await pool.query(
      'SELECT total_units, reserved_units, active_units FROM projects WHERE id=$1',
      [project.id],
    );

    const settled = await Promise.allSettled([
      service.approveApplication(appA.id, actors.adminId),
      service.approveApplication(appB.id, actors.adminId),
    ]);

    const outcomes = settled.map((entry, index) => {
      const applicationId = index === 0 ? appA.id : appB.id;
      if (entry.status === 'fulfilled') {
        return {
          applicationId,
          status: 'fulfilled',
          applicationStatus: entry.value.status,
          units: entry.value.units,
        };
      }
      const err = entry.reason;
      return {
        applicationId,
        status: 'rejected',
        code: err?.code || 'UNKNOWN',
        message: err?.message || String(err),
        httpStatus: err?.httpStatus,
      };
    });

    const after = await pool.query(
      'SELECT total_units, reserved_units, active_units FROM projects WHERE id=$1',
      [project.id],
    );
    const row = after.rows[0];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    const insufficient = rejected.filter((o) => o.code === 'INSUFFICIENT_UNITS');
    const inventoryOk = row.reserved_units + row.active_units <= row.total_units;
    const exactlyOneSuccess = fulfilled.length === 1 && insufficient.length === 1;

    result = {
      scenario: 'concurrent_oversubscription_approve',
      ok: exactlyOneSuccess && inventoryOk && row.reserved_units === 2 && row.active_units === 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      disposableDatabase: dbName,
      project: {
        id: project.id,
        totalUnits: row.total_units,
        before: before.rows[0],
        after: {
          total_units: row.total_units,
          reserved_units: row.reserved_units,
          active_units: row.active_units,
          reservedPlusActive: row.reserved_units + row.active_units,
        },
      },
      applications: [
        { id: appA.id, investorId: actors.investorA, units: 2, statusAtSubmit: appA.status },
        { id: appB.id, investorId: actors.investorB, units: 2, statusAtSubmit: appB.status },
      ],
      promiseAllOutcomes: outcomes,
      assertions: {
        exactlyOneApproveSucceeded: exactlyOneSuccess,
        loserCodeIsInsufficientUnits: insufficient.length === 1,
        reservedPlusActiveNeverExceedsTotal: inventoryOk,
        reservedEqualsTwoAfterRace: row.reserved_units === 2,
        activeStillZero: row.active_units === 0,
      },
    };

    if (!result.ok) {
      console.error(JSON.stringify(result, null, 2));
      fail('Concurrent oversubscription assertions failed', result.assertions);
    } else {
      console.log(JSON.stringify(result, null, 2));
      console.log('PASS: exactly one approve succeeded; loser INSUFFICIENT_UNITS; inventory ok');
    }
  } catch (error) {
    result = fail(error.message, { stack: error.stack });
    result = {
      scenario: 'concurrent_oversubscription_approve',
      ok: false,
      error: { message: error.message, code: error.code },
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    const out = process.env.EVIDENCE_OUT;
    if (out && result) {
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify(result, null, 2));
    }
    await cleanup();
  }
}

await main();
