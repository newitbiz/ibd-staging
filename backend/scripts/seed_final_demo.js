/**
 * Final Demo seed — one consistent fictional scenario for admin-test / owner-test / investor-test.
 * Never logs passwords. Marks all docs FICTIONAL DEMO — NOT A REAL DOCUMENT.
 */
import { loadEnvFile } from '../src/load_env.js';
import { closePool, createPool, withTransaction } from '../src/db.js';
import { hashPassword } from '../src/crypto_util.js';
import { encryptField, last4Digits } from '../src/field_encryption.js';
import { ROLES } from '../src/roles.js';
import {
  FICTIONAL_BANNER,
  STAGING_PHONE_OTP_LABEL,
  createDocumentStore,
  sha256Buffer,
  newStorageKey,
  buildFictionalPlaceholderPdf,
} from '../src/document_storage.js';
import { calculateDemoInvestment } from '../src/final_demo_service.js';
import { PostgresGrowBangladeshService } from '../src/postgres_service.js';

loadEnvFile();

const REQUIRED = ['TEST_ADMIN_PASSWORD', 'TEST_OWNER_PASSWORD', 'TEST_INVESTOR_PASSWORD'];
const missing = REQUIRED.filter((k) => !process.env[k] || String(process.env[k]).length < 12);
if (missing.length) {
  console.error(`Missing or too-short vars: ${missing.join(', ')}`);
  process.exit(1);
}
if (!process.env.FIELD_ENCRYPTION_KEY && !process.env.BANK_DATA_KEY) {
  console.error('FIELD_ENCRYPTION_KEY required for identity seed');
  process.exit(1);
}

const ids = {
  admin: '10000000-0000-4000-8000-000000000001',
  owner: '10000000-0000-4000-8000-000000000002',
  investor: '10000000-0000-4000-8000-000000000003',
  business: '10000000-0000-4000-8000-000000000010',
  projectPublished: '10000000-0000-4000-8000-000000000101',
  projectDraft: '10000000-0000-4000-8000-000000000102',
  projectChanges: '10000000-0000-4000-8000-000000000103',
  projectPaused: '10000000-0000-4000-8000-000000000104',
};

const calc = calculateDemoInvestment();
const store = createDocumentStore();
const pool = createPool();

async function upsertUser(client, { id, email, password, roles, displayName, kind }) {
  const passwordHash = await hashPassword(password);
  const existing = await client.query('SELECT id FROM users WHERE email=$1 OR id=$2', [email, id]);
  const userId = existing.rows[0]?.id || id;
  if (existing.rows[0]) {
    await client.query(
      `UPDATE users SET email=$2, password_hash=$3, status='active', account_lifecycle='active',
         must_change_password=true, staging_only=true, display_name=$4, email_verified_at=COALESCE(email_verified_at, now()),
         updated_at=now() WHERE id=$1`,
      [userId, email, passwordHash, displayName],
    );
  } else {
    await client.query(
      `INSERT INTO users(id, email, password_hash, status, account_lifecycle, must_change_password, staging_only, display_name, email_verified_at)
       VALUES ($1,$2,$3,'active','active',true,true,$4,now())`,
      [id, email, passwordHash, displayName],
    );
  }
  for (const role of roles) {
    await client.query(
      `INSERT INTO user_roles(user_id, role_code, granted_by) VALUES ($1,$2,$3) ON CONFLICT (user_id, role_code) DO NOTHING`,
      [userId, role, ids.admin],
    );
  }
  return userId;
}

async function putFictionalDoc(client, { ownerUserId, subjectType, subjectId, kind, title }) {
  const pdf = buildFictionalPlaceholderPdf({ title, bodyLines: [FICTIONAL_BANNER, 'Staging seed placeholder'] });
  const storageKey = newStorageKey({ ownerUserId, kind, ext: '.pdf' });
  await store.putObject({ storageKey, buffer: pdf });
  const inserted = await client.query(
    `INSERT INTO private_documents(
       owner_user_id, subject_type, subject_id, document_kind, original_filename, sanitized_filename,
       mime_type, byte_size, content_sha256, storage_backend, storage_key, is_fictional_demo,
       fictional_banner, malware_scan_status, review_status
     ) VALUES ($1,$2,$3,$4,$5,$5,'application/pdf',$6,$7,$8,$9,true,$10,'stub_clean','verified')
     RETURNING id`,
    [
      ownerUserId, subjectType, subjectId, kind, `${kind}-fictional.pdf`,
      pdf.length, sha256Buffer(pdf), store.backend, storageKey, FICTIONAL_BANNER,
    ],
  );
  return inserted.rows[0].id;
}

