import { loadEnvFile } from '../src/load_env.js';
import { closePool, createPool, withTransaction } from '../src/db.js';
import { hashPassword } from '../src/crypto_util.js';

loadEnvFile();

const ids = {
  admin: '00000000-0000-4000-8000-000000000001',
  owner: '00000000-0000-4000-8000-000000000002',
  investor: '00000000-0000-4000-8000-000000000003',
  finance: '00000000-0000-4000-8000-000000000004',
  projectReviewer: '00000000-0000-4000-8000-000000000005',
  compliance: '00000000-0000-4000-8000-000000000006',
  support: '00000000-0000-4000-8000-000000000007',
  auditor: '00000000-0000-4000-8000-000000000008',
  business: '00000000-0000-4000-8000-000000000010',
  project: '00000000-0000-4000-8000-000000000020',
};

const demoPassword = process.env.DEMO_SEED_PASSWORD;
if (!demoPassword || String(demoPassword).length < 12) {
  throw new Error('DEMO_SEED_PASSWORD must be set to a strong value (12+ characters) before seeding');
}
const passwordHash = await hashPassword(demoPassword);

const pool = createPool();
try {
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO users(id,email,password_hash,status) VALUES
       ($1,'admin@example.invalid',$9,'active'),
       ($2,'owner@example.invalid',$9,'active'),
       ($3,'investor@example.invalid',$9,'active'),
       ($4,'finance@example.invalid',$9,'active'),
       ($5,'project-reviewer@example.invalid',$9,'active'),
       ($6,'compliance@example.invalid',$9,'active'),
       ($7,'support@example.invalid',$9,'active'),
       ($8,'auditor@example.invalid',$9,'active')
       ON CONFLICT (id) DO UPDATE SET password_hash=EXCLUDED.password_hash, status='active'`,
      [
        ids.admin,
        ids.owner,
        ids.investor,
        ids.finance,
        ids.projectReviewer,
        ids.compliance,
        ids.support,
        ids.auditor,
        passwordHash,
      ],
    );
    await client.query(
      `INSERT INTO user_roles(user_id,role_code,granted_by) VALUES
       ($1,'super_admin',$1),
       ($2,'project_owner',$1),
       ($3,'investor',$1),
       ($4,'finance_officer',$1),
       ($5,'project_reviewer',$1),
       ($6,'compliance_reviewer',$1),
       ($7,'support',$1),
       ($8,'auditor',$1)
       ON CONFLICT DO NOTHING`,
      [
        ids.admin,
        ids.owner,
        ids.investor,
        ids.finance,
        ids.projectReviewer,
        ids.compliance,
        ids.support,
        ids.auditor,
      ],
    );
    await client.query(
      `INSERT INTO investor_profiles(user_id, full_name, verification_status, risk_acknowledged_at)
       VALUES ($1,'Demo Investor','verified',now())
       ON CONFLICT (user_id) DO NOTHING`,
      [ids.investor],
    );
    await client.query(
      `INSERT INTO businesses(id,owner_user_id,legal_name,verification_status)
       VALUES ($1,$2,'Nadia Enterprise Demo','verified') ON CONFLICT (id) DO NOTHING`,
      [ids.business, ids.owner],
    );
    const category = await client.query(
      `SELECT id, name FROM categories WHERE slug='manufacturing' OR lower(name)=lower('Manufacturing') LIMIT 1`,
    );
    if (!category.rowCount) {
      throw new Error('categories seed missing; run migrations before seed');
    }
    const categoryId = category.rows[0].id;
    const categoryName = category.rows[0].name;
    await client.query(
      `INSERT INTO projects(
         id,business_id,title,category,category_id,summary,status,slug,project_code,
         total_units,unit_investment_poisha,
         administration_fee_bps,target_profit_bps,selected_rate_bps,
         projected_return_min_bps,projected_return_max_bps,funding_target_poisha,
         duration_days,minimum_exit_days,
         risk_disclosure,terms_text,exit_policy,
         published_terms_version,published_at,published_by,approved_at,approved_by,
         version_number
       ) VALUES (
         $1,$2,'Garment Export Project 01',$3,$4,
         'Demo production funding for a confirmed export order.','published',
         'garment-export-project-01','GB-2026-000020',
         1000,850000,
         1500,2000,2000,
         1500,2500,850000000,
         365,180,
         'Standard marketplace risk disclosure — capital at risk; returns not guaranteed.',
         'Standard investment terms apply as approved by Invest in Bangladesh staff.',
         'Early exit subject to minimum hold period and liquidity review. Not a withdrawable balance.',
         1,now(),$5,now(),$5,1
       ) ON CONFLICT (id) DO NOTHING`,
      [ids.project, ids.business, categoryName, categoryId, ids.admin],
    );
    await client.query(
      `INSERT INTO project_terms(project_id,version,terms_json,content_hash,approved_by)
       VALUES ($1,1,'{"demo":true,"profitLabel":"Target profit","unitInvestmentPoisha":850000,"administrationFeeBps":1500}',
       'demo-seed-content-hash',$2) ON CONFLICT DO NOTHING`,
      [ids.project, ids.admin],
    );
    await client.query(
      `INSERT INTO project_versions(project_id, version_number, snapshot_json, content_hash, change_summary, created_by)
       VALUES ($1, 1, '{"seed":true,"unitInvestmentPoisha":850000,"administrationFeeBps":1500,"totalUnits":1000}'::jsonb,
               'demo-seed-version-hash', 'seed_initial', $2)
       ON CONFLICT (project_id, version_number) DO NOTHING`,
      [ids.project, ids.admin],
    );
  });
  console.log('Demo seed applied for *@example.invalid accounts. Password taken from DEMO_SEED_PASSWORD (value not logged). Never use demo accounts in production.');
} finally {
  await closePool(pool);
}
