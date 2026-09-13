/**
 * Provision individual staging tester (and optional role) accounts with unique passwords.
 *
 * Input (never log values):
 *   SEED_TESTERS_JSON — JSON string: { "accounts": [ { "email", "password", "role?" } ] }
 *   or SEED_TESTERS_FILE — path to the same JSON shape
 *
 * Writes nothing except counts. Mapping for ops lives only under
 * /workspace/grow-bangladesh/.staging_secrets/testers.json (gitignored, mode 600).
 */
import { readFileSync } from 'node:fs';
import { loadEnvFile } from '../src/load_env.js';
import { closePool, createPool, withTransaction } from '../src/db.js';
import { hashPassword } from '../src/crypto_util.js';
import { ALL_ROLES, ROLES } from '../src/roles.js';

loadEnvFile();

function loadAccounts() {
  let raw = process.env.SEED_TESTERS_JSON;
  if (!raw && process.env.SEED_TESTERS_FILE) {
    raw = readFileSync(process.env.SEED_TESTERS_FILE, 'utf8');
  }
  if (!raw) {
    throw new Error('SEED_TESTERS_JSON or SEED_TESTERS_FILE is required');
  }
  const parsed = JSON.parse(raw);
  const accounts = Array.isArray(parsed) ? parsed : parsed.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('SEED_TESTERS_JSON must include a non-empty accounts array');
  }
  for (const a of accounts) {
    if (!a || typeof a.email !== 'string' || typeof a.password !== 'string') {
      throw new Error('Each account requires email and password strings');
    }
    if (a.password.length < 12) {
      throw new Error(`Password for ${a.email} must be at least 12 characters`);
    }
    if (a.role && !ALL_ROLES.includes(a.role)) {
      throw new Error(`Invalid role for ${a.email}`);
    }
  }
  return accounts;
}

const accounts = loadAccounts();
const pool = createPool();
let created = 0;
let updated = 0;

try {
  await withTransaction(pool, async (client) => {
    const adminRes = await client.query(
      `SELECT id FROM users WHERE email = 'admin@example.invalid' LIMIT 1`,
    );
    const grantedBy = adminRes.rows[0]?.id ?? null;

    for (const account of accounts) {
      const role = account.role || ROLES.INVESTOR;
      const passwordHash = await hashPassword(account.password);
      const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [account.email]);
      let userId;
      if (existing.rows[0]) {
        userId = existing.rows[0].id;
        await client.query(
          `UPDATE users SET password_hash = $2, status = 'active', updated_at = now() WHERE id = $1`,
          [userId, passwordHash],
        );
        updated += 1;
      } else {
        const inserted = await client.query(
          `INSERT INTO users(email, password_hash, status)
           VALUES ($1, $2, 'active')
           RETURNING id`,
          [account.email, passwordHash],
        );
        userId = inserted.rows[0].id;
        created += 1;
      }

      await client.query(
        `INSERT INTO user_roles(user_id, role_code, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, role, grantedBy],
      );

      if (role === ROLES.INVESTOR) {
        await client.query(
          `INSERT INTO investor_profiles(user_id, full_name, verification_status, risk_acknowledged_at)
           VALUES ($1, $2, 'verified', now())
           ON CONFLICT (user_id) DO NOTHING`,
          [userId, `Tester ${account.email.split('@')[0]}`],
        );
      }
    }
  });
  console.log(
    `Tester seed applied: created=${created} updated=${updated} total=${accounts.length}. Passwords not logged.`,
  );
} finally {
  await closePool(pool);
}
