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

async function seedActors(pool) {
  const ids = {
    admin: randomUUID(),
    financeA: randomUUID(),
    financeB: randomUUID(),
    owner: randomUUID(),
    investor: randomUUID(),
    business: randomUUID(),
  };
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id,email,password_hash,status) VALUES
       ($1,'admin@ex.invalid','x','active'),
       ($2,'fa@ex.invalid','x','active'),
       ($3,'fb@ex.invalid','x','active'),
       ($4,'o@ex.invalid','x','active'),
       ($5,'i@ex.invalid','x','active')`,
      [ids.admin, ids.financeA, ids.financeB, ids.owner, ids.investor],
    );
    await client.query(
      `INSERT INTO user_roles(user_id,role_code) VALUES
       ($1,'super_admin'),($2,'finance_officer'),($3,'finance_officer'),
       ($4,'project_owner'),($5,'investor')`,
      [ids.admin, ids.financeA, ids.financeB, ids.owner, ids.investor],
    );
    await client.query(
      `INSERT INTO businesses(id,owner_user_id,legal_name,verification_status)
       VALUES ($1,$2,'Maker Biz','verified')`,
      [ids.business, ids.owner],
    );
  });
  return ids;
}

async function approvedApplication(service, ids, { units = 1, totalUnits = 10 } = {}) {
  const project = await service.createProject(
    {
      businessId: ids.business,
      title: 'Maker Project',
      category: 'manufacturing',
      summary: 'manual payments',
      totalUnits,
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
    ids.owner,
  );
  await service.submitOwnerProject(project.id, ids.owner);
  await service.approveProject(project.id, ids.admin);
  const published = await service.publishProject(project.id, ids.admin, {
    versionNote: 'v1',
    riskDisclosure: 'Capital at risk. Not guaranteed.',
    termsText: 'Unit terms and fee schedule apply.',
    exitPolicy: 'Exit after minimum hold; liquidity review. Not withdrawable.',
  });
  const application = await service.applyForUnits(
    {
      projectId: project.id,
      investorId: ids.investor,
      units,
      acceptedTermsVersion: published.publishedTermsVersion,
    },
    ids.investor,
  );
  await service.approveApplication(application.id, ids.admin);
  return { project, application, amountPoisha: application.totalPayablePoisha };
}

test('maker-checker blocks same staff from submit and verify', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const ids = await seedActors(ctx.pool);
  const service = new PostgresGrowBangladeshService(ctx.pool);
  const { application, amountPoisha } = await approvedApplication(service, ids);

  const payment = await service.submitPayment(
    {
      applicationId: application.id,
      method: 'bank_transfer',
      reference: `BANK-${randomUUID().slice(0, 8)}`,
      amountPoisha,
      paidOn: '2026-09-01',
      evidenceStorageKey: 'evidence/bank-1.pdf',
      idempotencyKey: `idem-${randomUUID()}`,
      requestContext: { ip: '203.0.113.10', userAgent: 'staff-a' },
    },
    ids.financeA,
  );

  await assert.rejects(
    () =>
      service.verifyPayment(payment.id, ids.financeA, 'Looks good', {
        actorRoles: ['finance_officer'],
        requestContext: { ip: '203.0.113.10', userAgent: 'staff-a' },
      }),
    (error) => error.code === 'MAKER_CHECKER_VIOLATION' && error.httpStatus === 403,
  );

  const verified = await service.verifyPayment(payment.id, ids.financeB, 'Matched ledger', {
    actorRoles: ['finance_officer'],
    requestContext: { ip: '203.0.113.20', userAgent: 'staff-b' },
  });
  assert.equal(verified.alreadyVerified, false);
  assert.equal(verified.payment.status, 'verified');
});

test('super admin may override maker-checker with mandatory reason and audit', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const ids = await seedActors(ctx.pool);
  const service = new PostgresGrowBangladeshService(ctx.pool);
  const { application, amountPoisha } = await approvedApplication(service, ids);

  const payment = await service.submitPayment(
    {
      applicationId: application.id,
      method: 'cash',
      amountPoisha,
      paidOn: '2026-09-02',
      branch: 'Dhanmondi',
      idempotencyKey: `idem-${randomUUID()}`,
      requestContext: { ip: '198.51.100.1', userAgent: 'admin' },
    },
    ids.admin,
  );

  await assert.rejects(
    () =>
      service.verifyPayment(payment.id, ids.admin, 'self verify', {
        actorRoles: ['super_admin'],
        overrideMakerChecker: true,
        overrideReason: '',
      }),
    (error) => error.code === 'MAKER_CHECKER_VIOLATION',
  );

  const verified = await service.verifyPayment(payment.id, ids.admin, 'Emergency activation', {
    actorRoles: ['super_admin'],
    overrideMakerChecker: true,
    overrideReason: 'Only on-call admin available',
    requestContext: { ip: '198.51.100.1', userAgent: 'admin' },
  });
  assert.equal(verified.payment.status, 'verified');

  const override = await ctx.pool.query(
    `SELECT action, reason FROM audit_logs WHERE subject_id=$1 AND action='maker_checker.override'`,
    [payment.id],
  );
  assert.equal(override.rowCount, 1);
  assert.match(override.rows[0].reason, /on-call/i);
});

test('cash payments issue sequential receipt numbers', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const ids = await seedActors(ctx.pool);
  const service = new PostgresGrowBangladeshService(ctx.pool);

  const first = await approvedApplication(service, ids, { units: 1, totalUnits: 5 });
  const pay1 = await service.submitPayment(
    {
      applicationId: first.application.id,
      method: 'cash',
      amountPoisha: first.amountPoisha,
      paidOn: '2026-09-03',
      idempotencyKey: `idem-${randomUUID()}`,
    },
    ids.financeA,
  );

  const investor2 = randomUUID();
  await ctx.pool.query(`INSERT INTO users(id,email,password_hash,status) VALUES ($1,'i2@ex.invalid','x','active')`, [
    investor2,
  ]);
  await ctx.pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,'investor')`, [investor2]);
  const projectId = first.project.id;
  const app2 = await service.applyForUnits(
    { projectId, investorId: investor2, units: 1, acceptedTermsVersion: 1 },
    investor2,
  );
  await service.approveApplication(app2.id, ids.admin);
  const pay2 = await service.submitPayment(
    {
      applicationId: app2.id,
      method: 'cash',
      amountPoisha: app2.totalPayablePoisha,
      paidOn: '2026-09-03',
      idempotencyKey: `idem-${randomUUID()}`,
    },
    ids.financeB,
  );

  assert.equal(typeof pay1.receiptNumber, 'number');
  assert.equal(typeof pay2.receiptNumber, 'number');
  assert.equal(pay2.receiptNumber, pay1.receiptNumber + 1);
  assert.equal(pay1.reference, `CASH-${pay1.receiptNumber}`);
  assert.equal(pay2.reference, `CASH-${pay2.receiptNumber}`);
});

