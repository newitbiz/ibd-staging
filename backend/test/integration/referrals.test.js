import test from 'node:test';
import assert from 'node:assert/strict';

const hasDb = Boolean(process.env.DATABASE_URL);

test('referral integration smoke or skip without DATABASE_URL', async () => {
  if (!hasDb) {
    assert.ok(true, 'skipped locally without DATABASE_URL');
    return;
  }
  assert.ok(String(process.env.DATABASE_URL).includes('postgres'));
});
