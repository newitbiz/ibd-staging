/**
 * Staging-only private test accounts. Passwords from Railway Variables only:
 *   TEST_ADMIN_PASSWORD, TEST_OWNER_PASSWORD, TEST_INVESTOR_PASSWORD
 * Never log password values. Hashes only written to PostgreSQL.
 */
import { loadEnvFile } from '../src/load_env.js';
import { closePool, createPool, withTransaction } from '../src/db.js';
import { hashPassword } from '../src/crypto_util.js';
import { ROLES } from '../src/roles.js';

loadEnvFile();

const REQUIRED = ['TEST_ADMIN_PASSWORD', 'TEST_OWNER_PASSWORD', 'TEST_INVESTOR_PASSWORD'];
const missing = REQUIRED.filter((k) => !process.env[k] || String(process.env[k]).length < 12);
if (missing.length) {
  console.error(`Missing or too-short Railway vars: ${missing.join(', ')}`);
  process.exit(1);
}

const accounts = [
  {
    email: 'admin-test@investinbd.net',
    passwordEnv: 'TEST_ADMIN_PASSWORD',
    roles: [ROLES.SUPER_ADMIN, ROLES.COMPLIANCE_REVIEWER, ROLES.FINANCE_OFFICER, ROLES.SUPPORT],
    fullName: 'Staging Super Admin',
    kind: 'admin',
  },
  {
    email: 'owner-test@investinbd.net',
    passwordEnv: 'TEST_OWNER_PASSWORD',
    roles: [ROLES.PROJECT_OWNER, ROLES.INVESTOR],
    fullName: 'Staging Project Owner',
    kind: 'owner',
  },
  {
    email: 'investor-test@investinbd.net',
    passwordEnv: 'TEST_INVESTOR_PASSWORD',
    roles: [ROLES.INVESTOR],
    fullName: 'Staging Investor',
    kind: 'investor',
  },
];

const ids = {
  admin: '10000000-0000-4000-8000-000000000001',
  owner: '10000000-0000-4000-8000-000000000002',
  investor: '10000000-0000-4000-8000-000000000003',
  business: '10000000-0000-4000-8000-000000000010',
};

const pool = createPool();
let created = 0;
let updated = 0;

try {
  await withTransaction(pool, async (client) => {
    // Ensure password-change flag column exists (staging / future launch)
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS staging_only boolean NOT NULL DEFAULT false
    `);

    const byKind = { admin: ids.admin, owner: ids.owner, investor: ids.investor };

    for (const account of accounts) {
      const password = process.env[account.passwordEnv];
      const passwordHash = await hashPassword(password);
      const fixedId = byKind[account.kind];

      const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [account.email]);
      let userId;
      if (existing.rows[0]) {
        userId = existing.rows[0].id;
        await client.query(
          `UPDATE users
           SET password_hash = $2, status = 'active', must_change_password = true,
               staging_only = true, updated_at = now()
           WHERE id = $1`,
          [userId, passwordHash],
        );
        updated += 1;
      } else {
        const byId = await client.query(`SELECT id FROM users WHERE id = $1`, [fixedId]);
        if (byId.rows[0]) {
          userId = fixedId;
          await client.query(
            `UPDATE users
             SET email = $2, password_hash = $3, status = 'active',
                 must_change_password = true, staging_only = true, updated_at = now()
             WHERE id = $1`,
            [userId, account.email, passwordHash],
          );
          updated += 1;
        } else {
          await client.query(
            `INSERT INTO users(id, email, password_hash, status, must_change_password, staging_only)
             VALUES ($1, $2, $3, 'active', true, true)`,
            [fixedId, account.email, passwordHash],
          );
          userId = fixedId;
          created += 1;
        }
      }

      for (const role of account.roles) {
        await client.query(
          `INSERT INTO user_roles(user_id, role_code, granted_by)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [userId, role, ids.admin],
        );
      }

      if (account.kind === 'investor') {
        await client.query(
          `INSERT INTO investor_profiles(user_id, full_name, verification_status, risk_acknowledged_at)
           VALUES ($1, $2, 'verified', now())
           ON CONFLICT (user_id) DO UPDATE
           SET full_name = EXCLUDED.full_name, verification_status = 'verified',
               risk_acknowledged_at = COALESCE(investor_profiles.risk_acknowledged_at, now())`,
          [userId, account.fullName],
        );
      }

      if (account.kind === 'owner') {
        await client.query(
          `INSERT INTO businesses(id, owner_user_id, legal_name, verification_status)
           VALUES ($1, $2, $3, 'verified')
           ON CONFLICT (id) DO UPDATE
           SET owner_user_id = EXCLUDED.owner_user_id, verification_status = 'verified'`,
          [ids.business, userId, 'Staging Owner Test Business'],
        );
      }
    }
  });
  console.log(
    `Test accounts seed: created=${created} updated=${updated} emails=admin-test/owner-test/investor-test@investinbd.net. Passwords not logged.`,
  );
} finally {
  await closePool(pool);
}