test('bank and bkash require evidenceStorageKey', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const ids = await seedActors(ctx.pool);
  const service = new PostgresGrowBangladeshService(ctx.pool);
  const { application, amountPoisha } = await approvedApplication(service, ids);

  await assert.rejects(
    () =>
      service.submitPayment(
        {
          applicationId: application.id,
          method: 'bank_transfer',
          reference: `BANK-${randomUUID().slice(0, 8)}`,
          amountPoisha,
          paidOn: '2026-09-04',
          idempotencyKey: `idem-${randomUUID()}`,
        },
        ids.investor,
      ),
    (error) => error.code === 'EVIDENCE_REQUIRED',
  );

  await assert.rejects(
    () =>
      service.submitPayment(
        {
          applicationId: application.id,
          method: 'bkash',
          reference: `BK-${randomUUID().slice(0, 8)}`,
          amountPoisha,
          paidOn: '2026-09-04',
          idempotencyKey: `idem-${randomUUID()}`,
        },
        ids.investor,
      ),
    (error) => error.code === 'EVIDENCE_REQUIRED',
  );

  const ok = await service.submitPayment(
    {
      applicationId: application.id,
      method: 'bkash',
      reference: `BK-${randomUUID().slice(0, 8)}`,
      amountPoisha,
      paidOn: '2026-09-04',
      evidenceStorageKey: 'evidence/bkash-1.png',
      idempotencyKey: `idem-${randomUUID()}`,
    },
    ids.investor,
  );
  assert.equal(ok.status, 'verification_pending');
});

