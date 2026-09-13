import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('base64');

const {
  encryptField,
  decryptField,
  maskLast4,
  last4Digits,
  resetFieldEncryptionKeyCache,
} = await import('../src/field_encryption.js');

test('field encryption roundtrip does not embed plaintext', () => {
  resetFieldEncryptionKeyCache();
  const plain = '1234567890123';
  const ct = encryptField(plain);
  assert.ok(ct.startsWith('v1:'));
  assert.equal(ct.includes(plain), false);
  assert.equal(decryptField(ct), plain);
  // second encrypt yields different ciphertext (random IV)
  const ct2 = encryptField(plain);
  assert.notEqual(ct, ct2);
  assert.equal(decryptField(ct2), plain);
});

test('mask helpers expose only last4', () => {
  assert.equal(last4Digits('998877665544'), '5544');
  assert.equal(maskLast4('998877665544'), '5544');
});

test('missing key fails closed', async () => {
  resetFieldEncryptionKeyCache();
  const prev = process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.BANK_DATA_KEY;
  try {
    assert.throws(() => encryptField('12345678'), /FIELD_ENCRYPTION_KEY|BANK_DATA_KEY|not configured/);
  } finally {
    process.env.FIELD_ENCRYPTION_KEY = prev;
    resetFieldEncryptionKeyCache();
  }
});
