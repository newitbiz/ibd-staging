/**
 * Final Demo / UAT service methods mixed into PostgresGrowBangladeshService.
 * Sections A–M: admin user console, identity, related persons, documents,
 * profile completion, business verification, agreements, demo helpers.
 */
import { createHash } from 'node:crypto';
import { withTransaction } from './db.js';
import { DomainError } from './domain.js';
import { encryptField, maskLast4, last4Digits } from './field_encryption.js';
import {
  FICTIONAL_BANNER,
  STAGING_PHONE_OTP_LABEL,
  assertAllowedUpload,
  createDocumentStore,
  sha256Buffer,
  newStorageKey,
  runMalwareScanStub,
  buildFictionalPlaceholderPdf,
  resolveStorageBackend,
} from './document_storage.js';

const VERIFICATION_STATUSES = new Set([
  'not_provided', 'submitted', 'under_review', 'correction_required', 'verified', 'rejected', 'expired',
]);

const LIFECYCLE_STATUSES = new Set([
  'pending', 'active', 'paused', 'suspended', 'deactivated', 'archived',
]);

const LIFECYCLE_TO_USER_STATUS = {
  pending: 'pending_verification',
  active: 'active',
  paused: 'active',
  suspended: 'suspended',
  deactivated: 'suspended',
  archived: 'closed',
};

const BUSINESS_ITEM_DEFS = [
  { code: 'legal_name', label: 'Legal business name' },
  { code: 'trade_name', label: 'Trade name' },
  { code: 'registration_number', label: 'Registration number' },
  { code: 'trade_license_number', label: 'Trade license number' },
  { code: 'tin', label: 'TIN' },
  { code: 'bin', label: 'BIN' },
  { code: 'registered_address', label: 'Registered address' },
  { code: 'business_phone', label: 'Business phone' },
  { code: 'business_email', label: 'Business email' },
  { code: 'trade_license_doc', label: 'Trade license document' },
  { code: 'tin_certificate_doc', label: 'TIN certificate document' },
  { code: 'incorporation_doc', label: 'Incorporation / RJSC document' },
];

const PROJECTION_DISCLAIMER =
  'Projected returns are illustrative estimates on principal only, never withdrawable, and not a guarantee of profit. Administration fee is separate from principal.';

async function audit(client, actorId, action, subjectType, subjectId, detail = {}, meta = {}) {
  const result = await client.query(
    `INSERT INTO audit_logs(actor_id, action, subject_type, subject_id, reason, before_json, after_json, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::inet,$9)
     RETURNING id`,
    [
      actorId,
      action,
      subjectType,
      subjectId,
      meta.reason ?? null,
      meta.before != null ? JSON.stringify(meta.before) : null,
      (meta.after != null ? meta.after : detail) != null
        ? JSON.stringify(meta.after != null ? meta.after : detail)
        : null,
      meta.ip || null,
      meta.userAgent || null,
    ],
  );
  return result.rows[0]?.id || null;
}

function mapDoc(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    documentKind: row.document_kind,
    originalFilename: row.original_filename,
    sanitizedFilename: row.sanitized_filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    contentSha256: row.content_sha256,
    storageBackend: row.storage_backend,
    storageKey: row.storage_key,
    isFictionalDemo: row.is_fictional_demo,
    fictionalBanner: row.fictional_banner,
    malwareScanStatus: row.malware_scan_status,
    reviewStatus: row.review_status,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publicUrl: null,
  };
}

function mapIdentity(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    legalName: row.legal_name,
    dateOfBirth: row.date_of_birth,
    nationality: row.nationality,
    phone: row.phone,
    phoneVerificationLabel: row.phone_verification_label || STAGING_PHONE_OTP_LABEL,
    presentAddress: row.present_address,
    permanentAddress: row.permanent_address,
    idDocumentType: row.id_document_type,
    idNumberLast4: row.id_number_last4,
    idNumberMasked: row.id_number_last4 ? `****${row.id_number_last4}` : null,
    idFrontDocumentId: row.id_front_document_id,
    idBackDocumentId: row.id_back_document_id,
    profilePhotoDocumentId: row.profile_photo_document_id,
    selfieDocumentId: row.selfie_document_id,
    selfieReviewMode: 'manual',
    selfieAutomated: false,
    status: row.status,
    adminComments: row.admin_comments,
    reviewerId: row.reviewer_id,
    reviewedAt: row.reviewed_at,
    isFictionalDemo: row.is_fictional_demo,
    fictionalBanner: FICTIONAL_BANNER,
    updatedAt: row.updated_at,
  };
}

export function computeProfileCompletionParts({ user, identity, business, businessItems, roles }) {
  const missing = [];
  let personalScore = 0;
  const personalChecks = [
    ['display_name_or_email', Boolean(user?.display_name || user?.email)],
    ['email_verified', Boolean(user?.email_verified_at)],
    ['phone', Boolean(identity?.phone || user?.mobile)],
    ['present_address', Boolean(identity?.present_address)],
  ];
  for (const [key, ok] of personalChecks) {
    if (ok) personalScore += 1;
    else missing.push({ section: 'personal', code: key });
  }
  const personalPct = Math.round((personalScore / personalChecks.length) * 100);

  let identityScore = 0;
  const identityChecks = [
    ['legal_name', Boolean(identity?.legal_name)],
    ['dob', Boolean(identity?.date_of_birth)],
    ['nationality', Boolean(identity?.nationality)],
    ['id_type', Boolean(identity?.id_document_type)],
    ['id_number', Boolean(identity?.id_number_last4)],
    ['id_front', Boolean(identity?.id_front_document_id)],
    ['selfie', Boolean(identity?.selfie_document_id)],
    ['identity_verified', identity?.status === 'verified'],
  ];
  for (const [key, ok] of identityChecks) {
    if (ok) identityScore += 1;
    else missing.push({ section: 'identity', code: key });
  }
  const identityPct = Math.round((identityScore / identityChecks.length) * 100);

  let businessPct = 0;
  const isOwner = Array.isArray(roles) && roles.includes('project_owner');
  if (isOwner) {
    const items = businessItems || [];
    if (!items.length) {
      missing.push({ section: 'business', code: 'items_not_initialized' });
      businessPct = business?.verification_status === 'verified' ? 80 : 0;
    } else {
      const verified = items.filter((i) => i.status === 'verified').length;
      businessPct = Math.round((verified / items.length) * 100);
      for (const item of items) {
        if (item.status !== 'verified') missing.push({ section: 'business', code: item.item_code || item.itemCode });
      }
    }
  }

  const overallPct = isOwner
    ? Math.round(personalPct * 0.25 + identityPct * 0.35 + businessPct * 0.4)
    : Math.round(personalPct * 0.4 + identityPct * 0.6);

  return { personalPct, identityPct, businessPct, overallPct, missingItems: missing };
}

