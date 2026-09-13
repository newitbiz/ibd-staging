import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadEnvFile } from '../src/load_env.js';
import { closePool, createPool } from '../src/db.js';

loadEnvFile();

const directory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(directory, '..', 'database', 'schema.sql');
const migrationsDir = path.join(directory, '..', 'database', 'migrations');

const pool = createPool();

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const initialVersion = '001_initial_schema';
  const appliedInitial = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [initialVersion]);
  if (!appliedInitial.rowCount) {
    const sql = await readFile(schemaPath, 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [initialVersion]);
    console.log(`${initialVersion} applied successfully`);
  } else {
    console.log(`${initialVersion} already applied`);
  }

  let migrationFiles = [];
  try {
    migrationFiles = (await readdir(migrationsDir))
      .filter((name) => name.endsWith('.sql'))
      .sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const file of migrationFiles) {
    const version = file.replace(/\.sql$/, '');
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
    if (applied.rowCount) {
      console.log(`${version} already applied`);
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
    console.log(`${version} applied successfully`);
  }
} finally {
  await closePool(pool);
}
