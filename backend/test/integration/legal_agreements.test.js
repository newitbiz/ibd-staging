import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresGrowBangladeshService } from '../../src/postgres_service.js';
import { AuthService } from '../../src/auth_service.js';
import { MemoryEmailAdapter } from '../../src/email/adapter.js';
import { createVerificationDelivery } from '../../src/verification_delivery.js';
import { DomainError } from '../../src/domain.js';

const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET || 'integration-test-jwt-secret-at-least-32-chars';
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
  process.env.STAGING_ACCESS_REQUIRED = 'false';
  process.env.LEGAL_PRODUCTION_BLOCK = 'true';
  delete process.env.STAGING_INVITE_CODE;
  const admin = new pg.Pool({ connectionString: baseUrl, max: 2 });
  attachPoolGuards(admin);
  const dbName = `grow_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  attachPoolGuards(pool);
  await applySchema(pool);
  return {
    pool,
    async cleanup() {
      try { await pool.end(); } catch {}
      try { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } catch {}
      try { await admin.end(); } catch {}
    },
  };
}

test('legal agreements matrix', async (t) => {
  const db = await createDisposableDb();
  if (!db) {
    t.skip('No DATABASE_URL');
    return;
  }
  const service = new PostgresGrowBangladeshService(db.pool);
  const emailAdapter = new MemoryEmailAdapter();
  service.emailAdapter = emailAdapter;
  const auth = new AuthService(db.pool, {
    emailAdapter,
    verificationDelivery: createVerificationDelivery({ emailAdapter }),
  });
  auth.growService = service;

  try {
    await service.ensureLegalDraftsSeeded();

    // Missing consent on register
    await assert.rejects(
      () =>
        auth.register({
          email: 'noconsent@example.invalid',
          mobile: '+8801711000001',
          password: 'TestPassword123!',
          fullName: 'No Consent',
          role: 'investor',
        }),
      (e) => e instanceof DomainError && e.code === 'MISSING_CONSENT',
    );

    const packet = await service.getSignupLegalPacket('investor');
    assert.equal(packet.documents.length, 2);
    const acceptances = packet.documents.map((d) => ({
      documentType: d.documentType,
      documentVersionId: d.id,
      versionNumber: d.versionNumber,
      viewedAt: new Date().toISOString(),
      viewed: true,
    }));

    // Wrong version
    await assert.rejects(
      async () => {
        const userId = randomUUID();
        await db.pool.query(
          `INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,'x','active',now())`,
          [userId, 'wrongver@example.invalid'],
        );
        await service.acceptSignupLegal(userId, {
          role: 'investor',
          acceptances: acceptances.map((a) => ({ ...a, versionNumber: 999 })),
        });
      },
      (e) => e instanceof DomainError && e.code === 'WRONG_VERSION',
    );

    const reg = await auth.register({
      email: 'ok@example.invalid',
      mobile: '+8801711000002',
      password: 'TestPassword123!',
      fullName: 'Ok Investor',
      role: 'investor',
      legalAcceptances: acceptances,
      marketingConsent: false,
      requestContext: { ip: '127.0.0.1', userAgent: 'test' },
    });
    assert.ok(reg.user.id);
    const listed = await service.listMyLegalAcceptances(reg.user.id);
    assert.ok(listed.items.length >= 2);

    // Duplicate acceptance
    await assert.rejects(
      () =>
        service.acceptSignupLegal(reg.user.id, {
          role: 'investor',
          acceptances,
          marketingConsent: false,
        }),
      (e) => e instanceof DomainError && e.code === 'DUPLICATE_ACCEPTANCE',
    );

    // Admin-created first login gate
    const adminId = randomUUID();
    const createdId = randomUUID();
    const { hashPassword } = await import('../../src/crypto_util.js');
    const hash = await hashPassword('TempPassword123!');
    await db.pool.query(
      `INSERT INTO users(id,email,password_hash,status,email_verified_at,created_by_admin,must_change_password,pending_legal_acceptance)
       VALUES ($1,'admin-legal@example.invalid',$2,'active',now(),true,false,false)`,
      [adminId, hash],
    );
    await db.pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,'super_admin')`, [adminId]);
    await db.pool.query(
      `INSERT INTO users(id,email,password_hash,status,email_verified_at,created_by_admin,must_change_password,pending_legal_acceptance)
       VALUES ($1,'admincreated@example.invalid',$2,'active',now(),true,true,true)`,
      [createdId, hash],
    );
    await db.pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,'investor')`, [createdId]);
    const gate = await service.getPendingLegalGate(createdId, ['investor']);
    assert.equal(gate.mustAccept, true);
    assert.equal(gate.adminCannotAcceptForUser, true);
    await service.completePendingLegalGate(
      createdId,
      {
        roles: ['investor'],
        acceptances: gate.documents.map((d) => ({
          documentType: d.documentType,
          versionNumber: d.published.versionNumber,
          viewedAt: new Date().toISOString(),
          viewed: true,
        })),
      },
      { ip: '127.0.0.1' },
    );
    const gate2 = await service.getPendingLegalGate(createdId, ['investor']);
    assert.equal(gate2.mustAccept, false);

    // Role switch owner agreement
    await db.pool.query(`UPDATE users SET pending_owner_agreement=true WHERE id=$1`, [reg.user.id]);
    await db.pool.query(
      `INSERT INTO user_roles(user_id,role_code) VALUES ($1,'project_owner') ON CONFLICT DO NOTHING`,
      [reg.user.id],
    );
    const ownerGate = await service.getPendingLegalGate(reg.user.id, ['investor', 'project_owner']);
    assert.ok(ownerGate.documents.some((d) => d.documentType === 'project_owner_agreement'));

    // Historical retrieval immutable
    const hist = await service.getLegalAcceptance(listed.items[0].id, reg.user.id, false);
    assert.ok(hist.snapshotMarkdown.includes('Temporary draft'));
    assert.match(hist.evidenceDisclaimer, /not a certified/i);

    // Production gate
    const prod = await service.getLegalProductionGate();
    assert.equal(prod.allApproved, false);
    assert.equal(prod.legalProductionBlock, true);

    // Publish archives previous; acceptances retained
    const adminDocs = await service.listLegalDocumentsAdmin();
    const investorDoc = adminDocs.items.find((d) => d.documentType === 'investor_agreement');
    const draft = await service.createLegalDocumentDraft('investor_agreement', adminId, {
      contentMarkdown: `${investorDoc.publishedVersion.contentMarkdown}\n\n## Amendment note\nTemporary draft—legal review pending`,
      changeSummary: 'Staging amendment',
      title: 'Investor Agreement v2 draft',
    });
    const published = await service.publishLegalDocumentVersion(draft.id, adminId, {
      changeSummary: 'Publish v2 for future acceptances only',
    });
    assert.equal(published.status, 'published');
    const still = await service.getLegalAcceptance(listed.items[0].id, reg.user.id, false);
    assert.ok(still.versionNumber >= 1);

    // Email failure / retry path for project agreement resend without instance -> NOT_FOUND
    await assert.rejects(
      () => service.resendProjectInvestmentAgreementEmail(randomUUID(), adminId),
      (e) => e instanceof DomainError && e.code === 'NOT_FOUND',
    );
  } finally {
    await db.cleanup();
  }
});
