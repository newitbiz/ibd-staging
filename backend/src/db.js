import pg from 'pg';

const { Pool, types } = pg;

types.setTypeParser(20, (value) => Number.parseInt(value, 10));

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required for PostgreSQL mode');
  return value;
}

export function createPool() {
  const useSsl = process.env.DATABASE_SSL === 'true';
  return new Pool({
    connectionString: requireDatabaseUrl(),
    max: Number.parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: useSsl
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
  });
}

export async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(pool) {
  await pool.end();
}
