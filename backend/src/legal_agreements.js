/**
 * Invest in Bd — Legal documents + agreement acceptance.
 * Temporary drafts only; block production while legal_review_status != approved.
 */
import { createHash } from 'node:crypto';
import { DomainError } from './domain.js';
import { ROLES } from './roles.js';
import {
  DRAFT_BANNER,
  LANGUAGE_PRECEDENCE,
  COMPANY_PLACEHOLDERS,
  TEMPORARY_DRAFTS,
} from './legal/draft_bodies.js';

export { DRAFT_BANNER, LANGUAGE_PRECEDENCE, COMPANY_PLACEHOLDERS, TEMPORARY_DRAFTS };

const DOC_TYPES = Object.freeze([
  'investor_agreement',
  'project_owner_agreement',
  'project_investment_agreement_template',
  'privacy_notice',
]);

function contentHash(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function normalizeCtx(requestContext = {}) {
  return {
    ip: requestContext.ip || null,
    userAgent: requestContext.userAgent || null,
  };
}

async function writeLegalAudit(client, { documentId, versionId, actorId, action, before, after, note }) {
  await client.query(
    `INSERT INTO legal_document_audit(document_id, version_id, actor_id, action, before_json, after_json, note)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [
      documentId,
      versionId || null,
      actorId || null,
      action,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      note || null,
    ],
  );
}

function mapVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    documentType: row.document_type || row.doc_type || null,
    versionNumber: row.version_number,
    status: row.status,
    language: row.language,
    title: row.title,
    contentMarkdown: row.content_markdown,
    contentHtml: row.content_html || null,
    contentHash: row.content_hash,
    changeSummary: row.change_summary || null,
    effectiveAt: row.effective_at,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    archivedAt: row.archived_at,
    legalReviewStatus: row.legal_review_status,
    isTemporaryDraft: row.is_temporary_draft,
    draftBanner: row.draft_banner,
    languagePrecedenceNote: row.language_precedence_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAcceptance(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    roleContext: row.role_context,
    documentType: row.document_type,
    documentVersionId: row.document_version_id,
    versionNumber: row.version_number,
    contentHash: row.content_hash,
    language: row.language,
    acceptanceMethod: row.acceptance_method,
    applicationId: row.application_id,
    transactionKey: row.transaction_key,
    snapshotMarkdown: row.snapshot_markdown,
    snapshotJson: row.snapshot_json,
    acceptedFromIp: row.accepted_from_ip,
    acceptedUserAgent: row.accepted_user_agent,
    ipUaRetentionNote: row.ip_ua_retention_note,
    evidenceDisclaimer: row.evidence_disclaimer,
    marketingConsent: row.marketing_consent,
    capitalMayBeLostAck: row.capital_may_be_lost_ack,
    projectionNotGuaranteedAck: row.projection_not_guaranteed_ack,
    viewedAt: row.viewed_at,
    acceptedAt: row.accepted_at,
  };
}

function fillTemplate(markdown, fields) {
  let out = String(markdown);
  for (const [key, value] of Object.entries(fields)) {
    const re = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    out = out.replace(re, value == null ? '' : String(value));
  }
  return out;
}

/**
 * Production block: while any published doc has legal_review_status != approved,
 * or LEGAL_PRODUCTION_BLOCK env/flag is true, refuse NODE_ENV=production boot paths
 * that would serve as live legal.
 */
export function assertLegalProductionAllowed({ env = process.env, allReviewStatuses = [] } = {}) {
  const blockFlag =
    env.LEGAL_PRODUCTION_BLOCK === 'true' ||
    env.LEGAL_PRODUCTION_BLOCK === '1' ||
    env.ALLOW_PRODUCTION_LEGAL !== 'true';
  const pending = allReviewStatuses.some((s) => s !== 'approved');
  if (env.NODE_ENV === 'production' && (blockFlag || pending)) {
    throw new DomainError(
      'LEGAL_PRODUCTION_BLOCKED',
      'Production blocked: legal_review_status is not approved for all published legal documents (or LEGAL_PRODUCTION_BLOCK is set). Staging/TEST only.',
      503,
    );
  }
  return { allowed: true, blockFlag, pending };
}

export function requiredDocsForRole(role) {
  if (role === ROLES.PROJECT_OWNER || role === 'project_owner') {
    return ['project_owner_agreement', 'privacy_notice'];
  }
  // Default investor (+ risk is section inside investor_agreement)
  return ['investor_agreement', 'privacy_notice'];
}

export function attachLegalAgreementMethods(proto) {
  proto.ensureLegalDraftsSeeded = async function ensureLegalDraftsSeeded(actorId = null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const documentType of DOC_TYPES) {
        const draft = TEMPORARY_DRAFTS[documentType];
        const doc = await client.query(`SELECT id FROM legal_documents WHERE document_type=$1`, [documentType]);
        if (!doc.rowCount) continue;
        const documentId = doc.rows[0].id;
        const existing = await client.query(
          `SELECT id FROM legal_document_versions WHERE document_id=$1 AND version_number=1 AND language='en'`,
          [documentId],
        );
        if (existing.rowCount) continue;
        for (const language of ['en', 'bn']) {
          const body = draft[language];
          if (!body) continue;
          const hash = contentHash(body);
          const ins = await client.query(
            `INSERT INTO legal_document_versions(
               document_id, version_number, status, language, title, content_markdown, content_hash,
               change_summary, effective_at, published_at, published_by, legal_review_status,
               is_temporary_draft, draft_banner, language_precedence_note, created_by
             ) VALUES ($1,1,'published',$2,$3,$4,$5,$6,now(),now(),$7,'pending',true,$8,$9,$7)
             RETURNING *`,
            [
              documentId,
              language,
              draft.title,
              body,
              hash,
              draft.changeSummary,
              actorId,
              DRAFT_BANNER,
              LANGUAGE_PRECEDENCE,
            ],
          );
          await writeLegalAudit(client, {
            documentId,
            versionId: ins.rows[0].id,
            actorId,
            action: 'legal.version.seed_published_draft',
            after: { documentType, language, version: 1, legalReviewStatus: 'pending' },
            note: DRAFT_BANNER,
          });
        }
      }
      await client.query(
        `INSERT INTO platform_settings(key, value_json, updated_at)
         VALUES ('legal_production_block', 'true'::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value_json='true'::jsonb, updated_at=now()`,
      );
      await client.query('COMMIT');
      return { seeded: true, banner: DRAFT_BANNER };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };

  proto.getLegalProductionGate = async function getLegalProductionGate() {
    const rows = await this.pool.query(
      `SELECT legal_review_status FROM legal_document_versions WHERE status='published'`,
    );
    const statuses = rows.rows.map((r) => r.legal_review_status);
    const setting = await this.pool.query(
      `SELECT value_json FROM platform_settings WHERE key='legal_production_block'`,
    );
    const blockSetting = setting.rows[0]?.value_json === true || setting.rows[0]?.value_json === 'true';
    let productionAllowed = true;
    let error = null;
    try {
      assertLegalProductionAllowed({
        env: {
          ...process.env,
          LEGAL_PRODUCTION_BLOCK: blockSetting ? 'true' : process.env.LEGAL_PRODUCTION_BLOCK,
        },
        allReviewStatuses: statuses.length ? statuses : ['pending'],
      });
    } catch (e) {
      productionAllowed = false;
      error = e.message;
    }
    return {
      productionAllowed,
      blockReason: error,
      legalProductionBlock: blockSetting || process.env.LEGAL_PRODUCTION_BLOCK === 'true',
      publishedReviewStatuses: statuses,
      allApproved: statuses.length > 0 && statuses.every((s) => s === 'approved'),
      draftBanner: DRAFT_BANNER,
      companyPlaceholders: COMPANY_PLACEHOLDERS,
      nodeEnv: process.env.NODE_ENV || 'development',
    };
  };

  proto.listLegalDocumentsAdmin = async function listLegalDocumentsAdmin() {
    await this.ensureLegalDraftsSeeded();
    const docs = await this.pool.query(`SELECT * FROM legal_documents ORDER BY title`);
    const out = [];
    for (const d of docs.rows) {
      const versions = await this.pool.query(
        `SELECT * FROM legal_document_versions WHERE document_id=$1 ORDER BY version_number DESC, language`,
        [d.id],
      );
      const published = versions.rows.find((v) => v.status === 'published' && v.language === 'en');
      out.push({
        id: d.id,
        documentType: d.document_type,
        title: d.title,
        description: d.description,
        publishedVersion: mapVersion(published),
        versions: versions.rows.map(mapVersion),
        publicationWarning:
          'Publishing a new version affects future acceptances only. Never overwrite or delete a version that has acceptances — archive the previous published version instead.',
      });
    }
    return { items: out, draftBanner: DRAFT_BANNER };
  };

  proto.getLegalDocumentVersion = async function getLegalDocumentVersion(versionId) {
    const r = await this.pool.query(
      `SELECT v.*, d.document_type FROM legal_document_versions v
       JOIN legal_documents d ON d.id=v.document_id WHERE v.id=$1`,
      [versionId],
    );
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Legal document version not found', 404);
    return mapVersion({ ...r.rows[0], document_type: r.rows[0].document_type });
  };

  proto.getPublishedLegalDocument = async function getPublishedLegalDocument(documentType, language = 'en') {
    if (!DOC_TYPES.includes(documentType)) {
      throw new DomainError('INVALID_DOCUMENT_TYPE', 'Unknown legal document type', 400);
    }
    await this.ensureLegalDraftsSeeded();
    const r = await this.pool.query(
      `SELECT v.*, d.document_type FROM legal_document_versions v
       JOIN legal_documents d ON d.id=v.document_id
       WHERE d.document_type=$1 AND v.language=$2 AND v.status='published'
       ORDER BY v.version_number DESC LIMIT 1`,
      [documentType, language],
    );
    if (!r.rowCount) {
      throw new DomainError('NOT_FOUND', 'No published version for this document', 404);
    }
    return mapVersion({ ...r.rows[0], document_type: r.rows[0].document_type });
  };

  proto.createLegalDocumentDraft = async function createLegalDocumentDraft(documentType, actorId, input = {}) {
    if (!DOC_TYPES.includes(documentType)) {
      throw new DomainError('INVALID_DOCUMENT_TYPE', 'Unknown legal document type', 400);
    }
    const language = input.language || 'en';
    const content = String(input.contentMarkdown || '').trim();
    if (content.length < 40) {
      throw new DomainError('CONTENT_REQUIRED', 'contentMarkdown is required', 400);
    }
    return this.pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const doc = await client.query(`SELECT * FROM legal_documents WHERE document_type=$1`, [documentType]);
        if (!doc.rowCount) throw new DomainError('NOT_FOUND', 'Document catalog row missing', 404);
        const documentId = doc.rows[0].id;
        const max = await client.query(
          `SELECT COALESCE(MAX(version_number),0) AS m FROM legal_document_versions WHERE document_id=$1 AND language=$2`,
          [documentId, language],
        );
        const next = Number(max.rows[0].m) + 1;
        const hash = contentHash(content);
        const ins = await client.query(
          `INSERT INTO legal_document_versions(
             document_id, version_number, status, language, title, content_markdown, content_html, content_hash,
             change_summary, legal_review_status, is_temporary_draft, draft_banner, language_precedence_note, created_by
           ) VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12) RETURNING *`,
          [
            documentId,
            next,
            language,
            input.title || doc.rows[0].title,
            content,
            input.contentHtml || null,
            hash,
            input.changeSummary || null,
            input.legalReviewStatus === 'approved' ? 'approved' : 'pending',
            DRAFT_BANNER,
            LANGUAGE_PRECEDENCE,
            actorId,
          ],
        );
        await writeLegalAudit(client, {
          documentId,
          versionId: ins.rows[0].id,
          actorId,
          action: 'legal.version.draft_created',
          after: mapVersion(ins.rows[0]),
        });
        await client.query('COMMIT');
        return mapVersion({ ...ins.rows[0], document_type: documentType });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  };

  proto.updateLegalDocumentDraft = async function updateLegalDocumentDraft(versionId, actorId, input = {}) {
    return this.pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const cur = await client.query(`SELECT * FROM legal_document_versions WHERE id=$1 FOR UPDATE`, [versionId]);
        if (!cur.rowCount) throw new DomainError('NOT_FOUND', 'Version not found', 404);
        const row = cur.rows[0];
        if (row.status !== 'draft') {
          throw new DomainError('IMMUTABLE_VERSION', 'Only draft versions can be edited', 409);
        }
        const content = input.contentMarkdown != null ? String(input.contentMarkdown) : row.content_markdown;
        const hash = contentHash(content);
        const upd = await client.query(
          `UPDATE legal_document_versions SET
             title=COALESCE($2,title),
             content_markdown=$3,
             content_html=COALESCE($4, content_html),
             content_hash=$5,
             change_summary=COALESCE($6, change_summary),
             legal_review_status=COALESCE($7, legal_review_status),
             updated_at=now()
           WHERE id=$1 RETURNING *`,
          [
            versionId,
            input.title || null,
            content,
            input.contentHtml || null,
            hash,
            input.changeSummary || null,
            input.legalReviewStatus || null,
          ],
        );
        await writeLegalAudit(client, {
          documentId: row.document_id,
          versionId,
          actorId,
          action: 'legal.version.draft_updated',
          before: mapVersion(row),
          after: mapVersion(upd.rows[0]),
        });
        await client.query('COMMIT');
        return mapVersion(upd.rows[0]);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  };

  proto.publishLegalDocumentVersion = async function publishLegalDocumentVersion(versionId, actorId, input = {}) {
    return this.pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');
        const cur = await client.query(`SELECT * FROM legal_document_versions WHERE id=$1 FOR UPDATE`, [versionId]);
        if (!cur.rowCount) throw new DomainError('NOT_FOUND', 'Version not found', 404);
        const row = cur.rows[0];
        if (row.status === 'archived') {
          throw new DomainError('ARCHIVED', 'Cannot publish an archived version', 409);
        }
        // Never delete versions with acceptances; archive previous published.
        const prev = await client.query(
          `SELECT v.* FROM legal_document_versions v
           WHERE v.document_id=$1 AND v.language=$2 AND v.status='published' AND v.id<>$3
           FOR UPDATE`,
          [row.document_id, row.language, versionId],
        );
        for (const p of prev.rows) {
          const acc = await client.query(
            `SELECT 1 FROM legal_acceptances WHERE document_version_id=$1 LIMIT 1`,
            [p.id],
          );
          // Always archive previous published (whether or not acceptances exist).
          await client.query(
            `UPDATE legal_document_versions SET status='archived', archived_at=now(), updated_at=now() WHERE id=$1`,
            [p.id],
          );
          await writeLegalAudit(client, {
            documentId: row.document_id,
            versionId: p.id,
            actorId,
            action: 'legal.version.archived_on_publish',
            after: { hadAcceptances: acc.rowCount > 0 },
            note: 'Publication affects future acceptances only',
          });
        }
        const upd = await client.query(
          `UPDATE legal_document_versions SET
             status='published',
             published_at=now(),
             published_by=$2,
             effective_at=COALESCE($3::timestamptz, effective_at, now()),
             change_summary=COALESCE($4, change_summary),
             updated_at=now()
           WHERE id=$1 RETURNING *`,
          [versionId, actorId, input.effectiveAt || null, input.changeSummary || null],
        );
        await writeLegalAudit(client, {
          documentId: row.document_id,
          versionId,
          actorId,
          action: 'legal.version.published',
          before: mapVersion(row),
          after: mapVersion(upd.rows[0]),
          note: 'Publication affects future acceptances only. Historical snapshots remain immutable.',
        });
        await client.query('COMMIT');
        return {
          ...mapVersion(upd.rows[0]),
          publicationWarning:
            'Published. Future acceptances use this version. Prior acceptances keep their historical snapshots.',
        };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    });
  };

  proto.downloadLegalDocumentVersion = async function downloadLegalDocumentVersion(versionId, format = 'html') {
    const v = await this.getLegalDocumentVersion(versionId);
    const banner = v.draftBanner || DRAFT_BANNER;
    if (format === 'markdown' || format === 'md') {
      return {
        filename: `${v.documentType || 'legal'}-v${v.versionNumber}-${v.language}.md`,
        contentType: 'text/markdown; charset=utf-8',
        body: v.contentMarkdown,
      };
    }
    const escaped = String(v.contentMarkdown)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${v.title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.5}
.banner{background:#fff3cd;border:1px solid #ffc107;padding:12px;margin-bottom:1rem}</style></head>
<body><div class="banner"><strong>${banner}</strong><br/>Evidence logging ≠ certified signature. Placeholders remain for counsel.</div>
<pre style="white-space:pre-wrap">${escaped}</pre></body></html>`;
    return {
      filename: `${v.documentType || 'legal'}-v${v.versionNumber}-${v.language}.html`,
      contentType: 'text/html; charset=utf-8',
      body: html,
    };
  };

  proto.listLegalDocumentAudit = async function listLegalDocumentAudit(documentId, { limit = 100 } = {}) {
    const r = await this.pool.query(
      `SELECT * FROM legal_document_audit WHERE document_id=$1 ORDER BY occurred_at DESC LIMIT $2`,
      [documentId, Math.min(Number(limit) || 100, 500)],
    );
    return {
      items: r.rows.map((row) => ({
        id: row.id,
        documentId: row.document_id,
        versionId: row.version_id,
        actorId: row.actor_id,
        action: row.action,
        before: row.before_json,
        after: row.after_json,
        note: row.note,
        occurredAt: row.occurred_at,
      })),
      immutable: true,
    };
  };

  proto.getSignupLegalPacket = async function getSignupLegalPacket(role = 'investor') {
    const types = requiredDocsForRole(role);
    const docs = [];
    for (const t of types) {
      docs.push(await this.getPublishedLegalDocument(t, 'en'));
    }
    return {
      role,
      documents: docs,
      optionalMarketingConsentDefault: false,
      viewRequiredBeforeCheckbox: true,
      understandingDisclaimer:
        'Viewing or scrolling does not mean you understand the agreement. You must actively confirm acceptance.',
      evidenceDisclaimer: 'Evidence logging is not a certified electronic signature.',
      draftBanner: DRAFT_BANNER,
      agreeButtonLabel: 'Agree and create account',
    };
  };

  proto.recordLegalAcceptance = async function recordLegalAcceptance(
    {
      userId,
      roleContext,
      documentType,
      documentVersionId,
      language = 'en',
      acceptanceMethod = 'checkbox_after_view',
      applicationId = null,
      transactionKey = null,
      viewedAt = null,
      marketingConsent = null,
      capitalMayBeLostAck = null,
      projectionNotGuaranteedAck = null,
      snapshotOverrideMarkdown = null,
      snapshotExtraJson = null,
      requestContext = {},
    },
    client = null,
  ) {
    const run = async (c) => {
      const ver = await c.query(
        `SELECT v.*, d.document_type FROM legal_document_versions v
         JOIN legal_documents d ON d.id=v.document_id WHERE v.id=$1`,
        [documentVersionId],
      );
      if (!ver.rowCount) throw new DomainError('VERSION_NOT_FOUND', 'Legal version not found', 404);
      const v = ver.rows[0];
      if (v.document_type !== documentType) {
        throw new DomainError('DOCUMENT_TYPE_MISMATCH', 'Version does not match document type', 409);
      }
      if (v.status !== 'published') {
        throw new DomainError('VERSION_NOT_PUBLISHED', 'Only published versions can be accepted', 409);
      }
      const snap = snapshotOverrideMarkdown || v.content_markdown;
      const hash = contentHash(snap);
      if (hash !== v.content_hash && !snapshotOverrideMarkdown) {
        throw new DomainError('CONTENT_HASH_MISMATCH', 'Published content hash mismatch', 409);
      }
      const finalHash = snapshotOverrideMarkdown ? contentHash(snap) : v.content_hash;
      const ctx = normalizeCtx(requestContext);
      try {
        const ins = await c.query(
          `INSERT INTO legal_acceptances(
             user_id, role_context, document_type, document_version_id, version_number, content_hash,
             language, acceptance_method, application_id, transaction_key, snapshot_markdown, snapshot_json,
             accepted_from_ip, accepted_user_agent, marketing_consent, capital_may_be_lost_ack,
             projection_not_guaranteed_ack, viewed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::inet,$14,$15,$16,$17,$18)
           RETURNING *`,
          [
            userId,
            roleContext,
            documentType,
            documentVersionId,
            v.version_number,
            finalHash,
            language,
            acceptanceMethod,
            applicationId,
            transactionKey,
            snap,
            JSON.stringify({
              documentType,
              versionNumber: v.version_number,
              contentHash: finalHash,
              draftBanner: v.draft_banner,
              ...(snapshotExtraJson || {}),
            }),
            ctx.ip,
            ctx.userAgent,
            marketingConsent,
            capitalMayBeLostAck,
            projectionNotGuaranteedAck,
            viewedAt || new Date().toISOString(),
          ],
        );
        return mapAcceptance(ins.rows[0]);
      } catch (e) {
        if (e.code === '23505') {
          throw new DomainError('DUPLICATE_ACCEPTANCE', 'This version was already accepted', 409);
        }
        throw e;
      }
    };
    if (client) return run(client);
    return this.pool.connect().then(async (c) => {
      try {
        await c.query('BEGIN');
        const row = await run(c);
        await c.query('COMMIT');
        return row;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    });
  };

  proto.acceptSignupLegal = async function acceptSignupLegal(userId, input, requestContext = {}) {
    const role = input.role || input.roleContext || 'investor';
    const roleContext = role === 'project_owner' ? 'project_owner' : 'investor';
    const required = requiredDocsForRole(roleContext);
    const acceptances = input.acceptances;
    if (!Array.isArray(acceptances) || acceptances.length < required.length) {
      throw new DomainError('MISSING_CONSENT', 'All required agreements must be accepted', 400);
    }
    const viewed = acceptances.every((a) => a.viewedAt || a.viewed === true);
    if (!viewed) {
      throw new DomainError('VIEW_REQUIRED', 'You must view each agreement before accepting', 400);
    }
    const byType = new Map(acceptances.map((a) => [a.documentType, a]));
    for (const t of required) {
      if (!byType.has(t)) {
        throw new DomainError('MISSING_CONSENT', `Missing acceptance for ${t}`, 400);
      }
    }
    const ctx = normalizeCtx(requestContext);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const recorded = [];
      for (const t of required) {
        const a = byType.get(t);
        const published = await this.getPublishedLegalDocument(t, a.language || 'en');
        if (a.versionNumber && Number(a.versionNumber) !== published.versionNumber) {
          throw new DomainError('WRONG_VERSION', `Wrong version for ${t}; refresh and accept current published version`, 409);
        }
        if (a.documentVersionId && a.documentVersionId !== published.id) {
          throw new DomainError('WRONG_VERSION', `Wrong version id for ${t}`, 409);
        }
        recorded.push(
          await this.recordLegalAcceptance(
            {
              userId,
              roleContext,
              documentType: t,
              documentVersionId: published.id,
              language: a.language || 'en',
              acceptanceMethod: 'checkbox_after_view',
              viewedAt: a.viewedAt || new Date().toISOString(),
              marketingConsent: t === 'privacy_notice' ? Boolean(input.marketingConsent) : null,
              requestContext: ctx,
            },
            client,
          ),
        );
      }
      if (input.marketingConsent === true) {
        await client.query(
          `INSERT INTO marketing_consents(user_id, consented, source, accepted_from_ip, accepted_user_agent)
           VALUES ($1,true,'signup',$2::inet,$3)`,
          [userId, ctx.ip, ctx.userAgent],
        );
      } else {
        await client.query(
          `INSERT INTO marketing_consents(user_id, consented, source, accepted_from_ip, accepted_user_agent)
           VALUES ($1,false,'signup',$2::inet,$3)`,
          [userId, ctx.ip, ctx.userAgent],
        );
      }
      await client.query(
        `UPDATE users SET pending_legal_acceptance=false, legal_acceptance_completed_at=now(), updated_at=now() WHERE id=$1`,
        [userId],
      );
      await client.query('COMMIT');
      return {
        acceptances: recorded,
        marketingConsent: Boolean(input.marketingConsent),
        evidenceDisclaimer: 'Evidence logging is not a certified electronic signature.',
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };

  proto.getPendingLegalGate = async function getPendingLegalGate(userId, roles = []) {
    const u = await this.pool.query(
      `SELECT pending_legal_acceptance, pending_owner_agreement, created_by_admin, legal_acceptance_completed_at
       FROM users WHERE id=$1`,
      [userId],
    );
    if (!u.rowCount) throw new DomainError('NOT_FOUND', 'User not found', 404);
    const row = u.rows[0];
    const needs = [];
    if (row.pending_legal_acceptance || (row.created_by_admin && !row.legal_acceptance_completed_at)) {
      const role = roles.includes(ROLES.PROJECT_OWNER) && !roles.includes(ROLES.INVESTOR)
        ? 'project_owner'
        : roles.includes(ROLES.PROJECT_OWNER) && roles.includes(ROLES.INVESTOR)
          ? 'investor' // investor docs first; owner separate
          : roles.includes(ROLES.PROJECT_OWNER)
            ? 'project_owner'
            : 'investor';
      needs.push(...requiredDocsForRole(role).map((t) => ({ documentType: t, reason: 'first_login_or_admin_created' })));
    }
    if (row.pending_owner_agreement || roles.includes(ROLES.PROJECT_OWNER)) {
      const pub = await this.getPublishedLegalDocument('project_owner_agreement', 'en');
      const acc = await this.pool.query(
        `SELECT id FROM legal_acceptances
         WHERE user_id=$1 AND document_type='project_owner_agreement' AND version_number=$2
         LIMIT 1`,
        [userId, pub.versionNumber],
      );
      if (!acc.rowCount && (row.pending_owner_agreement || roles.includes(ROLES.PROJECT_OWNER))) {
        // Only force if pending flag set OR owner never accepted current published version
        // and they have project_owner role with pending flag or no prior acceptance while pending.
        if (row.pending_owner_agreement) {
          if (!needs.some((n) => n.documentType === 'project_owner_agreement')) {
            needs.push({ documentType: 'project_owner_agreement', reason: 'role_switch' });
          }
        }
      }
    }
    // Deduplicate
    const seen = new Set();
    const documents = [];
    for (const n of needs) {
      if (seen.has(n.documentType)) continue;
      seen.add(n.documentType);
      documents.push({
        ...n,
        published: await this.getPublishedLegalDocument(n.documentType, 'en'),
      });
    }
    return {
      mustAccept: documents.length > 0,
      pendingLegalAcceptance: Boolean(row.pending_legal_acceptance) || (row.created_by_admin && !row.legal_acceptance_completed_at),
      pendingOwnerAgreement: Boolean(row.pending_owner_agreement),
      adminCannotAcceptForUser: true,
      documents,
      draftBanner: DRAFT_BANNER,
      evidenceDisclaimer: 'Evidence logging is not a certified electronic signature.',
    };
  };

  proto.completePendingLegalGate = async function completePendingLegalGate(userId, input, requestContext = {}) {
    const gate = await this.getPendingLegalGate(userId, input.roles || []);
    if (!gate.mustAccept) return { ok: true, alreadyComplete: true };
    const acceptances = input.acceptances;
    if (!Array.isArray(acceptances) || acceptances.length < gate.documents.length) {
      throw new DomainError('MISSING_CONSENT', 'All pending agreements must be accepted', 400);
    }
    const method = gate.pendingOwnerAgreement && !gate.pendingLegalAcceptance
      ? 'role_switch_gate'
      : 'first_login_gate';
    const roleContext = method === 'role_switch_gate' ? 'project_owner' : (input.roleContext || 'admin_created');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const recorded = [];
      for (const doc of gate.documents) {
        const a = acceptances.find((x) => x.documentType === doc.documentType);
        if (!a || !(a.viewedAt || a.viewed)) {
          throw new DomainError('VIEW_REQUIRED', `Must view ${doc.documentType} before accepting`, 400);
        }
        if (a.versionNumber && Number(a.versionNumber) !== doc.published.versionNumber) {
          throw new DomainError('WRONG_VERSION', 'Wrong version; refresh', 409);
        }
        recorded.push(
          await this.recordLegalAcceptance(
            {
              userId,
              roleContext,
              documentType: doc.documentType,
              documentVersionId: doc.published.id,
              acceptanceMethod: method,
              viewedAt: a.viewedAt || new Date().toISOString(),
              requestContext,
            },
            client,
          ),
        );
      }
      await client.query(
        `UPDATE users SET
           pending_legal_acceptance=false,
           pending_owner_agreement=false,
           legal_acceptance_completed_at=COALESCE(legal_acceptance_completed_at, now()),
           updated_at=now()
         WHERE id=$1`,
        [userId],
      );
      await client.query('COMMIT');
      return { ok: true, acceptances: recorded, evidenceDisclaimer: 'Evidence logging is not a certified electronic signature.' };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };

  proto.previewProjectInvestmentAgreement = async function previewProjectInvestmentAgreement({
    applicationId,
    investorId,
  }) {
    const app = await this.pool.query(`SELECT * FROM investment_applications WHERE id=$1`, [applicationId]);
    if (!app.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application not found', 404);
    const application = app.rows[0];
    if (application.investor_id !== investorId) {
      throw new DomainError('FORBIDDEN', 'Not your application', 403);
    }
    const project = await this.pool.query(`SELECT * FROM projects WHERE id=$1`, [application.project_id]);
    const p = project.rows[0];
    const owner = await this.pool.query(
      `SELECT u.id, COALESCE(ip.full_name, u.display_name, u.email) AS legal_name
       FROM businesses b
       JOIN users u ON u.id=b.owner_user_id
       LEFT JOIN investor_profiles ip ON ip.user_id=u.id
       WHERE b.id=$1`,
      [p.business_id],
    );
    const investor = await this.pool.query(
      `SELECT u.id, COALESCE(ip.full_name, u.display_name, u.email) AS legal_name
       FROM users u LEFT JOIN investor_profiles ip ON ip.user_id=u.id WHERE u.id=$1`,
      [investorId],
    );
    const template = await this.getPublishedLegalDocument('project_investment_agreement_template', 'en');
    if (application.terms_version !== p.published_terms_version) {
      throw new DomainError(
        'TERMS_VERSION_MISMATCH',
        'Project terms have changed; a new application/acceptance is required',
        409,
      );
    }
    const fields = {
      investor_legal_name: investor.rows[0]?.legal_name || investorId,
      investor_user_id: investorId,
      issuer_owner_legal_name: owner.rows[0]?.legal_name || '[LEGAL PLACEHOLDER: issuer/owner legal name]',
      project_title: p.title,
      project_id: p.id,
      application_id: application.id,
      project_terms_version: application.terms_version,
      template_version: template.versionNumber,
      instrument_type: p.instrument_type || 'profit_participation',
      units: application.units,
      unit_price_poisha: application.unit_investment_poisha,
      principal_poisha: application.investment_poisha,
      fee_poisha: application.administration_fee_poisha,
      total_payable_poisha: application.total_payable_poisha,
      duration_days: p.duration_days,
      maturity_rule: p.maturity_rule || 'Maturity from allocation activation + duration_days',
      projected_return: `target_profit_bps=${p.target_profit_bps} (illustrative only)`,
      loss_risks: p.loss_risks_summary || 'Capital may be lost. Projections not guaranteed.',
      exit_refund_rule: p.exit_refund_rule || '[LEGAL PLACEHOLDER: exit / refund]',
      payment_recipient: p.payment_recipient_placeholder || '[LEGAL PLACEHOLDER: payment recipient]',
      repayment_debtor: p.repayment_debtor_placeholder || '[LEGAL PLACEHOLDER: repayment debtor]',
      security_placeholder: p.security_placeholder || '[LEGAL PLACEHOLDER: security]',
      iec_guarantor_status:
        p.iec_guarantor_status ||
        'Invest in Bd is not a guarantor without a separate approved legal agreement.',
    };
    const markdown = fillTemplate(template.contentMarkdown, fields);
    return {
      templateVersionId: template.id,
      templateVersionNumber: template.versionNumber,
      projectTermsVersion: application.terms_version,
      contentMarkdown: markdown,
      contentHash: contentHash(markdown),
      filledFields: fields,
      draftBanner: DRAFT_BANNER,
      capitalMayBeLostRequired: true,
      projectionNotGuaranteedRequired: true,
      viewRequiredBeforeCheckbox: true,
      understandingDisclaimer:
        'Viewing or scrolling does not mean you understand the agreement.',
      evidenceDisclaimer: 'Evidence logging is not a certified electronic signature.',
    };
  };

  proto.acceptProjectInvestmentAgreement = async function acceptProjectInvestmentAgreement(
    { applicationId, investorId, viewedAt, capitalMayBeLostAck, projectionNotGuaranteedAck, templateVersionId },
    requestContext = {},
  ) {
    if (!capitalMayBeLostAck || !projectionNotGuaranteedAck) {
      throw new DomainError(
        'MISSING_RISK_ACK',
        'Separate capital-may-be-lost and projection-not-guaranteed acknowledgments are required',
        400,
      );
    }
    if (!viewedAt) {
      throw new DomainError('VIEW_REQUIRED', 'You must view the agreement before accepting', 400);
    }
    const preview = await this.previewProjectInvestmentAgreement({ applicationId, investorId });
    if (templateVersionId && templateVersionId !== preview.templateVersionId) {
      throw new DomainError('WRONG_VERSION', 'Template version changed; refresh and accept again', 409);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const acceptance = await this.recordLegalAcceptance(
        {
          userId: investorId,
          roleContext: 'purchase',
          documentType: 'project_investment_agreement_template',
          documentVersionId: preview.templateVersionId,
          acceptanceMethod: 'purchase_checkbox_after_view',
          applicationId,
          transactionKey: `app:${applicationId}`,
          viewedAt,
          capitalMayBeLostAck: true,
          projectionNotGuaranteedAck: true,
          snapshotOverrideMarkdown: preview.contentMarkdown,
          snapshotExtraJson: { filledFields: preview.filledFields, projectTermsVersion: preview.projectTermsVersion },
          requestContext,
        },
        client,
      );
      const existing = await client.query(
        `SELECT id FROM project_investment_agreement_instances WHERE application_id=$1`,
        [applicationId],
      );
      let instance;
      if (existing.rowCount) {
        const upd = await client.query(
          `UPDATE project_investment_agreement_instances SET
             acceptance_id=$2, status='accepted', content_markdown=$3, content_hash=$4,
             filled_fields_json=$5::jsonb, template_version_id=$6, template_version_number=$7,
             project_terms_version=$8
           WHERE application_id=$1 RETURNING *`,
          [
            applicationId,
            acceptance.id,
            preview.contentMarkdown,
            preview.contentHash,
            JSON.stringify(preview.filledFields),
            preview.templateVersionId,
            preview.templateVersionNumber,
            preview.projectTermsVersion,
          ],
        );
        instance = upd.rows[0];
      } else {
        const ins = await client.query(
          `INSERT INTO project_investment_agreement_instances(
             application_id, investor_id, project_id, template_version_id, template_version_number,
             project_terms_version, content_markdown, content_hash, filled_fields_json, acceptance_id, status
           ) VALUES ($1,$2,(SELECT project_id FROM investment_applications WHERE id=$1),$3,$4,$5,$6,$7,$8::jsonb,$9,'accepted')
           RETURNING *`,
          [
            applicationId,
            investorId,
            preview.templateVersionId,
            preview.templateVersionNumber,
            preview.projectTermsVersion,
            preview.contentMarkdown,
            preview.contentHash,
            JSON.stringify(preview.filledFields),
            acceptance.id,
          ],
        );
        instance = ins.rows[0];
      }
      await client.query('COMMIT');
      return {
        acceptance,
        instanceId: instance.id,
        evidenceDisclaimer: 'Evidence logging is not a certified electronic signature.',
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };

  proto.assertPurchaseAgreementAccepted = async function assertPurchaseAgreementAccepted(applicationId, investorId) {
    const r = await this.pool.query(
      `SELECT * FROM project_investment_agreement_instances
       WHERE application_id=$1 AND investor_id=$2 AND status IN ('accepted','finalized')`,
      [applicationId, investorId],
    );
    if (!r.rowCount) {
      throw new DomainError(
        'MISSING_PURCHASE_AGREEMENT',
        'You must accept the project-specific investment agreement before submitting payment',
        409,
      );
    }
    const preview = await this.previewProjectInvestmentAgreement({ applicationId, investorId });
    if (
      r.rows[0].template_version_number !== preview.templateVersionNumber ||
      r.rows[0].project_terms_version !== preview.projectTermsVersion ||
      r.rows[0].content_hash !== preview.contentHash
    ) {
      throw new DomainError(
        'TERMS_CHANGED',
        'Project or template terms changed since acceptance; accept the new version before payment',
        409,
      );
    }
    return r.rows[0];
  };

  proto.finalizeProjectInvestmentAgreement = async function finalizeProjectInvestmentAgreement(
    client,
    { applicationId, allocationId, investorId },
  ) {
    const inst = await client.query(
      `SELECT * FROM project_investment_agreement_instances WHERE application_id=$1 FOR UPDATE`,
      [applicationId],
    );
    if (!inst.rowCount) return null;
    const alloc = await client.query(`SELECT * FROM allocations WHERE id=$1`, [allocationId]);
    const a = alloc.rows[0];
    const extra = `\n\n## Allocation (post-payment)\n- Allocation id: ${allocationId}\n- Activated at: ${a.activated_at?.toISOString?.() || a.activated_at}\n- Maturity at: ${a.maturity_at?.toISOString?.() || a.maturity_at}\n- Units allocated: ${a.units}\n`;
    const markdown = `${inst.rows[0].content_markdown}${extra}`;
    const hash = contentHash(markdown);
    const upd = await client.query(
      `UPDATE project_investment_agreement_instances SET
         allocation_id=$2, content_markdown=$3, content_hash=$4, status='finalized', finalized_at=now(),
         email_delivery_status='pending'
       WHERE id=$1 RETURNING *`,
      [inst.rows[0].id, allocationId, markdown, hash],
    );
    // Attempt email with retry tracking (adapter may be memory/staging).
    try {
      if (this.emailAdapter?.sendMail) {
        const user = await client.query(`SELECT email FROM users WHERE id=$1`, [investorId]);
        await this.emailAdapter.sendMail({
          to: user.rows[0]?.email,
          subject: 'Invest in Bd — Your project investment agreement (TEST/STAGING)',
          text: `Your agreement copy is available in-account. ${DRAFT_BANNER}\nDelivery tracking is recorded; memory of send is not proof of delivery.`,
        });
        await client.query(
          `UPDATE project_investment_agreement_instances
           SET email_delivery_status='sent', emailed_at=now(), email_delivery_attempts=email_delivery_attempts+1
           WHERE id=$1`,
          [upd.rows[0].id],
        );
      } else {
        await client.query(
          `UPDATE project_investment_agreement_instances
           SET email_delivery_status='recorded_memory', email_delivery_attempts=email_delivery_attempts+1,
               email_last_error='No email adapter — recorded in memory only (not proof of delivery)'
           WHERE id=$1`,
          [upd.rows[0].id],
        );
      }
    } catch (err) {
      await client.query(
        `UPDATE project_investment_agreement_instances
         SET email_delivery_status='failed', email_delivery_attempts=email_delivery_attempts+1,
             email_last_error=$2
         WHERE id=$1`,
        [upd.rows[0].id, String(err.message || err).slice(0, 500)],
      );
    }
    return upd.rows[0];
  };

  proto.resendProjectInvestmentAgreementEmail = async function resendProjectInvestmentAgreementEmail(
    instanceId,
    actorId,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT * FROM project_investment_agreement_instances WHERE id=$1 FOR UPDATE`,
        [instanceId],
      );
      if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Agreement instance not found', 404);
      await client.query(
        `UPDATE project_investment_agreement_instances
         SET email_delivery_status='resend_queued', email_delivery_attempts=email_delivery_attempts+1
         WHERE id=$1`,
        [instanceId],
      );
      try {
        const user = await client.query(`SELECT email FROM users WHERE id=$1`, [r.rows[0].investor_id]);
        if (this.emailAdapter?.sendMail) {
          await this.emailAdapter.sendMail({
            to: user.rows[0]?.email,
            subject: 'Invest in Bd — Agreement copy resend (TEST/STAGING)',
            text: `Resent agreement copy. ${DRAFT_BANNER}`,
          });
          await client.query(
            `UPDATE project_investment_agreement_instances
             SET email_delivery_status='sent', emailed_at=now() WHERE id=$1`,
            [instanceId],
          );
        } else {
          await client.query(
            `UPDATE project_investment_agreement_instances
             SET email_delivery_status='recorded_memory',
                 email_last_error='Resend recorded in memory only — not proof of delivery'
             WHERE id=$1`,
            [instanceId],
          );
        }
      } catch (err) {
        await client.query(
          `UPDATE project_investment_agreement_instances
           SET email_delivery_status='failed', email_last_error=$2 WHERE id=$1`,
          [instanceId, String(err.message || err).slice(0, 500)],
        );
      }
      await client.query('COMMIT');
      const out = await this.pool.query(`SELECT * FROM project_investment_agreement_instances WHERE id=$1`, [
        instanceId,
      ]);
      return {
        id: out.rows[0].id,
        emailDeliveryStatus: out.rows[0].email_delivery_status,
        emailDeliveryAttempts: out.rows[0].email_delivery_attempts,
        emailLastError: out.rows[0].email_last_error,
        note: 'Delivery/retry tracked; memory-as-proof is not used.',
        actorId,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  };

  proto.listMyLegalAcceptances = async function listMyLegalAcceptances(userId) {
    const r = await this.pool.query(
      `SELECT * FROM legal_acceptances WHERE user_id=$1 ORDER BY accepted_at DESC LIMIT 100`,
      [userId],
    );
    return {
      items: r.rows.map(mapAcceptance),
      immutable: true,
      evidenceDisclaimer: 'Evidence logging is not a certified electronic signature.',
    };
  };

  proto.getLegalAcceptance = async function getLegalAcceptance(id, userId, isStaff = false) {
    const r = await this.pool.query(`SELECT * FROM legal_acceptances WHERE id=$1`, [id]);
    if (!r.rowCount) throw new DomainError('NOT_FOUND', 'Acceptance not found', 404);
    if (!isStaff && r.rows[0].user_id !== userId) {
      throw new DomainError('FORBIDDEN', 'Not your acceptance', 403);
    }
    return mapAcceptance(r.rows[0]);
  };
}

export { DOC_TYPES, contentHash, fillTemplate, mapVersion, mapAcceptance };
