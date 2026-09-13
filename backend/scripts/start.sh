#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node scripts/migrate.js
if [ "${RUN_SEED_TEST_ACCOUNTS:-}" = "true" ]; then
  echo "[start] RUN_SEED_TEST_ACCOUNTS=true — running seed_test_accounts.js"
  node scripts/seed_test_accounts.js
fi
if [ "${RUN_DEMO_SEED_ON_BOOT:-}" = "true" ]; then
  echo "[start] RUN_DEMO_SEED_ON_BOOT=true — running seed.js"
  node scripts/seed.js
fi
if [ "${RUN_SEED_FINAL_DEMO:-}" = "true" ]; then
  echo "[start] RUN_SEED_FINAL_DEMO=true — running seed_final_demo.js"
  node scripts/seed_final_demo.js || echo "[start] seed_final_demo failed (non-fatal for boot)"
fi
exec node src/server.js