test('duplicate verify returns same allocation (alreadyVerified)', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const ids = await seedActors(ctx.pool);
  const service = new PostgresGrowBangladeshService(ctx.pool);
  const { application, amountPoisha } = await approvedApplication(service, ids);
  const payment = await service.submitPayment(
    {
      applicationId: application.id,
      method: 'bank_transfer',
      reference: `BANK-${randomUUID().slice(0, 8)}`,
      amountPoisha,
      paidOn: '2026-09-05',
      evidenceStorageKey: 'evidence/dup.pdf',
      idempotencyKey: `idem-${randomUUID()}`,
    },
    ids.financeA,
  );
  const first = await service.verifyPayment(payment.id, ids.financeB, 'ok first', {
    actorRoles: ['finance_officer'],
  });
  const second = await service.verifyPayment(payment.id, ids.financeB, 'ok again', {
    actorRoles: ['finance_officer'],
  });
  assert.equal(second.alreadyVerified, true);
  assert.equal(second.allocation.id, first.allocation.id);
  const count = await ctx.pool.query('SELECT count(*)::int AS c FROM allocations WHERE payment_id=$1', [payment.id]);
  assert.equal(count.rows[0].c, 1);
});

test('payment amount mismatch is rejected', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const ids = await seedActors(ctx.pool);
  const service = new PostgresGrowBangladeshService(ctx.pool);
  const { application } = await approvedApplication(service, ids);
  await assert.rejects(
    () =>
      service.submitPayment(
        {
          applicationId: application.id,
          method: 'cash',
          amountPoisha: 1,
          paidOn: '2026-09-06',
          idempotencyKey: `idem-${randomUUID()}`,
        },
        ids.investor,
      ),
    (error) => error.code === 'PAYMENT_AMOUNT_MISMATCH',
  );
});