export function calculateDemoInvestment({ units = 3, unitPricePoisha = 8500_00, feeBps = 1500, profitBps = 2000, durationDays = 365 } = {}) {
  // integer poisha + bps only
  const investmentPoisha = units * unitPricePoisha;
  const administrationFeePoisha = Math.round((investmentPoisha * feeBps) / 10_000);
  const totalPayablePoisha = investmentPoisha + administrationFeePoisha;
  const projectedAnnualProfitPoisha = Math.round((investmentPoisha * profitBps) / 10_000);
  const dailyProjectedPoishaTimes100 = Math.round((projectedAnnualProfitPoisha * 100) / durationDays); // keep precision hint
  // exact demo: 3×8500=25500 BDT = 2,550,000 poisha; 15% fee=3825 BDT; total=29325; 20%=5100; daily ~13.97
  return {
    units,
    unitPricePoisha,
    investmentPoisha,
    administrationFeeBps: feeBps,
    administrationFeePoisha,
    totalPayablePoisha,
    projectedAnnualProfitBps: profitBps,
    projectedAnnualProfitPoisha,
    durationDays,
    dailyProjectedApproxPoisha: Math.floor(projectedAnnualProfitPoisha / durationDays),
    dailyProjectedApproxBdt: Number((projectedAnnualProfitPoisha / durationDays / 100).toFixed(2)),
    projectionsWithdrawable: false,
    disclaimer: PROJECTION_DISCLAIMER,
    demoExample: {
      bdt: {
        principal: investmentPoisha / 100,
        fee: administrationFeePoisha / 100,
        total: totalPayablePoisha / 100,
        projectedAnnual: projectedAnnualProfitPoisha / 100,
        dailyApprox: Number((projectedAnnualProfitPoisha / durationDays / 100).toFixed(2)),
      },
    },
  };
}

/**
 * @param {import('./postgres_service.js').PostgresGrowBangladeshService} proto
 */