try {
  // Ensure migrations applied by caller; seed assumes 014 present.
  const service = new PostgresGrowBangladeshService(pool);

  await withTransaction(pool, async (client) => {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS staging_only boolean NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_lifecycle text`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz`);

    const adminId = await upsertUser(client, {
      id: ids.admin,
      email: 'admin-test@investinbd.net',
      password: process.env.TEST_ADMIN_PASSWORD,
      roles: [ROLES.SUPER_ADMIN, ROLES.COMPLIANCE_REVIEWER, ROLES.FINANCE_OFFICER, ROLES.SUPPORT, ROLES.PROJECT_REVIEWER],
      displayName: 'Staging Super Admin',
      kind: 'admin',
    });
    const ownerId = await upsertUser(client, {
      id: ids.owner,
      email: 'owner-test@investinbd.net',
      password: process.env.TEST_OWNER_PASSWORD,
      roles: [ROLES.PROJECT_OWNER],
      displayName: 'Fictional Owner Ayesha Rahman',
      kind: 'owner',
    });
    const investorId = await upsertUser(client, {
      id: ids.investor,
      email: 'investor-test@investinbd.net',
      password: process.env.TEST_INVESTOR_PASSWORD,
      roles: [ROLES.INVESTOR],
      displayName: 'Fictional Investor Karim Hossain',
      kind: 'investor',
    });

    // Identity for owner + investor (fictional NID)
    for (const [uid, name, nid] of [
      [ownerId, 'Ayesha Rahman (FICTIONAL)', '1990123456789'],
      [investorId, 'Karim Hossain (FICTIONAL)', '1987654321098'],
    ]) {
      const frontId = await putFictionalDoc(client, {
        ownerUserId: uid, subjectType: 'user_identity', subjectId: uid, kind: 'nid_front', title: 'NID Front',
      });
      const backId = await putFictionalDoc(client, {
        ownerUserId: uid, subjectType: 'user_identity', subjectId: uid, kind: 'nid_back', title: 'NID Back',
      });
      const selfieId = await putFictionalDoc(client, {
        ownerUserId: uid, subjectType: 'user_identity', subjectId: uid, kind: 'selfie', title: 'Selfie Manual Review',
      });
      await client.query(
        `INSERT INTO identity_verifications(
           user_id, legal_name, date_of_birth, nationality, phone, phone_verification_label,
           present_address, permanent_address, id_document_type, id_number_ciphertext, id_number_last4,
           id_front_document_id, id_back_document_id, selfie_document_id, selfie_review_mode, status, is_fictional_demo
         ) VALUES ($1,$2,'1990-01-15','Bangladeshi','+8801700000000',$3,
           'House 12, Road 4, Dhanmondi, Dhaka (FICTIONAL)','Same as present (FICTIONAL)','nid',$4,$5,
           $6,$7,$8,'manual','verified',true)
         ON CONFLICT (user_id) DO UPDATE SET
           legal_name=EXCLUDED.legal_name, status='verified', id_front_document_id=EXCLUDED.id_front_document_id,
           id_back_document_id=EXCLUDED.id_back_document_id, selfie_document_id=EXCLUDED.selfie_document_id,
           phone_verification_label=$3, updated_at=now()`,
        [uid, name, STAGING_PHONE_OTP_LABEL, encryptField(nid), last4Digits(nid), frontId, backId, selfieId],
      );
    }

    await client.query(
      `INSERT INTO investor_profiles(user_id, full_name, verification_status, risk_acknowledged_at, nationality, present_address, permanent_address, phone, kyc_status)
       VALUES ($1,'Karim Hossain (FICTIONAL)','verified',now(),'Bangladeshi','Dhaka (FICTIONAL)','Dhaka (FICTIONAL)','+8801700000000','approved')
       ON CONFLICT (user_id) DO UPDATE SET full_name=EXCLUDED.full_name, verification_status='verified', kyc_status='approved'`,
      [investorId],
    );

    // Related persons (fictional)
    await client.query(`DELETE FROM related_persons WHERE owner_user_id IN ($1,$2)`, [ownerId, investorId]);
    await client.query(
      `INSERT INTO related_persons(owner_user_id, relationship, full_name, is_minor, is_fictional_demo, fictional_banner, notes)
       VALUES
       ($1,'father','Abdul Rahman (FICTIONAL)',false,true,$3,'FICTIONAL DEMO'),
       ($1,'nominee','Nusrat Rahman (FICTIONAL)',false,true,$3,'FICTIONAL DEMO'),
       ($2,'spouse','Laila Hossain (FICTIONAL)',false,true,$3,'FICTIONAL DEMO'),
       ($2,'child','Rafi Hossain (FICTIONAL)',true,true,$3,'Minor — ID docs not mandatory'),
       ($2,'nominee','Laila Hossain (FICTIONAL)',false,true,$3,'FICTIONAL DEMO')`,
      [ownerId, investorId, FICTIONAL_BANNER],
    );

    // Business + verification items
    await client.query(
      `INSERT INTO businesses(id, owner_user_id, legal_name, registration_number, trade_license_number, tin, bin,
         verification_status, trade_name, registered_address, business_phone, business_email, business_type,
         business_status, business_verification_pct, is_fictional_demo)
       VALUES ($1,$2,'Green Valley Agro Ltd (FICTIONAL)','REG-FICTION-001','TL-FICTION-001','TIN-FICTION','BIN-FICTION',
         'verified','Green Valley (FICTIONAL)','Gazipur (FICTIONAL)','+8801800000000','biz-fictional@investinbd.net','agro',
         'verified',100,true)
       ON CONFLICT (id) DO UPDATE SET
         owner_user_id=EXCLUDED.owner_user_id, verification_status='verified', business_status='verified',
         business_verification_pct=100, is_fictional_demo=true`,
      [ids.business, ownerId],
    );

    // Ensure category exists for projects
    let categoryId = null;
    const cat = await client.query(`SELECT id FROM categories WHERE is_active=true ORDER BY display_order LIMIT 1`);
    if (cat.rowCount) categoryId = cat.rows[0].id;

    const disclaimer =
      'Projected returns are illustrative estimates on principal only, never withdrawable, and not a guarantee of profit. Administration fee is separate from principal.';

    async function upsertProject(row) {
      await client.query(
        `INSERT INTO projects(
           id, business_id, title, category, summary, status, total_units, reserved_units, active_units,
           unit_investment_poisha, administration_fee_bps, target_profit_bps, duration_days,
           published_terms_version, published_at, slug, location_text, funding_purpose, risk_summary,
           projection_disclaimer, pause_notice, is_fictional_demo, category_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true,$21
         )
         ON CONFLICT (id) DO UPDATE SET
           title=EXCLUDED.title, status=EXCLUDED.status, unit_investment_poisha=EXCLUDED.unit_investment_poisha,
           administration_fee_bps=EXCLUDED.administration_fee_bps, target_profit_bps=EXCLUDED.target_profit_bps,
           duration_days=EXCLUDED.duration_days, projection_disclaimer=EXCLUDED.projection_disclaimer,
           pause_notice=EXCLUDED.pause_notice, is_fictional_demo=true, updated_at=now()`,
        [
          row.id, ids.business, row.title, row.category, row.summary, row.status, row.totalUnits, row.activeUnits,
          row.unitPoisha, row.feeBps, row.profitBps, row.durationDays,
          row.termsVersion, row.publishedAt, row.slug, row.location, row.purpose, row.risk, disclaimer,
          row.pauseNotice, categoryId,
        ],
      );
      if (row.termsVersion) {
        await client.query(
          `INSERT INTO project_terms(project_id, version, terms_json, content_hash, approved_by)
           VALUES ($1,$2,$3::jsonb,$4,$5)
           ON CONFLICT (project_id, version) DO NOTHING`,
          [
            row.id, row.termsVersion,
            JSON.stringify({ fictional: true, banner: FICTIONAL_BANNER, disclaimer }),
            sha256Buffer(Buffer.from(`terms-${row.id}-${row.termsVersion}`)),
            adminId,
          ],
        );
      }
    }

    await upsertProject({
      id: ids.projectPublished,
      title: 'FICTIONAL Demo Agro Expansion (Published)',
      category: 'Agriculture',
      summary: 'FICTIONAL DEMO project for UAT — ৳8,500/unit, 15% fee, 20% projected annual on principal.',
      status: 'published',
      totalUnits: 100,
      activeUnits: 3,
      unitPoisha: 8500_00,
      feeBps: 1500,
      profitBps: 2000,
      durationDays: 365,
      termsVersion: 1,
      publishedAt: new Date(),
      slug: 'fictional-demo-agro-published',
      location: 'Gazipur (FICTIONAL)',
      purpose: 'Working capital for seasonal procurement (FICTIONAL)',
      risk: 'Market and operational risk — fictional demo only',
      pauseNotice: null,
    });
    await upsertProject({
      id: ids.projectDraft,
      title: 'FICTIONAL Owner Draft Cold Storage',
      category: 'Agriculture',
      summary: 'Draft project — not visible to investors.',
      status: 'draft',
      totalUnits: 50,
      activeUnits: 0,
      unitPoisha: 10000_00,
      feeBps: 1500,
      profitBps: 1800,
      durationDays: 300,
      termsVersion: null,
      publishedAt: null,
      slug: 'fictional-demo-draft-cold',
      location: 'Bogura (FICTIONAL)',
      purpose: 'Draft only',
      risk: 'n/a',
      pauseNotice: null,
    });
    await upsertProject({
      id: ids.projectChanges,
      title: 'FICTIONAL Changes Requested Pack House',
      category: 'Agriculture',
      summary: 'Admin requested changes — fictional.',
      status: 'changes_requested',
      totalUnits: 80,
      activeUnits: 0,
      unitPoisha: 9000_00,
      feeBps: 1500,
      profitBps: 1900,
      durationDays: 330,
      termsVersion: null,
      publishedAt: null,
      slug: 'fictional-demo-changes-pack',
      location: 'Rajshahi (FICTIONAL)',
      purpose: 'Awaiting owner edits',
      risk: 'n/a',
      pauseNotice: null,
    });
    await upsertProject({
      id: ids.projectPaused,
      title: 'FICTIONAL Paused Solar Kits',
      category: 'Renewable Energy',
      summary: 'Paused — removed from investor browse; existing records preserved.',
      status: 'paused',
      totalUnits: 60,
      activeUnits: 0,
      unitPoisha: 12000_00,
      feeBps: 1500,
      profitBps: 2200,
      durationDays: 365,
      termsVersion: 1,
      publishedAt: new Date(Date.now() - 86400000 * 10),
      slug: 'fictional-demo-paused-solar',
      location: 'Chattogram (FICTIONAL)',
      purpose: 'Paused funding',
      risk: 'n/a',
      pauseNotice: 'Funding temporarily paused. Existing applications and allocations are preserved. FICTIONAL DEMO.',
    });

    // Business verification items placeholders
    // (ensure via service after commit — do inside using raw inserts)
  });

  // Outside: use service helpers that need attached methods
  await service.ensureBusinessVerificationItems(ids.business);
  const items = await service.listBusinessVerificationItems(ids.business);
  for (const item of items) {
    await service.updateBusinessVerificationItem(
      ids.business,
      item.itemCode,
      ids.admin,
      { valueText: `FICTIONAL ${item.label}`, status: 'verified', adminNote: 'Seed verified — fictional' },
      {},
    );
  }
  await service.approveBusinessProfile(ids.business, ids.admin, 'Seed: complete fictional business profile', {});

  // Application + payment + allocation + agreement for investor on published project
  await withTransaction(pool, async (client) => {
    // Clean prior demo application for idempotent reseed of this scenario
    const prior = await client.query(
      `SELECT id FROM investment_applications WHERE investor_id=$1 AND project_id=$2`,
      [ids.investor, ids.projectPublished],
    );
    for (const row of prior.rows) {
      await client.query(`DELETE FROM investment_agreements WHERE application_id=$1`, [row.id]);
      await client.query(`DELETE FROM allocations WHERE application_id=$1`, [row.id]);
      await client.query(`DELETE FROM payments WHERE application_id=$1`, [row.id]);
      await client.query(`DELETE FROM agreement_acceptances WHERE application_id=$1`, [row.id]);
      await client.query(`DELETE FROM investment_applications WHERE id=$1`, [row.id]);
    }

    const app = await client.query(
      `INSERT INTO investment_applications(
         project_id, investor_id, units, unit_investment_poisha, investment_poisha,
         administration_fee_poisha, total_payable_poisha, terms_version, status, approved_by, approved_at, activated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,'active',$8,now(),now()) RETURNING *`,
      [
        ids.projectPublished, ids.investor, calc.units, calc.unitPricePoisha, calc.investmentPoisha,
        calc.administrationFeePoisha, calc.totalPayablePoisha, ids.admin,
      ],
    );
    await client.query(
      `INSERT INTO agreement_acceptances(
         application_id, investor_id, project_id, terms_version, agreement_version, device_meta, snapshot_json, accepted_user_agent
       ) VALUES ($1,$2,$3,1,'terms-v1',$4::jsonb,$5::jsonb,'FinalDemoSeed/1.0')`,
      [
        app.rows[0].id, ids.investor, ids.projectPublished,
        JSON.stringify({ seed: true }),
        JSON.stringify({ fictionalBanner: FICTIONAL_BANNER, calc }),
      ],
    );
    const pay = await client.query(
      `INSERT INTO payments(
         application_id, method, status, amount_poisha, reference, submitted_by, verified_by, verified_at, review_note, idempotency_key
       ) VALUES ($1,'bank_transfer','verified',$2,$3,$4,$5,now(),'Seed fictional payment verified',$6)
       RETURNING *`,
      [
        app.rows[0].id, calc.totalPayablePoisha, `SEED-FICTION-${Date.now()}`,
        ids.investor, ids.admin, `seed-final-demo-${Date.now()}`,
      ],
    );
    const alloc = await client.query(
      `INSERT INTO allocations(
         project_id, application_id, payment_id, investor_id, units, investment_poisha,
         target_profit_bps, duration_days, activated_at, maturity_at, status
       ) VALUES ($1,$2,$3,$4,$5,$6,2000,365,now(),now() + interval '365 days','active')
       RETURNING *`,
      [
        ids.projectPublished, app.rows[0].id, pay.rows[0].id, ids.investor, calc.units, calc.investmentPoisha,
      ],
    );
    await client.query(
      `UPDATE projects SET active_units=3, reserved_units=0 WHERE id=$1`,
      [ids.projectPublished],
    );

    const project = (await client.query('SELECT * FROM projects WHERE id=$1', [ids.projectPublished])).rows[0];
    await service.createFinalAgreementForAllocation(client, {
      application: app.rows[0],
      allocation: alloc.rows[0],
      project,
      investorId: ids.investor,
      actorId: ids.admin,
      requestContext: {},
    });

    // Projection confirmation example (display-only)
    await client.query(
      `INSERT INTO profit_confirmations(
         allocation_id, period_start, period_end, confirmed_profit_poisha, available_payable_poisha,
         status, approved_by, approved_at
       )
       SELECT $1, current_date - 30, current_date, $2, $2, 'approved', $3, now()
       WHERE NOT EXISTS (
         SELECT 1 FROM profit_confirmations WHERE allocation_id=$1 AND period_start=current_date-30
       )`,
      [alloc.rows[0].id, Math.round(calc.projectedAnnualProfitPoisha / 12), ids.admin],
    ).catch(() => {});

    // Exit example (display-only request record if table allows)
    await client.query(
      `INSERT INTO exit_requests(allocation_id, investor_id, status, reason)
       SELECT $1,$2,'submitted','FICTIONAL DEMO exit example'
       WHERE NOT EXISTS (SELECT 1 FROM exit_requests WHERE allocation_id=$1)`,
      [alloc.rows[0].id, ids.investor],
    ).catch(() => {});
  });

  await service.recomputeProfileCompletion(ids.owner);
  await service.recomputeProfileCompletion(ids.investor);
  await service.recomputeProfileCompletion(ids.admin);

  console.log(JSON.stringify({
    ok: true,
    accounts: ['admin-test@investinbd.net', 'owner-test@investinbd.net', 'investor-test@investinbd.net'],
    calc,
    fictionalBanner: FICTIONAL_BANNER,
    phoneOtpLabel: STAGING_PHONE_OTP_LABEL,
    projects: {
      published: ids.projectPublished,
      draft: ids.projectDraft,
      changes_requested: ids.projectChanges,
      paused: ids.projectPaused,
    },
    note: 'Passwords not logged. All documents marked FICTIONAL DEMO.',
  }, null, 2));
} finally {
  await closePool(pool);
}
