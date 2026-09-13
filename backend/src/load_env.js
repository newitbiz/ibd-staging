import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load KEY=VALUE pairs from a .env file into process.env when the file exists.
 * Existing process.env values win (so CI/env-injected secrets are never overwritten).
 * Returns true when a file was loaded, false when missing (optional).
 */
export function loadEnvFile(filePath) {
  const resolved = filePath
    ? path.resolve(filePath)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

  if (!existsSync(resolved)) return false;

  const text = readFileSync(resolved, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}
