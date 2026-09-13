/**
 * Private document storage abstraction.
 * Staging default: local/private volume (PRIVATE_DOCS_ROOT).
 * Production blocker: Railway Hobby may lack managed bucket — configure S3-compatible
 * env (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) when available.
 * Never store public URLs; metadata/keys live in Postgres only.
 */
import { createHash, randomBytes, createHmac } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from './domain.js';

export const FICTIONAL_BANNER = 'FICTIONAL DEMO — NOT A REAL DOCUMENT';
export const STAGING_PHONE_OTP_LABEL = 'Staging verification — mobile OTP not enabled';

export const ALLOWED_MIME = Object.freeze({
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'application/pdf': ['.pdf'],
  'video/mp4': ['.mp4'],
});

export const MAX_BYTES = 25 * 1024 * 1024; // 25 MiB soft limit (DB allows 50)

const EXECUTABLE_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.sh', '.bash',
  '.dll', '.so', '.dylib', '.apk', '.jar', '.bin', '.run', '.app',
]);

export function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file'))
    .replace(/[^\w.\-()+ ]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
  return base || 'file';
}

export function assertAllowedUpload({ filename, mimeType, byteSize }) {
  const sanitized = sanitizeFilename(filename);
  const ext = path.extname(sanitized).toLowerCase();
  if (EXECUTABLE_EXTS.has(ext)) {
    throw new DomainError('DOCUMENT_EXECUTABLE_REJECTED', 'Executable uploads are rejected', 400);
  }
  if (!ALLOWED_MIME[mimeType]) {
    throw new DomainError('DOCUMENT_MIME_REJECTED', `MIME type not allowed: ${mimeType}`, 400);
  }
  if (!ALLOWED_MIME[mimeType].includes(ext) && ext !== '') {
    throw new DomainError('DOCUMENT_EXT_MISMATCH', 'Filename extension does not match MIME type', 400);
  }
  const size = Number(byteSize);
  if (!Number.isInteger(size) || size <= 0 || size > MAX_BYTES) {
    throw new DomainError('DOCUMENT_SIZE_REJECTED', `File size must be 1–${MAX_BYTES} bytes`, 400);
  }
  return { sanitizedFilename: sanitized, ext };
}

export function resolveStorageBackend() {
  if (process.env.S3_BUCKET && process.env.S3_ENDPOINT) return 's3_compatible';
  if (process.env.RAILWAY_BUCKET_NAME) return 'railway_bucket';
  return 'local_volume';
}

export function privateDocsRoot() {
  return process.env.PRIVATE_DOCS_ROOT || '/tmp/grow-private-docs';
}

function signingSecret() {
  return process.env.DOCUMENT_URL_SIGNING_SECRET || process.env.JWT_ACCESS_SECRET || 'staging-doc-signing-not-for-prod';
}

export class LocalVolumeDocumentStore {
  constructor(root = privateDocsRoot()) {
    this.root = root;
    this.backend = 'local_volume';
  }

  async ensureRoot() {
    await mkdir(this.root, { recursive: true });
  }