test('oversubscription remains locked at approval under concurrency', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const ids = await seedActors(ctx.pool);
  const investorB = randomUUID();
  await ctx.pool.query(`INSERT INTO users(id,email,password_hash,status) VALUES ($1,'ib@ex.invalid','x','active')`, [
    investorB,
  ]);
  await ctx.pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,'investor')`, [investorB]);

  const service = new PostgresGrowBangladeshService(ctx.pool);
  const project = await service.createProject(
    {
      businessId: ids.business,
      title: 'Tiny Inventory',
      category: 'manufacturing',
      summary: '2 units',
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
    ids.owner,
  );
  await service.submitOwnerProject(project.id, ids.owner);
  await service.approveProject(project.id, ids.admin);
  await service.publishProject(project.id, ids.admin, {
    versionNote: 'v1',
    riskDisclosure: 'Capital at risk. Not guaranteed.',
    termsText: 'Unit terms and fee schedule apply.',
    exitPolicy: 'Exit after minimum hold; liquidity review. Not withdrawable.',
  });
  const appA = await service.applyForUnits(
    { projectId: project.id, investorId: ids.investor, units: 2, acceptedTermsVersion: 1 },
    ids.investor,
  );
  const appB = await service.applyForUnits(
    { projectId: project.id, investorId: investorB, units: 2, acceptedTermsVersion: 1 },
    investorB,
  );
  const settled = await Promise.allSettled([
    service.approveApplication(appA.id, ids.admin),
    service.approveApplication(appB.id, ids.admin),
  ]);
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((s) => s.status === 'rejected').length, 1);
  assert.equal(settled.find((s) => s.status === 'rejected').reason.code, 'INSUFFICIENT_UNITS');
});

test('verify allocates in one TX; duplicate returns alreadyVerified + allocationId; list investments scoped', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const ids = await seedActors(ctx.pool);
  const service = new PostgresGrowBangladeshService(ctx.pool);
  const { project, application, amountPoisha } = await approvedApplication(service, ids, { units: 3, totalUnits: 20 });
  assert.equal(amountPoisha, 2_932_500);
  assert.equal(application.investmentPoisha, 2_550_000);
  assert.equal(application.administrationFeePoisha, 382_500);

  const payment = await service.submitPayment(
    {
      applicationId: application.id,
      method: 'bank_transfer',
      reference: `BANK-${randomUUID().slice(0, 8)}`,
      amountPoisha,
      paidOn: '2026-09-07',
      evidenceStorageKey: 'evidence/alloc-1.pdf',
      idempotencyKey: `idem-${randomUUID()}`,
      requestContext: { ip: '203.0.113.40', userAgent: 'investor' },
    },
    ids.investor,
  );

  const verified = await service.verifyPayment(payment.id, ids.financeB, 'Matched ledger for 3 units', {
    actorRoles: ['finance_officer'],
    requestContext: { ip: '203.0.113.41', userAgent: 'finance-b' },
  });
  assert.equal(verified.alreadyVerified, false);
  assert.equal(verified.allocation.units, 3);
  assert.equal(verified.allocation.investmentPoisha, 2_550_000);
  assert.equal(verified.allocation.investorId, ids.investor);
  assert.equal(verified.allocationId, verified.allocation.id);
  assert.equal(verified.payment.status, 'verified');

  const ownerProjects = await service.listOwnerProjects(ids.owner);
  const funded = ownerProjects.find((p) => p.id === project.id);
  assert.equal(funded.activeUnits, 3);

  const mine = await service.listInvestments({ actorId: ids.investor, canViewAny: false });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, verified.allocation.id);
  assert.equal(mine[0].units, 3);
  assert.equal(mine[0].estimateLabel, 'Projected return — not guaranteed');
  assert.equal(mine[0].withdrawable, false);
  assert.equal(mine[0].administrationFeePoisha, 382_500);
  assert.equal(mine[0].totalPaidPoisha, 2_932_500);

  const other = await service.listInvestments({ actorId: ids.owner, canViewAny: false });
  assert.equal(other.length, 0);

  await assert.rejects(
    () => service.getInvestment(verified.allocation.id, ids.owner),
    (error) => error.code === 'FORBIDDEN' && error.httpStatus === 403,
  );

  const dup = await service.verifyPayment(payment.id, ids.financeB, 'second verify', {
    actorRoles: ['finance_officer'],
  });
  assert.equal(dup.alreadyVerified, true);
  assert.equal(dup.allocationId, verified.allocation.id);
  const allocCount = await ctx.pool.query('SELECT count(*)::int AS c FROM allocations WHERE payment_id=$1', [payment.id]);
  assert.equal(allocCount.rows[0].c, 1);

  const pending = await service.listAdminPayments({ status: 'verification_pending' });
  assert.equal(pending.find((row) => row.id === payment.id), undefined);
  const verifiedQueue = await service.listAdminPayments({ status: 'verified' });
  assert.ok(verifiedQueue.some((row) => row.id === payment.id && row.allocationId === verified.allocation.id));

  const audits = await ctx.pool.query(
    `SELECT action FROM audit_logs WHERE subject_id=$1 OR subject_id=$2 ORDER BY occurred_at`,
    [payment.id, verified.allocation.id],
  );
  const actions = audits.rows.map((r) => r.action);
  assert.ok(actions.includes('payment.verified'));
  assert.ok(actions.includes('allocation.activated'));
});

test('reject payment releases reservation and never allocates', async (t) => {
  const ctx = await createDisposableDb();
  if (!ctx) {
    t.skip('TEST_DATABASE_URL or DATABASE_URL not set');
    return;
  }
  t.after(ctx.cleanup);
  const ids = await seedActors(ctx.pool);
  const service = new PostgresGrowBangladeshService(ctx.pool);
  const { project, application, amountPoisha } = await approvedApplication(service, ids, { units: 2, totalUnits: 10 });
  const before = await ctx.pool.query('SELECT reserved_units, active_units FROM projects WHERE id=$1', [project.id]);
  assert.equal(before.rows[0].reserved_units, 2);

  const payment = await service.submitPayment(
    {
      applicationId: application.id,
      method: 'bank_transfer',
      reference: `BANK-REJ-${randomUUID().slice(0, 8)}`,
      amountPoisha,
      paidOn: '2026-09-07',
      evidenceStorageKey: 'evidence/rej.pdf',
      idempotencyKey: `idem-${randomUUID()}`,
    },
    ids.investor,
  );

  const rejected = await service.rejectPayment(payment.id, ids.financeB, 'Reference not found in bank feed', {
    actorRoles: ['finance_officer'],
    requestContext: { ip: '203.0.113.50', userAgent: 'finance-b' },
  });
  assert.equal(rejected.payment.status, 'rejected');
  const after = await ctx.pool.query('SELECT reserved_units, active_units FROM projects WHERE id=$1', [project.id]);
  assert.equal(after.rows[0].reserved_units, 0);
  assert.equal(after.rows[0].active_units, 0);
  const allocs = await ctx.pool.query('SELECT count(*)::int AS c FROM allocations WHERE payment_id=$1', [payment.id]);
  assert.equal(allocs.rows[0].c, 0);
});
