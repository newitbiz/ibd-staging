/**
 * One-shot Railway boot: migrate → seed_test_accounts (if TEST_* set) → server.
 * Never logs secret values.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

function runNode(scriptRel) {
  const script = path.join(root, scriptRel);
  return new Promise((resolve, reject) => {
    console.log(`[oneshot] starting ${scriptRel}`);
    const child = spawn(process.execPath, [script], {
      stdio: 'inherit',
      env: process.env,
      cwd: path.join(root, '..'),
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${scriptRel} exited via signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${scriptRel} exited with code ${code}`));
        return;
      }
      console.log(`[oneshot] finished ${scriptRel}`);
      resolve();
    });
  });
}

try {
  await runNode('migrate.js');
  await runNode('seed_test_accounts.js');
  console.log('[oneshot] starting server');
  const server = path.join(root, '..', 'src', 'server.js');
  const child = spawn(process.execPath, [server], {
    stdio: 'inherit',
    env: process.env,
    cwd: path.join(root, '..'),
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
} catch (err) {
  console.error('[oneshot] failed:', err && err.message ? err.message : err);
  process.exit(1);
}
