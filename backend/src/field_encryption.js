import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * App-level AES-256-GCM for sensitive bank fields.
 * Ciphertext encoding: v1:<iv_b64url>:<tag_b64url>:<ct_b64url>
 * Key: FIELD_ENCRYPTION_KEY or BANK_DATA_KEY — 32-byte value as base64 or base64url.
 * Never log plaintext or the key.
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const VERSION = 'v1';

function resolveKeyMaterial() {
  const raw = process.env.FIELD_ENCRYPTION_KEY || process.env.BANK_DATA_KEY || '';
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    const err = new Error('FIELD_ENCRYPTION_KEY (or BANK_DATA_KEY) is not configured');
    err.code = 'ENCRYPTION_KEY_MISSING';
    throw err;
  }
  const trimmed = raw.trim();
  let buf;
  try {
    buf = Buffer.from(trimmed, 'base64');
  } catch {
    buf = null;
  }
  if (!buf || buf.length !== 32) {
    try {
      buf = Buffer.from(trimmed, 'base64url');
    } catch {
      buf = null;
    }
  }
  if (!buf || buf.length !== 32) {
    const err = new Error('FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes');
    err.code = 'ENCRYPTION_KEY_INVALID';
    throw err;
  }
  return buf;
}

let cachedKey = null;
function getKey() {
  if (!cachedKey) cachedKey = resolveKeyMaterial();
  return cachedKey;
}

/** Reset cached key (tests only). */
export function resetFieldEncryptionKeyCache() {
  cachedKey = null;
}

export function encryptField(plaintext) {
  if (plaintext == null) return null;
  const text = String(plaintext);
  if (!text) {
    const err = new Error('Cannot encrypt empty value');
    err.code = 'ENCRYPTION_EMPTY';
    throw err;
  }
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptField(ciphertext) {
  if (ciphertext == null) return null;
  const parts = String(ciphertext).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    const err = new Error('Unrecognized ciphertext format');
    err.code = 'ENCRYPTION_FORMAT';
    throw err;
  }
  const key = getKey();
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const data = Buffer.from(parts[3], 'base64url');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString('utf8');
}

export function maskLast4(value, { minLen = 4 } = {}) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, '');
  if (s.length < minLen) return '****';
  return s.slice(-4);
}

export function last4Digits(value) {
  const s = String(value || '').replace(/\D/g, '');
  if (s.length < 4) {
    const err = new Error('Value must contain at least 4 digits for masking');
    err.code = 'MASK_TOO_SHORT';
    throw err;
  }
  return s.slice(-4);
}

export function last4Alnum(value) {
  const s = String(value || '').replace(/[^0-9A-Za-z]/g, '');
  if (s.length < 2) {
    const err = new Error('Routing value too short');
    err.code = 'MASK_TOO_SHORT';
    throw err;
  }
  return s.slice(-Math.min(4, s.length));
}

/** Constant-time compare of two ciphertexts or strings without leaking via logs. */
export function safeEqualString(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function assertEncryptionConfigured() {
  getKey();
  return true;
}
