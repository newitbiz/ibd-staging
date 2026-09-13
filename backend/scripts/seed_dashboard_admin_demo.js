/**
 * Additive demo rows for dashboard/admin workflow statuses.
 * Does NOT wipe existing staging data.
 */
import { loadEnvFile } from '../src/load_env.js';
import { createPool, closePool } from '../src/db.js';

loadEnvFile();

async function main() {
  const pool = createPool();
  try {
    // Ensure a few support cases exist with unread flags for messaging centre cards
    const admin = await pool.query(
      `SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role_code='super_admin' LIMIT 1`,
    );
    const investor = await pool.query(
      `SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role_code='investor' LIMIT 1`,
    );
    if (admin.rowCount && investor.rowCount) {
      const existing = await pool.query(
        `SELECT id FROM support_cases WHERE subject = 'Dashboard workflow demo thread' LIMIT 1`,
      );
      if (!existing.rowCount) {
        const c = await pool.query(
          `INSERT INTO support_cases(opened_by, subject, description, priority, status, category, unread_for_staff, last_message_at)
           VALUES ($1,$2,$3,'normal','open','general',1,now()) RETURNING id`,
          [investor.rows[0].id, 'Dashboard workflow demo thread', 'Additive demo support conversation for messaging centre.'],
        );
        await pool.query(
          `INSERT INTO support_messages(case_id, sender_id, body, is_staff, is_internal_note)
           VALUES ($1,$2,$3,false,false)`,
          [c.rows[0].id, investor.rows[0].id, 'Hello admin — demo message from investor.'],
        );
        await pool.query(
          `INSERT INTO support_messages(case_id, sender_id, body, is_staff, is_internal_note)
           VALUES ($1,$2,$3,true,true)`,
          [c.rows[0].id, admin.rows[0].id, 'Internal note — never visible to users.'],
        );
        console.log('seeded support demo case', c.rows[0].id);
      } else {
        console.log('support demo case already present');
      }
    }
    console.log('seed_dashboard_admin_demo complete (additive)');
  } finally {
    await closePool();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