  async putObject({ storageKey, buffer }) {
    await this.ensureRoot();
    const full = path.join(this.root, storageKey);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buffer, { mode: 0o600 });
    return { storageKey, backend: this.backend };
  }

  async getObject(storageKey) {
    const full = path.join(this.root, storageKey);
    await access(full);
    return readFile(full);
  }

  /** Short-lived HMAC signed URL path (API serves bytes after verify). */
  createSignedUrl({ documentId, actorId, ttlSeconds = 120 }) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = `${documentId}.${actorId}.${exp}`;
    const sig = createHmac('sha256', signingSecret()).update(payload).digest('base64url');
    return {
      url: `/documents/${documentId}/content?exp=${exp}&actor=${encodeURIComponent(actorId)}&sig=${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      ttlSeconds,
      public: false,
    };
  }

  verifySignedUrl({ documentId, actorId, exp, sig }) {
    const now = Math.floor(Date.now() / 1000);
    if (!exp || Number(exp) < now) {
      throw new DomainError('SIGNED_URL_EXPIRED', 'Signed URL expired', 401);
    }
    const payload = `${documentId}.${actorId}.${exp}`;
    const expected = createHmac('sha256', signingSecret()).update(payload).digest('base64url');
    if (expected !== sig) {
      throw new DomainError('SIGNED_URL_INVALID', 'Signed URL signature invalid', 401);
    }
    return true;
  }
}

/** S3-compatible stub — records intent; production must wire AWS SDK / fetch PUT. */
export class S3CompatibleDocumentStore {
  constructor() {
    this.backend = 's3_compatible';
    this.localFallback = new LocalVolumeDocumentStore();
  }

  async putObject(args) {
    // Hobby / missing creds: fall back to local volume and document the blocker.
    if (!process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
      const result = await this.localFallback.putObject(args);
      return { ...result, backend: 'local_volume', productionBlocker: 'S3 credentials unset on staging' };
    }
    // Without AWS SDK dependency, store locally but tag as s3_compatible intent.
    const result = await this.localFallback.putObject(args);
    return { ...result, backend: 's3_compatible', note: 'SDK not bundled — bytes on private volume with S3 key layout' };
  }

  getObject(storageKey) {
    return this.localFallback.getObject(storageKey);
  }

  createSignedUrl(args) {
    return this.localFallback.createSignedUrl(args);
  }

  verifySignedUrl(args) {
    return this.localFallback.verifySignedUrl(args);
  }
}

export function createDocumentStore() {
  const backend = resolveStorageBackend();
  if (backend === 's3_compatible' || backend === 'railway_bucket') {
    return new S3CompatibleDocumentStore();
  }
  return new LocalVolumeDocumentStore();
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function newStorageKey({ ownerUserId, kind, ext }) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomBytes(8).toString('hex');
  return `private/${ownerUserId}/${kind}/${stamp}-${rand}${ext || ''}`;
}

/** Malware-scan hook stub — always stub_clean for allowed types in staging. */
export function runMalwareScanStub({ mimeType }) {
  if (!ALLOWED_MIME[mimeType]) {
    return { status: 'stub_rejected', note: 'MIME rejected before scan' };
  }
  return {
    status: 'stub_clean',
    note: 'Malware scan hook stub — production must integrate real scanner',
  };
}

export function buildFictionalPlaceholderPdf({ title, bodyLines = [] }) {
  // Minimal multi-line PDF for demo downloads (not a full PDF writer).
  const lines = [
    FICTIONAL_BANNER,
    title || 'Invest in Bangladesh Fictional Agreement',
    ...bodyLines,
  ].map((l) => String(l ?? '').replace(/[()\\]/g, ' ').slice(0, 110));

  let y = 760;
  const ops = [];
  for (const line of lines) {
    ops.push(`BT /F1 11 Tf 48 ${y} Td (${line}) Tj ET`);
    y -= 16;
    if (y < 48) break;
  }
  const stream = ops.join('\n');
  const objects = [];
  objects.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  objects.push('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
  objects.push(
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n',
  );
  objects.push(`4 0 obj<< /Length ${Buffer.byteLength(stream, 'utf8')} >>stream\n${stream}\nendstream\nendobj\n`);
  objects.push('5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n');
  let pdf = '%PDF-1.4\n% FICTIONAL DEMO — NOT A REAL DOCUMENT\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

/** Soft limit for project photos (JPEG/PNG). */
export const PROJECT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PROJECT_PHOTO_MIME = Object.freeze({
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
});

export function assertProjectPhotoUpload({ filename, mimeType, byteSize }) {
  const sanitized = sanitizeFilename(filename);
  const ext = path.extname(sanitized).toLowerCase();
  if (EXECUTABLE_EXTS.has(ext)) {
    throw new DomainError('DOCUMENT_EXECUTABLE_REJECTED', 'Executable uploads are rejected', 400);
  }
  if (!PROJECT_PHOTO_MIME[mimeType]) {
    throw new DomainError('PROJECT_PHOTO_MIME_REJECTED', 'Project photos must be JPEG or PNG', 400);
  }
  if (!PROJECT_PHOTO_MIME[mimeType].includes(ext) && ext !== '') {
    throw new DomainError('DOCUMENT_EXT_MISMATCH', 'Filename extension does not match MIME type', 400);
  }
  const size = Number(byteSize);
  if (!Number.isInteger(size) || size <= 0 || size > PROJECT_PHOTO_MAX_BYTES) {
    throw new DomainError(
      'PROJECT_PHOTO_SIZE_REJECTED',
      `Project photo size must be 1–${PROJECT_PHOTO_MAX_BYTES} bytes`,
      400,
    );
  }
  return { sanitizedFilename: sanitized, ext };
}