export function attachFinalDemoMethods(proto) {
  const store = createDocumentStore();

  proto.getDocumentStore = function getDocumentStore() {
    return store;
  };

  proto.getStorageBackendInfo = function getStorageBackendInfo() {
    const backend = resolveStorageBackend();
    return {
      backend,
      privateDocsRoot: process.env.PRIVATE_DOCS_ROOT || '/tmp/grow-private-docs',
      s3Configured: Boolean(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID),
      railwayBucket: process.env.RAILWAY_BUCKET_NAME || null,
      productionBlocker:
        backend === 'local_volume'
          ? 'Managed object bucket not configured on Railway Hobby — using private local/volume abstraction. Production must use private S3-compatible storage.'
          : null,
      malwareScan: 'stub',
      fictionalBanner: FICTIONAL_BANNER,
      phoneOtpLabel: STAGING_PHONE_OTP_LABEL,
      selfieReviewMode: 'manual',
    };
  };

  proto.uploadPrivateDocument = async function uploadPrivateDocument({
    ownerUserId,
    actorId,
    subjectType,
    subjectId = null,
    documentKind,
    filename,
    mimeType,
    base64Content,
    requestContext = {},
  }) {
    if (!base64Content) throw new DomainError('DOCUMENT_CONTENT_REQUIRED', 'base64Content is required', 400);
    const buffer = Buffer.from(String(base64Content), 'base64');
    const { sanitizedFilename, ext } = assertAllowedUpload({
      filename,
      mimeType,
      byteSize: buffer.length,
    });
    const scan = runMalwareScanStub({ mimeType });
    if (scan.status === 'stub_rejected') {
      throw new DomainError('DOCUMENT_SCAN_REJECTED', scan.note, 400);
    }
    const storageKey = newStorageKey({ ownerUserId, kind: documentKind, ext });
    const put = await store.putObject({ storageKey, buffer });
    const hash = sha256Buffer(buffer);

    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO private_documents(
           owner_user_id, subject_type, subject_id, document_kind, original_filename, sanitized_filename,
           mime_type, byte_size, content_sha256, storage_backend, storage_key, is_fictional_demo,
           fictional_banner, malware_scan_status, review_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,$13,'submitted')
         RETURNING *`,
        [
          ownerUserId,
          subjectType,
          subjectId,
          documentKind,
          filename,
          sanitizedFilename,
          mimeType,
          buffer.length,
          hash,
          put.backend || store.backend,
          storageKey,
          FICTIONAL_BANNER,
          scan.status,
        ],
      );
      const doc = inserted.rows[0];
      await client.query(
        `INSERT INTO private_document_access_logs(document_id, actor_id, action, ip_address, user_agent)
         VALUES ($1,$2,'upload',$3::inet,$4)`,
        [doc.id, actorId, requestContext.ip || null, requestContext.userAgent || null],
      );
      await audit(client, actorId, 'document.uploaded', 'private_document', doc.id, mapDoc(doc), {
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
      });
      return mapDoc(doc);
    });
  };

  proto.getPrivateDocumentMeta = async function getPrivateDocumentMeta(documentId, actorId, { roles = [], requestContext = {} } = {}) {
    const result = await this.pool.query('SELECT * FROM private_documents WHERE id=$1', [documentId]);
    if (!result.rowCount) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document not found', 404);
    const doc = result.rows[0];
    const isOwner = doc.owner_user_id === actorId;
    const isStaff = roles.some((r) => ['super_admin', 'compliance_reviewer', 'finance_officer', 'auditor', 'support'].includes(r));
    let investorPublishedPhoto = false;
    if (!isOwner && !isStaff && doc.document_kind === 'project_photo' && doc.subject_type === 'project' && doc.subject_id) {
      const pub = await this.pool.query(
        `SELECT p.status, p.photo_document_ids
         FROM projects p
         WHERE p.id=$1`,
        [doc.subject_id],
      );
      if (pub.rowCount) {
        const ids = Array.isArray(pub.rows[0].photo_document_ids)
          ? pub.rows[0].photo_document_ids
          : [];
        const publishedOk = ['published', 'funding_closed', 'active', 'completed'].includes(pub.rows[0].status);
        investorPublishedPhoto = publishedOk && ids.map(String).includes(String(documentId));
      }
    }
    if (!isOwner && !isStaff && !investorPublishedPhoto) {
      throw new DomainError('FORBIDDEN', 'Not allowed to view this document', 403);
    }
    await this.pool.query(
      `INSERT INTO private_document_access_logs(document_id, actor_id, action, ip_address, user_agent)
       VALUES ($1,$2,'view_meta',$3::inet,$4)`,
      [documentId, actorId, requestContext.ip || null, requestContext.userAgent || null],
    );
    return mapDoc(doc);
  };

  proto.createDocumentSignedUrl = async function createDocumentSignedUrl(documentId, actorId, { roles = [], requestContext = {} } = {}) {
    const meta = await this.getPrivateDocumentMeta(documentId, actorId, { roles, requestContext });
    const signed = store.createSignedUrl({ documentId, actorId, ttlSeconds: 120 });
    await this.pool.query(
      `INSERT INTO private_document_access_logs(document_id, actor_id, action, ip_address, user_agent)
       VALUES ($1,$2,'signed_url',$3::inet,$4)`,
      [documentId, actorId, requestContext.ip || null, requestContext.userAgent || null],
    );
    return { ...signed, document: meta };
  };

  proto.readDocumentContent = async function readDocumentContent(documentId, { actorId, exp, sig }) {
    store.verifySignedUrl({ documentId, actorId, exp, sig });
    const result = await this.pool.query('SELECT * FROM private_documents WHERE id=$1', [documentId]);
    if (!result.rowCount) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document not found', 404);
    const doc = result.rows[0];
    const bytes = await store.getObject(doc.storage_key);
    await this.pool.query(
      `INSERT INTO private_document_access_logs(document_id, actor_id, action)
       VALUES ($1,$2,'download')`,
      [documentId, actorId],
    );
    return { document: mapDoc(doc), bytes };
  };

  proto.listAdminUsers = async function listAdminUsers({
    q = '',
    role = null,
    lifecycle = null,
    verificationStatus = null,
    limit = 50,
    offset = 0,
  } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const params = [];
    // Staging admin console lists users; optional filters below.
    const clauses = [];
    if (q) {
      params.push(`%${String(q).toLowerCase()}%`);
      clauses.push(`(lower(u.email) LIKE $${params.length} OR lower(coalesce(u.display_name,'')) LIKE $${params.length} OR coalesce(u.mobile,'') LIKE $${params.length} OR lower(coalesce(iv.legal_name,'')) LIKE $${params.length})`);
    }
    if (role) {
      params.push(role);
      clauses.push(`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_code=$${params.length})`);
    }
    if (lifecycle) {
      params.push(lifecycle);
      clauses.push(`u.account_lifecycle=$${params.length}`);
    }
    if (verificationStatus) {
      params.push(verificationStatus);
      clauses.push(`coalesce(iv.status,'not_provided')=$${params.length}`);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(lim, off);
    const result = await this.pool.query(
      `SELECT u.id, u.email, u.mobile, u.status, u.account_lifecycle, u.display_name, u.created_at,
              u.email_verified_at, u.phone_verified_at, u.staging_only,
              iv.status AS identity_status, iv.legal_name,
              pc.overall_pct, pc.personal_pct, pc.identity_pct, pc.business_pct,
              array_remove(array_agg(DISTINCT ur.role_code), NULL) AS roles
       FROM users u
       LEFT JOIN identity_verifications iv ON iv.user_id=u.id
       LEFT JOIN profile_completion pc ON pc.user_id=u.id
       LEFT JOIN user_roles ur ON ur.user_id=u.id
       ${whereSql}
       GROUP BY u.id, iv.status, iv.legal_name, pc.overall_pct, pc.personal_pct, pc.identity_pct, pc.business_pct
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: result.rows.map((r) => ({
        id: r.id,
        email: r.email,
        mobile: r.mobile,
        status: r.status,
        accountLifecycle: r.account_lifecycle,
        displayName: r.display_name || r.legal_name || null,
        legalName: r.legal_name,
        identityStatus: r.identity_status || 'not_provided',
        emailVerifiedAt: r.email_verified_at,
        phoneVerifiedAt: r.phone_verified_at,
        phoneOtpLabel: STAGING_PHONE_OTP_LABEL,
        stagingOnly: r.staging_only,
        roles: r.roles || [],
        profileCompletion: {
          overallPct: r.overall_pct ?? 0,
          personalPct: r.personal_pct ?? 0,
          identityPct: r.identity_pct ?? 0,
          businessPct: r.business_pct ?? 0,
        },
        createdAt: r.created_at,
      })),
      limit: lim,
      offset: off,
    };
  };

  proto.getAdminUserProfile = async function getAdminUserProfile(userId) {
    const userResult = await this.pool.query(
      `SELECT u.*, array_remove(array_agg(DISTINCT ur.role_code), NULL) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id=u.id
       WHERE u.id=$1
       GROUP BY u.id`,
      [userId],
    );
    if (!userResult.rowCount) throw new DomainError('USER_NOT_FOUND', 'User not found', 404);
    const u = userResult.rows[0];
    const identity = await this.pool.query('SELECT * FROM identity_verifications WHERE user_id=$1', [userId]);
    const completion = await this.recomputeProfileCompletion(userId);
    const history = await this.pool.query(
      `SELECT * FROM identity_verification_history WHERE user_id=$1 ORDER BY occurred_at DESC LIMIT 50`,
      [userId],
    );
    const related = await this.pool.query(
      `SELECT id, relationship, full_name, is_minor, is_fictional_demo, created_at FROM related_persons WHERE owner_user_id=$1`,
      [userId],
    );
    const businesses = await this.pool.query(`SELECT * FROM businesses WHERE owner_user_id=$1`, [userId]);
    const projects = await this.pool.query(
      `SELECT p.id, p.title, p.status, p.slug, p.total_units, p.active_units, p.unit_investment_poisha
       FROM projects p
       JOIN businesses b ON b.id=p.business_id
       WHERE b.owner_user_id=$1
       ORDER BY p.created_at DESC LIMIT 50`,
      [userId],
    );
    const applications = await this.pool.query(
      `SELECT id, project_id, units, status, total_payable_poisha, created_at
       FROM investment_applications WHERE investor_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    const payments = await this.pool.query(
      `SELECT p.id, p.status, p.amount_poisha, p.method, p.submitted_at
       FROM payments p
       JOIN investment_applications a ON a.id=p.application_id
       WHERE a.investor_id=$1 ORDER BY p.submitted_at DESC LIMIT 50`,
      [userId],
    );
    const allocations = await this.pool.query(
      `SELECT id, project_id, units, investment_poisha, status, activated_at
       FROM allocations WHERE investor_id=$1 ORDER BY activated_at DESC LIMIT 50`,
      [userId],
    );
    const agreements = await this.pool.query(
      `SELECT id, agreement_number, status, email_delivery_status, units, total_payable_poisha, created_at
       FROM investment_agreements WHERE investor_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    const exits = await this.pool.query(
      `SELECT id, status, allocation_id, created_at FROM exit_requests WHERE investor_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    ).catch(() => ({ rows: [] }));
    const audits = await this.pool.query(
      `SELECT id, action, subject_type, subject_id, reason, occurred_at
       FROM audit_logs
       WHERE actor_id=$1 OR subject_id=$1
       ORDER BY occurred_at DESC LIMIT 100`,
      [userId],
    );

    return {
      user: {
        id: u.id,
        email: u.email,
        mobile: u.mobile,
        status: u.status,
        accountLifecycle: u.account_lifecycle,
        lifecycleReason: u.lifecycle_reason,
        displayName: u.display_name,
        roles: u.roles || [],
        emailVerifiedAt: u.email_verified_at,
        phoneVerifiedAt: u.phone_verified_at,
        phoneOtpLabel: STAGING_PHONE_OTP_LABEL,
        stagingOnly: u.staging_only,
        createdAt: u.created_at,
      },
      identity: mapIdentity(identity.rows[0]),
      profileCompletion: completion,
      identityHistory: history.rows,
      relatedPersonsSummary: related.rows,
      businesses: businesses.rows,
      linked: {
        projects: projects.rows,
        applications: applications.rows,
        payments: payments.rows,
        allocations: allocations.rows,
        agreements: agreements.rows,
        exits: exits.rows,
      },
      auditLogs: audits.rows,
      hardDeleteBlocked: true,
      deletionPolicy:
        'Super Admin must deactivate/suspend/archive. NEVER permanently delete users connected to applications, payments, agreements, allocations, or audit records.',
    };
  };

  proto.updateAdminUserFields = async function updateAdminUserFields(userId, actorId, patch = {}, requestContext = {}) {
    const allowed = ['display_name', 'mobile'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        params.push(patch[key]);
        sets.push(`${key}=$${params.length}`);
      }
    }
    if (!sets.length) throw new DomainError('NO_FIELDS', 'No permitted fields to update', 400);
    params.push(userId);
    return withTransaction(this.pool, async (client) => {
      const before = await client.query('SELECT id, display_name, mobile FROM users WHERE id=$1', [userId]);
      if (!before.rowCount) throw new DomainError('USER_NOT_FOUND', 'User not found', 404);
      const updated = await client.query(
        `UPDATE users SET ${sets.join(', ')}, updated_at=now() WHERE id=$${params.length} RETURNING id, display_name, mobile, email`,
        params,
      );
      await audit(client, actorId, 'user.profile_edited', 'user', userId, updated.rows[0], {
        before: before.rows[0],
        after: updated.rows[0],
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
        reason: patch.reason || null,
      });
      return updated.rows[0];
    });
  };

  proto.setUserLifecycle = async function setUserLifecycle(userId, actorId, { lifecycle, reason }, requestContext = {}) {
    if (!LIFECYCLE_STATUSES.has(lifecycle)) {
      throw new DomainError('INVALID_LIFECYCLE', `Invalid lifecycle: ${lifecycle}`, 400);
    }
    if (!reason || String(reason).trim().length < 3) {
      throw new DomainError('REASON_REQUIRED', 'Reason is required for lifecycle changes', 400);
    }
    if (lifecycle === 'archived' || lifecycle === 'deactivated' || lifecycle === 'suspended' || lifecycle === 'paused') {
      // never hard-delete; lifecycle only
    }
    return withTransaction(this.pool, async (client) => {
      const beforeRes = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]);
      if (!beforeRes.rowCount) throw new DomainError('USER_NOT_FOUND', 'User not found', 404);
      const before = beforeRes.rows[0];
      const newStatus = LIFECYCLE_TO_USER_STATUS[lifecycle];
      const updated = await client.query(
        `UPDATE users
         SET account_lifecycle=$2, lifecycle_reason=$3, lifecycle_changed_at=now(),
             lifecycle_changed_by=$4, status=$5::user_status, updated_at=now()
         WHERE id=$1
         RETURNING *`,
        [userId, lifecycle, reason.trim(), actorId, newStatus],
      );
      const auditId = await audit(
        client,
        actorId,
        'user.lifecycle_changed',
        'user',
        userId,
        {
          previousLifecycle: before.account_lifecycle,
          newLifecycle: lifecycle,
          previousStatus: before.status,
          newStatus,
        },
        {
          reason: reason.trim(),
          before: { status: before.status, accountLifecycle: before.account_lifecycle },
          after: { status: newStatus, accountLifecycle: lifecycle },
          ip: requestContext.ip,
          userAgent: requestContext.userAgent,
        },
      );
      return {
        userId,
        previousLifecycle: before.account_lifecycle,
        newLifecycle: lifecycle,
        previousStatus: before.status,
        newStatus,
        reason: reason.trim(),
        auditEventId: auditId,
        hardDeleted: false,
      };
    });
  };

  proto.tryHardDeleteUnusedStagingUser = async function tryHardDeleteUnusedStagingUser(userId, actorId, requestContext = {}) {
    return withTransaction(this.pool, async (client) => {
      const user = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]);
      if (!user.rowCount) throw new DomainError('USER_NOT_FOUND', 'User not found', 404);
      const deps = await client.query(
        `SELECT
           (SELECT count(*) FROM investment_applications WHERE investor_id=$1) AS apps,
           (SELECT count(*) FROM payments p JOIN investment_applications a ON a.id=p.application_id WHERE a.investor_id=$1) AS payments,
           (SELECT count(*) FROM allocations WHERE investor_id=$1) AS allocations,
           (SELECT count(*) FROM investment_agreements WHERE investor_id=$1) AS agreements,
           (SELECT count(*) FROM audit_logs WHERE actor_id=$1 OR subject_id=$1) AS audits,
           (SELECT count(*) FROM businesses WHERE owner_user_id=$1) AS businesses,
           (SELECT count(*) FROM projects p JOIN businesses b ON b.id=p.business_id WHERE b.owner_user_id=$1) AS projects`,
        [userId],
      );
      const d = deps.rows[0];
      const total =
        Number(d.apps) + Number(d.payments) + Number(d.allocations) + Number(d.agreements) +
        Number(d.audits) + Number(d.businesses) + Number(d.projects);
      if (total > 0) {
        throw new DomainError(
          'HARD_DELETE_BLOCKED',
          'User has dependencies — deactivate/suspend/archive instead. Hard delete only for unused staging accounts with ZERO dependencies.',
          409,
        );
      }
      await client.query('DELETE FROM user_roles WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM refresh_tokens WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM users WHERE id=$1', [userId]);
      await audit(client, actorId, 'user.hard_deleted_unused_staging', 'user', userId, { email: user.rows[0].email }, {
        reason: 'zero dependencies staging cleanup',
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
      });
      return { deleted: true, userId };
    });
  };

  proto.upsertIdentityVerification = async function upsertIdentityVerification(userId, actorId, input = {}, requestContext = {}) {
    const {
      legalName, dateOfBirth, nationality, phone, presentAddress, permanentAddress,
      idDocumentType, idNumber, idFrontDocumentId, idBackDocumentId,
      profilePhotoDocumentId, selfieDocumentId, submit = false,
    } = input;

    let idCipher = null;
    let idLast4 = null;
    if (idNumber) {
      idCipher = encryptField(String(idNumber));
      idLast4 = last4Digits(String(idNumber));
    }

    return withTransaction(this.pool, async (client) => {
      const existing = await client.query('SELECT * FROM identity_verifications WHERE user_id=$1 FOR UPDATE', [userId]);
      const prev = existing.rows[0];
      const nextStatus = submit ? 'submitted' : (prev?.status && prev.status !== 'not_provided' ? prev.status : 'not_provided');
      const row = await client.query(
        `INSERT INTO identity_verifications(
           user_id, legal_name, date_of_birth, nationality, phone, phone_verification_label,
           present_address, permanent_address, id_document_type, id_number_ciphertext, id_number_last4,
           id_front_document_id, id_back_document_id, profile_photo_document_id, selfie_document_id,
           selfie_review_mode, status, is_fictional_demo
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'manual',$16,true)
         ON CONFLICT (user_id) DO UPDATE SET
           legal_name=COALESCE(EXCLUDED.legal_name, identity_verifications.legal_name),
           date_of_birth=COALESCE(EXCLUDED.date_of_birth, identity_verifications.date_of_birth),
           nationality=COALESCE(EXCLUDED.nationality, identity_verifications.nationality),
           phone=COALESCE(EXCLUDED.phone, identity_verifications.phone),
           present_address=COALESCE(EXCLUDED.present_address, identity_verifications.present_address),
           permanent_address=COALESCE(EXCLUDED.permanent_address, identity_verifications.permanent_address),
           id_document_type=COALESCE(EXCLUDED.id_document_type, identity_verifications.id_document_type),
           id_number_ciphertext=COALESCE(EXCLUDED.id_number_ciphertext, identity_verifications.id_number_ciphertext),
           id_number_last4=COALESCE(EXCLUDED.id_number_last4, identity_verifications.id_number_last4),
           id_front_document_id=COALESCE(EXCLUDED.id_front_document_id, identity_verifications.id_front_document_id),
           id_back_document_id=COALESCE(EXCLUDED.id_back_document_id, identity_verifications.id_back_document_id),
           profile_photo_document_id=COALESCE(EXCLUDED.profile_photo_document_id, identity_verifications.profile_photo_document_id),
           selfie_document_id=COALESCE(EXCLUDED.selfie_document_id, identity_verifications.selfie_document_id),
           status=CASE WHEN $17 THEN 'submitted' ELSE identity_verifications.status END,
           updated_at=now()
         RETURNING *`,
        [
          userId,
          legalName || null,
          dateOfBirth || null,
          nationality || null,
          phone || null,
          STAGING_PHONE_OTP_LABEL,
          presentAddress || null,
          permanentAddress || null,
          idDocumentType || null,
          idCipher,
          idLast4,
          idFrontDocumentId || null,
          idBackDocumentId || null,
          profilePhotoDocumentId || null,
          selfieDocumentId || null,
          nextStatus,
          submit,
        ],
      );
      if (submit) {
        await client.query(
          `INSERT INTO identity_verification_history(user_id, previous_status, new_status, reason, actor_id)
           VALUES ($1,$2,'submitted',$3,$4)`,
          [userId, prev?.status || 'not_provided', 'User submitted identity for review', actorId],
        );
      }
      await audit(client, actorId, submit ? 'identity.submitted' : 'identity.updated', 'user', userId, mapIdentity(row.rows[0]), {
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
      });
      await this._recomputeProfileCompletionTx(client, userId);
      return mapIdentity(row.rows[0]);
    });
  };

  proto.reviewIdentityVerification = async function reviewIdentityVerification(
    userId,
    actorId,
    { status, comments },
    requestContext = {},
  ) {
    if (!VERIFICATION_STATUSES.has(status) || status === 'not_provided') {
      throw new DomainError('INVALID_STATUS', 'Invalid review status', 400);
    }
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query('SELECT * FROM identity_verifications WHERE user_id=$1 FOR UPDATE', [userId]);
      if (!existing.rowCount) throw new DomainError('IDENTITY_NOT_FOUND', 'Identity verification not found', 404);
      const prev = existing.rows[0];
      const updated = await client.query(
        `UPDATE identity_verifications
         SET status=$2, admin_comments=$3, reviewer_id=$4, reviewed_at=now(), updated_at=now()
         WHERE user_id=$1 RETURNING *`,
        [userId, status, comments || null, actorId],
      );
      const auditId = await audit(
        client,
        actorId,
        'identity.review',
        'user',
        userId,
        { previousStatus: prev.status, newStatus: status, comments },
        {
          reason: comments || status,
          before: { status: prev.status },
          after: { status },
          ip: requestContext.ip,
          userAgent: requestContext.userAgent,
        },
      );
      await client.query(
        `INSERT INTO identity_verification_history(user_id, previous_status, new_status, reason, actor_id, audit_event_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId, prev.status, status, comments || null, actorId, auditId],
      );
      await this._recomputeProfileCompletionTx(client, userId);
      return { identity: mapIdentity(updated.rows[0]), auditEventId: auditId };
    });
  };

  proto.getMyIdentity = async function getMyIdentity(userId) {
    const result = await this.pool.query('SELECT * FROM identity_verifications WHERE user_id=$1', [userId]);
    if (!result.rowCount) {
      return {
        userId,
        status: 'not_provided',
        phoneVerificationLabel: STAGING_PHONE_OTP_LABEL,
        selfieReviewMode: 'manual',
        selfieAutomated: false,
        isFictionalDemo: true,
        fictionalBanner: FICTIONAL_BANNER,
      };
    }
    return mapIdentity(result.rows[0]);
  };

  proto.listRelatedPersons = async function listRelatedPersons(ownerUserId, actorId, { roles = [] } = {}) {
    const isOwner = ownerUserId === actorId;
    const isCompliance = roles.some((r) => ['super_admin', 'compliance_reviewer', 'auditor'].includes(r));
    if (!isOwner && !isCompliance) {
      throw new DomainError('FORBIDDEN', 'Related persons are own-records or compliance-only', 403);
    }
    // Owners must never see investor family via this path when actor is project_owner browsing others — blocked above.
    const result = await this.pool.query(
      `SELECT id, owner_user_id, relationship, full_name, date_of_birth, is_minor, nationality, phone, email,
              present_address, id_document_type, id_number_last4, id_document_id, notes,
              is_fictional_demo, fictional_banner, created_at, updated_at
       FROM related_persons WHERE owner_user_id=$1 ORDER BY created_at`,
      [ownerUserId],
    );
    await this.pool.query(
      `INSERT INTO audit_logs(actor_id, action, subject_type, subject_id, after_json)
       VALUES ($1,'related_persons.accessed','user',$2,$3::jsonb)`,
      [actorId, ownerUserId, JSON.stringify({ count: result.rowCount })],
    ).catch(() => {});
    return {
      items: result.rows.map((r) => ({
        id: r.id,
        ownerUserId: r.owner_user_id,
        relationship: r.relationship,
        fullName: r.full_name,
        dateOfBirth: r.date_of_birth,
        isMinor: r.is_minor,
        nationality: r.nationality,
        phone: r.phone,
        email: r.email,
        presentAddress: r.present_address,
        idDocumentType: r.id_document_type,
        idNumberMasked: r.id_number_last4 ? `****${r.id_number_last4}` : null,
        idDocumentId: r.id_document_id,
        notes: r.notes,
        isFictionalDemo: r.is_fictional_demo,
        fictionalBanner: r.fictional_banner,
        minorIdDocsMandatory: false,
      })),
    };
  };

  proto.createRelatedPerson = async function createRelatedPerson(ownerUserId, actorId, input = {}, requestContext = {}) {
    if (ownerUserId !== actorId) {
      throw new DomainError('FORBIDDEN', 'Can only create related persons on own profile', 403);
    }
    const {
      relationship, fullName, dateOfBirth, isMinor = false, nationality, phone, email,
      presentAddress, idDocumentType, idNumber, notes,
    } = input;
    if (!relationship || !fullName) throw new DomainError('INVALID_RELATED_PERSON', 'relationship and fullName required', 400);
    let cipher = null;
    let last4 = null;
    if (idNumber) {
      cipher = encryptField(String(idNumber));
      last4 = maskLast4(String(idNumber).replace(/\D/g, '') || String(idNumber));
    }
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO related_persons(
           owner_user_id, relationship, full_name, date_of_birth, is_minor, nationality, phone, email,
           present_address, id_document_type, id_number_ciphertext, id_number_last4, notes,
           is_fictional_demo, fictional_banner
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14)
         RETURNING *`,
        [
          ownerUserId, relationship, fullName, dateOfBirth || null, Boolean(isMinor),
          nationality || null, phone || null, email || null, presentAddress || null,
          idDocumentType || (isMinor ? 'none' : null), cipher, last4, notes || null, FICTIONAL_BANNER,
        ],
      );
      await audit(client, actorId, 'related_person.created', 'related_person', inserted.rows[0].id, { relationship, fullName }, {
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
      });
      return inserted.rows[0];
    });
  };

  proto._recomputeProfileCompletionTx = async function _recomputeProfileCompletionTx(client, userId) {
    const userRes = await client.query(
      `SELECT u.*, array_remove(array_agg(DISTINCT ur.role_code), NULL) AS roles
       FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id
       WHERE u.id=$1 GROUP BY u.id`,
      [userId],
    );
    const user = userRes.rows[0];
    const identity = (await client.query('SELECT * FROM identity_verifications WHERE user_id=$1', [userId])).rows[0];
    const business = (await client.query('SELECT * FROM businesses WHERE owner_user_id=$1 LIMIT 1', [userId])).rows[0];
    let businessItems = [];
    if (business) {
      businessItems = (await client.query('SELECT * FROM business_verification_items WHERE business_id=$1', [business.id])).rows;
    }
    const parts = computeProfileCompletionParts({
      user,
      identity,
      business,
      businessItems,
      roles: user?.roles || [],
    });
    await client.query(
      `INSERT INTO profile_completion(user_id, personal_pct, identity_pct, business_pct, overall_pct, missing_items, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,now())
       ON CONFLICT (user_id) DO UPDATE SET
         personal_pct=EXCLUDED.personal_pct,
         identity_pct=EXCLUDED.identity_pct,
         business_pct=EXCLUDED.business_pct,
         overall_pct=EXCLUDED.overall_pct,
         missing_items=EXCLUDED.missing_items,
         computed_at=now()`,
      [userId, parts.personalPct, parts.identityPct, parts.businessPct, parts.overallPct, JSON.stringify(parts.missingItems)],
    );
    return parts;
  };

  proto.recomputeProfileCompletion = async function recomputeProfileCompletion(userId) {
    return withTransaction(this.pool, async (client) => this._recomputeProfileCompletionTx(client, userId));
  };

  proto.getProfileCompletion = async function getProfileCompletion(userId) {
    const existing = await this.pool.query('SELECT * FROM profile_completion WHERE user_id=$1', [userId]);
    if (!existing.rowCount) return this.recomputeProfileCompletion(userId);
    const r = existing.rows[0];
    return {
      personalPct: r.personal_pct,
      identityPct: r.identity_pct,
      businessPct: r.business_pct,
      overallPct: r.overall_pct,
      missingItems: r.missing_items,
      computedAt: r.computed_at,
    };
  };

  proto.ensureBusinessVerificationItems = async function ensureBusinessVerificationItems(businessId) {
    for (const def of BUSINESS_ITEM_DEFS) {
      await this.pool.query(
        `INSERT INTO business_verification_items(business_id, item_code, label, status, is_fictional_demo)
         VALUES ($1,$2,$3,'not_provided',true)
         ON CONFLICT (business_id, item_code) DO NOTHING`,
        [businessId, def.code, def.label],
      );
    }
    return this.listBusinessVerificationItems(businessId);
  };

  proto.listBusinessVerificationItems = async function listBusinessVerificationItems(businessId) {
    const result = await this.pool.query(
      `SELECT * FROM business_verification_items WHERE business_id=$1 ORDER BY item_code`,
      [businessId],
    );
    return result.rows.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      itemCode: r.item_code,
      label: r.label,
      valueText: r.value_text,
      documentId: r.document_id,
      status: r.status,
      adminNote: r.admin_note,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      isFictionalDemo: r.is_fictional_demo,
    }));
  };

  proto.updateBusinessVerificationItem = async function updateBusinessVerificationItem(
    businessId,
    itemCode,
    actorId,
    { valueText, documentId, status, adminNote },
    requestContext = {},
  ) {
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE business_verification_items
         SET value_text=COALESCE($3, value_text),
             document_id=COALESCE($4, document_id),
             status=COALESCE($5, status),
             admin_note=COALESCE($6, admin_note),
             reviewed_by=CASE WHEN $5 IS NOT NULL THEN $7 ELSE reviewed_by END,
             reviewed_at=CASE WHEN $5 IS NOT NULL THEN now() ELSE reviewed_at END,
             updated_at=now()
         WHERE business_id=$1 AND item_code=$2
         RETURNING *`,
        [businessId, itemCode, valueText ?? null, documentId ?? null, status ?? null, adminNote ?? null, actorId],
      );
      if (!updated.rowCount) throw new DomainError('ITEM_NOT_FOUND', 'Business verification item not found', 404);
      const items = (await client.query('SELECT * FROM business_verification_items WHERE business_id=$1', [businessId])).rows;
      const verified = items.filter((i) => i.status === 'verified').length;
      const pct = Math.round((verified / Math.max(items.length, 1)) * 100);
      await client.query(
        `UPDATE businesses SET business_verification_pct=$2 WHERE id=$1`,
        [businessId, pct],
      );
      await audit(client, actorId, 'business_item.updated', 'business', businessId, { itemCode, status, pct }, {
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
        reason: adminNote || null,
      });
      return { item: updated.rows[0], businessVerificationPct: pct };
    });
  };

  proto.approveBusinessProfile = async function approveBusinessProfile(businessId, actorId, note, requestContext = {}) {
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE businesses
         SET verification_status='verified', business_status='verified',
             admin_review_note=$2, reviewed_by=$3, reviewed_at=now()
         WHERE id=$1 RETURNING *`,
        [businessId, note || null, actorId],
      );
      if (!updated.rowCount) throw new DomainError('BUSINESS_NOT_FOUND', 'Business not found', 404);
      await audit(client, actorId, 'business.verified', 'business', businessId, { note }, {
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
        reason: note || 'business profile approved',
      });
      const ownerId = updated.rows[0].owner_user_id;
      await this._recomputeProfileCompletionTx(client, ownerId);
      return updated.rows[0];
    });
  };

  proto.generateAgreementNumber = function generateAgreementNumber() {
    const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8).toUpperCase();
    return `GB-DEMO-${ts}-${rand}`;
  };

  proto.createFinalAgreementForAllocation = async function createFinalAgreementForAllocation(client, {
    application, allocation, project, investorId, actorId, requestContext = {},
  }) {
    const agreementNumber = this.generateAgreementNumber();
    const acceptance = await client.query(
      `SELECT * FROM agreement_acceptances WHERE application_id=$1`,
      [application.id],
    );
    const snapshot = {
      agreementNumber,
      fictionalBanner: FICTIONAL_BANNER,
      investorId,
      projectId: project.id,
      projectTitle: project.title,
      units: allocation.units,
      investmentPoisha: allocation.investment_poisha,
      administrationFeePoisha: application.administration_fee_poisha,
      totalPayablePoisha: application.total_payable_poisha,
      termsVersion: application.terms_version,
      acceptanceAt: acceptance.rows[0]?.accepted_at || null,
      acceptanceIp: acceptance.rows[0]?.accepted_from_ip || null,
      deviceMeta: acceptance.rows[0]?.device_meta || null,
      projectionDisclaimer: PROJECTION_DISCLAIMER,
      selfieReviewMode: 'manual',
      phoneOtpLabel: STAGING_PHONE_OTP_LABEL,
    };
    const pdf = buildFictionalPlaceholderPdf({
      title: `Investment Agreement ${agreementNumber}`,
      bodyLines: [
        `Project: ${project.title}`,
        `Units: ${allocation.units}`,
        `Investment poisha: ${allocation.investment_poisha}`,
        `Total payable poisha: ${application.total_payable_poisha}`,
        FICTIONAL_BANNER,
      ],
    });
    const storageKey = newStorageKey({ ownerUserId: investorId, kind: 'agreement', ext: '.pdf' });
    await store.putObject({ storageKey, buffer: pdf });
    const doc = await client.query(
      `INSERT INTO private_documents(
         owner_user_id, subject_type, subject_id, document_kind, original_filename, sanitized_filename,
         mime_type, byte_size, content_sha256, storage_backend, storage_key, is_fictional_demo,
         fictional_banner, malware_scan_status, review_status
       ) VALUES ($1,'agreement',$2,'investment_agreement',$3,$3,'application/pdf',$4,$5,$6,$7,true,$8,'stub_clean','verified')
       RETURNING *`,
      [
        investorId,
        allocation.id,
        `${agreementNumber}.pdf`,
        pdf.length,
        sha256Buffer(pdf),
        store.backend,
        storageKey,
        FICTIONAL_BANNER,
      ],
    );
    const projected = Math.round((Number(allocation.investment_poisha) * Number(allocation.target_profit_bps)) / 10_000);
    const inserted = await client.query(
      `INSERT INTO investment_agreements(
         agreement_number, application_id, allocation_id, investor_id, project_id, terms_version,
         acceptance_id, acceptance_snapshot, pdf_document_id, units, investment_poisha,
         administration_fee_poisha, total_payable_poisha, projected_annual_profit_poisha,
         status, email_delivery_status, email_delivery_note, is_fictional_demo, fictional_banner
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,'final','recorded_memory',$15,true,$16)
       ON CONFLICT (application_id) DO UPDATE SET
         allocation_id=EXCLUDED.allocation_id,
         pdf_document_id=EXCLUDED.pdf_document_id,
         status='final',
         updated_at=now()
       RETURNING *`,
      [
        agreementNumber,
        application.id,
        allocation.id,
        investorId,
        project.id,
        application.terms_version,
        acceptance.rows[0]?.id || null,
        JSON.stringify(snapshot),
        doc.rows[0].id,
        allocation.units,
        allocation.investment_poisha,
        application.administration_fee_poisha,
        application.total_payable_poisha,
        projected,
        'SMTP unset — delivery recorded in memory/DB only (staging adapter)',
        FICTIONAL_BANNER,
      ],
    );
    await audit(client, actorId || investorId, 'agreement.finalized', 'investment_agreement', inserted.rows[0].id, {
      agreementNumber,
      allocationId: allocation.id,
    }, { ip: requestContext.ip, userAgent: requestContext.userAgent });
    if (typeof this.finalizeProjectInvestmentAgreement === 'function') {
      await this.finalizeProjectInvestmentAgreement(client, {
        applicationId: application.id,
        allocationId: allocation.id,
        investorId,
      });
    }
    return inserted.rows[0];
  };

  proto.getMyAgreements = async function getMyAgreements(investorId) {
    const result = await this.pool.query(
      `SELECT a.*, p.title AS project_title
       FROM investment_agreements a
       JOIN projects p ON p.id=a.project_id
       WHERE a.investor_id=$1
       ORDER BY a.created_at DESC`,
      [investorId],
    );
    return {
      items: result.rows.map((r) => ({
        id: r.id,
        agreementNumber: r.agreement_number,
        projectId: r.project_id,
        projectTitle: r.project_title,
        units: r.units,
        investmentPoisha: Number(r.investment_poisha),
        administrationFeePoisha: Number(r.administration_fee_poisha),
        totalPayablePoisha: Number(r.total_payable_poisha),
        projectedAnnualProfitPoisha: Number(r.projected_annual_profit_poisha || 0),
        status: r.status,
        emailDeliveryStatus: r.email_delivery_status,
        pdfDocumentId: r.pdf_document_id,
        isFictionalDemo: r.is_fictional_demo,
        fictionalBanner: r.fictional_banner,
        createdAt: r.created_at,
      })),
    };
  };

  proto.resendAgreementEmail = async function resendAgreementEmail(agreementId, actorId, requestContext = {}) {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query('SELECT * FROM investment_agreements WHERE id=$1 FOR UPDATE', [agreementId]);
      if (!result.rowCount) throw new DomainError('AGREEMENT_NOT_FOUND', 'Agreement not found', 404);
      const updated = await client.query(
        `UPDATE investment_agreements
         SET email_delivery_status='resend_queued', email_delivery_note=$2, emailed_at=now(), updated_at=now()
         WHERE id=$1 RETURNING *`,
        [agreementId, 'Staging adapter resend queued — SMTP may be unset; status recorded only'],
      );
      await audit(client, actorId, 'agreement.email_resend', 'investment_agreement', agreementId, { status: 'resend_queued' }, {
        ip: requestContext.ip,
        userAgent: requestContext.userAgent,
      });
      return updated.rows[0];
    });
  };

  proto.getDemoCalcReport = function getDemoCalcReport() {
    return calculateDemoInvestment();
  };
}
