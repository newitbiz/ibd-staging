/**
 * Project Owner feature pack — metrics, review fees, updates, milestones,
 * interest inbox, funding requests, reports, invest opportunities.
 * Attached onto PostgresGrowBangladeshService.prototype.
 */
import { DomainError } from './domain.js';
import { withTransaction } from './db.js';
import {
  PROJECT_WORKFLOW_STATUS,
  mapProjectRow,
  publicProjectView,
  validateProjectPayload,
  assertTransition,
  assertSafeInteger,
} from './project_workflow.js';
import {
  assertProjectPhotoUpload,
  buildFictionalPlaceholderPdf,
  createDocumentStore,
  FICTIONAL_BANNER,
  newStorageKey,
  runMalwareScanStub,
  sha256Buffer,
} from './document_storage.js';

const photoStore = createDocumentStore();

export const DEFAULT_REVIEW_FEE_POISHA = 50_000; // ৳500
export const REVIEW_FEE_SETTING_KEY = 'project_review_fee_poisha';

export function yearsToDurationDays(years) {
  const y = Number(years);
  if (!Number.isSafeInteger(y) || y < 1 || y > 5) {
    throw new DomainError('INVALID_INVESTMENT_YEARS', 'investmentYears must be an integer 1–5', 400);
  }
  return y * 365;
}

export function mapReviewFeeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    amountPoisha: Number(row.amount_poisha),
    status: row.status,
    paymentMethod: row.payment_method || null,
    reference: row.reference || null,
    receiptNote: row.receipt_note || null,
    submittedAt: row.submitted_at,
    submittedBy: row.submitted_by,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    waivedAt: row.waived_at,
    waivedBy: row.waived_by,
    waiveReason: row.waive_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fictionalStaging: true,
    note: 'Fictional staging review fee — cash/bank deposit only; no live gateways.',
  };
}

export function mapProjectUpdateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    authorUserId: row.author_user_id || row.author_id,
    title: row.title || null,
    bodyText: row.body_text || row.body || '',
    photoUrl: row.photo_url || null,
    status: row.status || 'published',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

export function mapMilestoneRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description || null,
    status: row.status,
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapFundingRequestRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    requestType: row.request_type,
    reason: row.reason,
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectTitle: row.project_title || null,
  };
}

export function enrichOwnerPackFields(mapped, row) {
  if (!mapped || !row) return mapped;
  const photoUrls = Array.isArray(row.photo_urls)
    ? row.photo_urls
    : typeof row.photo_urls === 'string'
      ? (() => {
          try {
            return JSON.parse(row.photo_urls);
          } catch {
            return [];
          }
        })()
      : [];
  mapped.locationAddress = row.location_address || null;
  mapped.photoUrls = photoUrls.filter((u) => typeof u === 'string' && u.trim());
  const photoDocIds = Array.isArray(row.photo_document_ids)
    ? row.photo_document_ids
    : typeof row.photo_document_ids === 'string'
      ? (() => {
          try {
            return JSON.parse(row.photo_document_ids);
          } catch {
            return [];
          }
        })()
      : [];
  mapped.photoDocumentIds = photoDocIds.map(String).filter(Boolean).slice(0, 10);
  mapped.detailsText = row.details_text || null;
  mapped.investmentYears =
    row.investment_years == null ? null : Number(row.investment_years);
  mapped.estimatedYearlyProfitBps =
    row.estimated_yearly_profit_bps == null
      ? null
      : Number(row.estimated_yearly_profit_bps);
  mapped.badLossSummary = row.bad_loss_summary || null;
  mapped.ownerExperience = row.owner_experience || null;
  mapped.educationalBackground = row.educational_background || null;

  const sold = Number(mapped.activeUnits || 0) + Number(mapped.reservedUnits || 0);
  const total = Number(mapped.totalUnits || 0) || 1;
  const progressRatio = Math.min(1, sold / total);
  const closesAt = mapped.fundingClosesAt ? new Date(mapped.fundingClosesAt) : null;
  const daysToClose =
    closesAt && !Number.isNaN(closesAt.getTime())
      ? Math.ceil((closesAt.getTime() - Date.now()) / 86_400_000)
      : null;
  mapped.fundingProgress = {
    unitsSold: sold,
    unitsTarget: Number(mapped.totalUnits || 0),
    unitsRemaining: Math.max(0, Number(mapped.totalUnits || 0) - sold),
    ratio: progressRatio,
    fundraisedPoisha: sold * Number(mapped.unitInvestmentPoisha || 0),
    fundingTargetPoisha: mapped.fundingTargetPoisha,
    daysToOfferClose: daysToClose,
    almostFull: progressRatio >= 0.85,
    closingSoon: daysToClose != null && daysToClose >= 0 && daysToClose <= 14,
    hints: [
      ...(progressRatio >= 0.85 ? ['Almost full — few units remaining'] : []),
      ...(daysToClose != null && daysToClose >= 0 && daysToClose <= 14
        ? [`Closing soon — ~${daysToClose} day(s) to offer close`]
        : []),
    ],
  };
  return mapped;
}

async function audit(client, actorId, action, subjectType, subjectId, detail = {}, meta = {}) {
  const afterPayload = meta.after != null ? meta.after : detail;
  const sid =
    subjectId && String(subjectId).match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
      ? subjectId
      : '00000000-0000-4000-8000-000000000015';
  await client.query(
    `INSERT INTO audit_logs(actor_id, action, subject_type, subject_id, reason, before_json, after_json, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::inet, $9)`,
    [
      actorId,
      action,
      subjectType,
      sid,
      meta.reason ?? null,
      meta.before != null ? JSON.stringify(meta.before) : null,
      afterPayload != null ? JSON.stringify(afterPayload) : null,
      meta.ip || null,
      meta.userAgent || null,
    ],
  );
}

/**
 * @param {import('./postgres_service.js').PostgresGrowBangladeshService} proto
 */
export function attachProjectOwnerPackMethods(proto) {
  // Ownership helper (plain name — cannot assign private # fields on prototype).
  proto._assertOwnsProject = async function _assertOwnsProject(projectId, ownerUserId, client) {
    const q = client || this.pool;
    const result = await q.query(
      `SELECT p.id, b.owner_user_id, p.status, p.title, p.total_units, p.active_units, p.reserved_units
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       WHERE p.id=$1`,
      [projectId],
    );
    if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    if (result.rows[0].owner_user_id !== ownerUserId) {
      throw new DomainError('PROJECT_FORBIDDEN', 'You can only access your own projects', 403);
    }
    return result.rows[0];
  };

  proto.getProjectReviewFeePoisha = async function getProjectReviewFeePoisha(client) {
    const q = client || this.pool;
    const result = await q.query(
      `SELECT value_json FROM platform_settings WHERE key=$1 LIMIT 1`,
      [REVIEW_FEE_SETTING_KEY],
    );
    if (!result.rowCount) return DEFAULT_REVIEW_FEE_POISHA;
    const raw = result.rows[0].value_json;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_REVIEW_FEE_POISHA;
  };

  proto.getOwnerHomeMetrics = async function getOwnerHomeMetrics(ownerUserId) {
    const projects = await this.pool.query(
      `SELECT p.id, p.status, p.category, p.total_units, p.active_units, p.reserved_units,
              p.unit_investment_poisha, p.funding_target_poisha, p.funding_closes_at, p.title
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       WHERE b.owner_user_id=$1`,
      [ownerUserId],
    );
    const rows = projects.rows;
    const submittedCount = rows.filter((r) =>
      [
        'submitted_for_review',
        'resubmitted',
        'changes_requested',
        'approved',
        'published',
        'paused',
        'funding_closed',
        'active',
        'completed',
      ].includes(r.status),
    ).length;
    const acceptedPublishedCount = rows.filter((r) =>
      ['published', 'paused', 'funding_closed', 'active', 'completed', 'approved'].includes(r.status),
    ).length;
    const publishedCount = rows.filter((r) =>
      ['published', 'paused', 'funding_closed', 'active', 'completed'].includes(r.status),
    ).length;

    const fundraised = await this.pool.query(
      `SELECT COALESCE(SUM(a.investment_poisha), 0)::bigint AS total
       FROM allocations a
       JOIN projects p ON p.id = a.project_id
       JOIN businesses b ON b.id = p.business_id
       WHERE b.owner_user_id=$1 AND a.status = 'active'`,
      [ownerUserId],
    );
    const byCategory = await this.pool.query(
      `SELECT p.category,
              COALESCE(SUM(a.units), 0)::bigint AS units_sold,
              COALESCE(SUM(a.investment_poisha), 0)::bigint AS investment_poisha
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       LEFT JOIN allocations a ON a.project_id = p.id AND a.status = 'active'
       WHERE b.owner_user_id=$1
       GROUP BY p.category
       ORDER BY p.category`,
      [ownerUserId],
    );

    const inbox = await this.pool.query(
      `SELECT COUNT(*)::int AS unread
       FROM investment_applications ia
       JOIN projects p ON p.id = ia.project_id
       JOIN businesses b ON b.id = p.business_id
       LEFT JOIN owner_application_reads r
         ON r.application_id = ia.id AND r.owner_user_id = $1
       WHERE b.owner_user_id=$1
         AND ia.status IN ('submitted','under_review','changes_requested','approved')
         AND r.application_id IS NULL`,
      [ownerUserId],
    );

    const feeSetting = await this.getProjectReviewFeePoisha();

    const progress = rows.map((r) => {
      const sold = Number(r.active_units) + Number(r.reserved_units);
      const total = Number(r.total_units) || 1;
      const closesAt = r.funding_closes_at ? new Date(r.funding_closes_at) : null;
      const daysToClose =
        closesAt && !Number.isNaN(closesAt.getTime())
          ? Math.ceil((closesAt.getTime() - Date.now()) / 86_400_000)
          : null;
      const ratio = Math.min(1, sold / total);
      return {
        projectId: r.id,
        title: r.title,
        status: r.status,
        unitsSold: sold,
        unitsTarget: Number(r.total_units),
        daysToOfferClose: daysToClose,
        almostFull: ratio >= 0.85,
        closingSoon: daysToClose != null && daysToClose >= 0 && daysToClose <= 14,
        ratio,
      };
    });

    return {
      projectsSubmittedCount: submittedCount,
      projectsAcceptedOrPublishedCount: acceptedPublishedCount,
      projectsPublishedCount: publishedCount,
      totalProjectsCount: rows.length,
      totalFundraisedPoisha: Number(fundraised.rows[0].total),
      shareSalesByCategory: byCategory.rows.map((r) => ({
        category: r.category,
        unitsSold: Number(r.units_sold),
        investmentPoisha: Number(r.investment_poisha),
      })),
      fundingProgress: progress,
      unreadInterestCount: inbox.rows[0].unread,
      reviewFeeDefaultPoisha: feeSetting,
      withdrawable: false,
      fictionalStaging: true,
    };
  };

  proto.getOwnerReportSummary = async function getOwnerReportSummary(ownerUserId) {
    const metrics = await this.getOwnerHomeMetrics(ownerUserId);
    const sharesSold = metrics.shareSalesByCategory.reduce((s, c) => s + c.unitsSold, 0);
    return {
      totalFundraisePoisha: metrics.totalFundraisedPoisha,
      publishedProjectsCount: metrics.projectsPublishedCount,
      sharesSoldCount: sharesSold,
      shareSalesByCategory: metrics.shareSalesByCategory,
      generatedAt: new Date().toISOString(),
      format: 'summary',
      fictionalStaging: true,
      withdrawable: false,
    };
  };

  proto.downloadOwnerReportCsv = async function downloadOwnerReportCsv(ownerUserId) {
    const summary = await this.getOwnerReportSummary(ownerUserId);
    const lines = [
      'metric,value',
      `total_fundraise_poisha,${summary.totalFundraisePoisha}`,
      `published_projects_count,${summary.publishedProjectsCount}`,
      `shares_sold_count,${summary.sharesSoldCount}`,
      '',
      'category,units_sold,investment_poisha',
      ...summary.shareSalesByCategory.map(
        (c) => `${JSON.stringify(c.category)},${c.unitsSold},${c.investmentPoisha}`,
      ),
    ];
    return {
      filename: `owner-report-${ownerUserId.slice(0, 8)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: lines.join('\n'),
      summary,
    };
  };

  proto.downloadOwnerProjectCsv = async function downloadOwnerProjectCsv(projectId, ownerUserId) {
    await this._assertOwnsProject(projectId, ownerUserId);
    const apps = await this.pool.query(
      `SELECT ia.id, ia.status, ia.units, ia.investment_poisha, ia.total_payable_poisha,
              ia.created_at, ia.investor_id
       FROM investment_applications ia
       WHERE ia.project_id=$1
       ORDER BY ia.created_at DESC`,
      [projectId],
    );
    const project = await this.pool.query(
      `SELECT total_units, active_units, reserved_units, title FROM projects WHERE id=$1`,
      [projectId],
    );
    const p = project.rows[0];
    const remaining = Number(p.total_units) - Number(p.active_units) - Number(p.reserved_units);
    const lines = [
      `# project,${JSON.stringify(p.title)}`,
      `# total_units,${p.total_units}`,
      `# paid_active_units,${p.active_units}`,
      `# reserved_units,${p.reserved_units}`,
      `# remaining_units,${remaining}`,
      '',
      'application_id,status,units,investment_poisha,total_payable_poisha,created_at,investor_id',
      ...apps.rows.map(
        (r) =>
          `${r.id},${r.status},${r.units},${r.investment_poisha},${r.total_payable_poisha},${r.created_at},${r.investor_id}`,
      ),
    ];
    return {
      filename: `project-${projectId.slice(0, 8)}-units.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: lines.join('\n'),
      meta: {
        totalUnits: Number(p.total_units),
        paidUnits: Number(p.active_units),
        remainingUnits: remaining,
      },
    };
  };

  proto.listOwnerInvestOpportunities = async function listOwnerInvestOpportunities(ownerUserId) {
    const result = await this.pool.query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug,
              b.owner_user_id, b.legal_name AS business_legal_name,
              COALESCE(ou.email, b.legal_name) AS owner_display_name
       FROM projects p
       JOIN categories c ON c.id = p.category_id
       JOIN businesses b ON b.id = p.business_id
       LEFT JOIN users ou ON ou.id = b.owner_user_id
       WHERE p.status = ANY($1::text[])
         AND b.owner_user_id <> $2
       ORDER BY p.published_at DESC NULLS LAST, p.created_at DESC`,
      [['published'], ownerUserId],
    );
    return result.rows.map((row) => {
      const mapped = enrichOwnerPackFields(mapProjectRow(row), row);
      return publicProjectView(mapped);
    });
  };

  proto.getCategoryBenchmarkStub = async function getCategoryBenchmarkStub(categorySlug = null) {
    const result = await this.pool.query(
      `SELECT c.slug, c.name,
              COUNT(p.id)::int AS project_count,
              COALESCE(AVG(p.selected_rate_bps), 0)::int AS avg_selected_rate_bps,
              COALESCE(AVG(p.unit_investment_poisha), 0)::bigint AS avg_unit_poisha
       FROM categories c
       LEFT JOIN projects p ON p.category_id = c.id AND p.status IN ('published','active','funding_closed','completed')
       WHERE ($1::text IS NULL OR c.slug = $1)
       GROUP BY c.slug, c.name
       ORDER BY c.name`,
      [categorySlug || null],
    );
    return {
      fictional: true,
      note: 'Anonymized category benchmark stub — fictional staging averages only.',
      categories: result.rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        projectCount: r.project_count,
        avgSelectedRateBps: Number(r.avg_selected_rate_bps),
        avgUnitInvestmentPoisha: Number(r.avg_unit_poisha),
      })),
    };
  };

  // --- Review fees ---
  proto.ensureProjectReviewFee = async function ensureProjectReviewFee(projectId, actorId, client) {
    const q = client || this.pool;
    const existing = await q.query(`SELECT * FROM project_review_fees WHERE project_id=$1`, [projectId]);
    if (existing.rowCount) return mapReviewFeeRow(existing.rows[0]);
    const amount = await this.getProjectReviewFeePoisha(q);
    const inserted = await q.query(
      `INSERT INTO project_review_fees(project_id, amount_poisha, status)
       VALUES ($1,$2,'unpaid')
       ON CONFLICT (project_id) DO UPDATE SET updated_at=now()
       RETURNING *`,
      [projectId, amount],
    );
    return mapReviewFeeRow(inserted.rows[0]);
  };

  proto.getOwnerProjectReviewFee = async function getOwnerProjectReviewFee(projectId, ownerUserId) {
    await this._assertOwnsProject(projectId, ownerUserId);
    return this.ensureProjectReviewFee(projectId, ownerUserId);
  };

  proto.submitOwnerProjectReviewFee = async function submitOwnerProjectReviewFee(
    projectId,
    ownerUserId,
    { paymentMethod, reference, receiptNote } = {},
  ) {
    const method = String(paymentMethod || '').trim();
    if (!['cash', 'bank_deposit'].includes(method)) {
      throw new DomainError('INVALID_PAYMENT_METHOD', 'paymentMethod must be cash or bank_deposit', 400);
    }
    const ref = String(reference || '').trim();
    if (ref.length < 3) {
      throw new DomainError('REFERENCE_REQUIRED', 'Payment reference is required (min 3 chars)', 400);
    }
    return withTransaction(this.pool, async (client) => {
      await this._assertOwnsProject(projectId, ownerUserId, client);
      await this.ensureProjectReviewFee(projectId, ownerUserId, client);
      const locked = await client.query(
        `SELECT * FROM project_review_fees WHERE project_id=$1 FOR UPDATE`,
        [projectId],
      );
      const before = locked.rows[0];
      if (['verified', 'waived'].includes(before.status)) {
        throw new DomainError('FEE_ALREADY_SETTLED', `Review fee already ${before.status}`, 409);
      }
      const updated = await client.query(
        `UPDATE project_review_fees SET
           status='submitted', payment_method=$2, reference=$3, receipt_note=$4,
           submitted_at=now(), submitted_by=$5, updated_at=now()
         WHERE project_id=$1
         RETURNING *`,
        [projectId, method, ref, receiptNote || null, ownerUserId],
      );
      const fee = mapReviewFeeRow(updated.rows[0]);
      await audit(client, ownerUserId, 'project_review_fee.submitted', 'project_review_fee', fee.id, fee, {
        before: mapReviewFeeRow(before),
      });
      return fee;
    });
  };

  proto.listAdminProjectReviewFees = async function listAdminProjectReviewFees({ status = null } = {}) {
    const params = [];
    let sql = `
      SELECT f.*, p.title AS project_title, b.owner_user_id
      FROM project_review_fees f
      JOIN projects p ON p.id = f.project_id
      JOIN businesses b ON b.id = p.business_id
      WHERE 1=1`;
    if (status) {
      params.push(status);
      sql += ` AND f.status = $${params.length}`;
    }
    sql += ' ORDER BY f.updated_at DESC';
    const result = await this.pool.query(sql, params);
    return result.rows.map((r) => ({
      ...mapReviewFeeRow(r),
      projectTitle: r.project_title,
      ownerUserId: r.owner_user_id,
    }));
  };

  proto.verifyAdminProjectReviewFee = async function verifyAdminProjectReviewFee(
    projectId,
    actorId,
    { waive = false, waiveReason = '' } = {},
  ) {
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM project_review_fees WHERE project_id=$1 FOR UPDATE`,
        [projectId],
      );
      if (!locked.rowCount) {
        await this.ensureProjectReviewFee(projectId, actorId, client);
      }
      const again = await client.query(
        `SELECT * FROM project_review_fees WHERE project_id=$1 FOR UPDATE`,
        [projectId],
      );
      const before = again.rows[0];
      let updated;
      if (waive) {
        const reason = String(waiveReason || '').trim();
        if (reason.length < 3) {
          throw new DomainError('WAIVE_REASON_REQUIRED', 'waiveReason is required', 400);
        }
        updated = await client.query(
          `UPDATE project_review_fees SET
             status='waived', waived_at=now(), waived_by=$2, waive_reason=$3, updated_at=now()
           WHERE project_id=$1 RETURNING *`,
          [projectId, actorId, reason],
        );
      } else {
        if (!['submitted', 'unpaid'].includes(before.status)) {
          throw new DomainError('FEE_NOT_VERIFIABLE', `Cannot verify fee in status ${before.status}`, 409);
        }
        updated = await client.query(
          `UPDATE project_review_fees SET
             status='verified', verified_at=now(), verified_by=$2, updated_at=now()
           WHERE project_id=$1 RETURNING *`,
          [projectId, actorId],
        );
      }
      const fee = mapReviewFeeRow(updated.rows[0]);
      await audit(
        client,
        actorId,
        waive ? 'project_review_fee.waived' : 'project_review_fee.verified',
        'project_review_fee',
        fee.id,
        fee,
        { before: mapReviewFeeRow(before) },
      );
      return fee;
    });
  };

  proto.getAdminReviewFeeSettings = async function getAdminReviewFeeSettings() {
    const amount = await this.getProjectReviewFeePoisha();
    return {
      key: REVIEW_FEE_SETTING_KEY,
      amountPoisha: amount,
      defaultPoisha: DEFAULT_REVIEW_FEE_POISHA,
      currencyNote: 'Integer poisha (৳1 = 100 poisha). Staging fictional fee.',
    };
  };

  proto.updateAdminReviewFeeSettings = async function updateAdminReviewFeeSettings(actorId, amountPoisha) {
    const amount = assertSafeInteger(amountPoisha, 'amountPoisha', 0);
    return withTransaction(this.pool, async (client) => {
      const before = await this.getProjectReviewFeePoisha(client);
      await client.query(
        `INSERT INTO platform_settings(key, value_json, updated_at, updated_by)
         VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=now(), updated_by=$3`,
        [REVIEW_FEE_SETTING_KEY, JSON.stringify(amount), actorId],
      );
      await audit(client, actorId, 'platform_settings.project_review_fee_updated', 'platform_settings', REVIEW_FEE_SETTING_KEY, {
        amountPoisha: amount,
      }, { before });
      return { key: REVIEW_FEE_SETTING_KEY, amountPoisha: amount };
    });
  };

  // --- Interest inbox ---
  proto.listOwnerInterestInbox = async function listOwnerInterestInbox(ownerUserId, { unreadOnly = false } = {}) {
    const result = await this.pool.query(
      `SELECT ia.*, p.title AS project_title, p.id AS project_id,
              (r.application_id IS NOT NULL) AS is_read,
              u.email AS investor_email_masked
       FROM investment_applications ia
       JOIN projects p ON p.id = ia.project_id
       JOIN businesses b ON b.id = p.business_id
       LEFT JOIN users u ON u.id = ia.investor_id
       LEFT JOIN owner_application_reads r
         ON r.application_id = ia.id AND r.owner_user_id = $1
       WHERE b.owner_user_id=$1
       ORDER BY ia.created_at DESC
       LIMIT 200`,
      [ownerUserId],
    );
    let rows = result.rows;
    if (unreadOnly) rows = rows.filter((r) => !r.is_read);
    return {
      unreadCount: result.rows.filter((r) => !r.is_read).length,
      items: rows.map((r) => ({
        applicationId: r.id,
        projectId: r.project_id,
        projectTitle: r.project_title,
        status: r.status,
        units: Number(r.units),
        investmentPoisha: Number(r.investment_poisha),
        totalPayablePoisha: Number(r.total_payable_poisha),
        createdAt: r.created_at,
        isRead: Boolean(r.is_read),
        // Mask email lightly for owner visibility (staging fictional)
        investorHint: r.investor_email_masked
          ? String(r.investor_email_masked).replace(/(.{2}).+(@.+)/, '$1***$2')
          : null,
      })),
    };
  };

  proto.markOwnerInterestRead = async function markOwnerInterestRead(ownerUserId, applicationId) {
    const check = await this.pool.query(
      `SELECT ia.id
       FROM investment_applications ia
       JOIN projects p ON p.id = ia.project_id
       JOIN businesses b ON b.id = p.business_id
       WHERE ia.id=$1 AND b.owner_user_id=$2`,
      [applicationId, ownerUserId],
    );
    if (!check.rowCount) throw new DomainError('APPLICATION_NOT_FOUND', 'Application not found for your projects', 404);
    await this.pool.query(
      `INSERT INTO owner_application_reads(owner_user_id, application_id, read_at)
       VALUES ($1,$2,now())
       ON CONFLICT (owner_user_id, application_id) DO UPDATE SET read_at=now()`,
      [ownerUserId, applicationId],
    );
    return { applicationId, read: true };
  };

  // --- Updates ---
  proto.listProjectUpdates = async function listProjectUpdates(projectId, { actorId = null, asOwner = false } = {}) {
    if (asOwner && actorId) {
      await this._assertOwnsProject(projectId, actorId);
    } else {
      const pub = await this.pool.query(`SELECT status FROM projects WHERE id=$1`, [projectId]);
      if (!pub.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
      const st = pub.rows[0].status;
      if (!['published', 'paused', 'funding_closed', 'active', 'completed'].includes(st) && !asOwner) {
        // Non-owners only see updates on marketplace-visible projects
        throw new DomainError('PROJECT_NOT_VISIBLE', 'Updates are only visible for published projects', 403);
      }
    }
    const result = await this.pool.query(
      `SELECT * FROM project_updates WHERE project_id=$1 AND status IN ('published','submitted','draft') ORDER BY created_at DESC LIMIT 100`,
      [projectId],
    );
    return result.rows.map(mapProjectUpdateRow);
  };

  proto.createOwnerProjectUpdate = async function createOwnerProjectUpdate(
    projectId,
    ownerUserId,
    { bodyText, photoUrl } = {},
  ) {
    const body = String(bodyText || '').trim();
    if (body.length < 1) throw new DomainError('UPDATE_REQUIRED', 'bodyText is required', 400);
    await this._assertOwnsProject(projectId, ownerUserId);
    const result = await this.pool.query(
      `INSERT INTO project_updates(project_id, author_id, title, body, status, photo_url, published_at)
       VALUES ($1,$2,$3,$4,'published',$5,now()) RETURNING *`,
      [projectId, ownerUserId, body.slice(0, 80), body, photoUrl || null],
    );
    const update = mapProjectUpdateRow(result.rows[0]);
    // Cadence tracking (024): bump last update + immutable history when columns exist.
    await this.pool.query(
      `UPDATE projects
       SET last_owner_status_update_at = now(),
           status_update_overdue_flagged_at = NULL,
           status_update_overdue_flagged_by = NULL,
           updated_at = now()
       WHERE id = $1`,
      [projectId],
    ).catch(() => {});
    await this.pool.query(
      `INSERT INTO project_status_update_history(project_id, author_id, source, body, project_update_id)
       VALUES ($1,$2,'owner_update',$3,$4)`,
      [projectId, ownerUserId, body.slice(0, 4000), update.id],
    ).catch(() => {});
    await audit(this.pool, ownerUserId, 'project_update.created', 'project_update', update.id, update);
    return update;
  };

  // --- Milestones ---
  proto.listProjectMilestones = async function listProjectMilestones(projectId, { actorId = null, asOwner = false } = {}) {
    if (asOwner && actorId) await this._assertOwnsProject(projectId, actorId);
    const result = await this.pool.query(
      `SELECT * FROM project_use_of_funds_items WHERE project_id=$1 ORDER BY sort_order ASC, created_at ASC`,
      [projectId],
    );
    return result.rows.map(mapMilestoneRow);
  };

  proto.upsertOwnerProjectMilestone = async function upsertOwnerProjectMilestone(
    projectId,
    ownerUserId,
    { id = null, title, description, status = 'planned', sortOrder = 0 } = {},
  ) {
    await this._assertOwnsProject(projectId, ownerUserId);
    const st = String(status || 'planned');
    if (!['planned', 'in_progress', 'done'].includes(st)) {
      throw new DomainError('INVALID_MILESTONE_STATUS', 'status must be planned|in_progress|done', 400);
    }
    const t = String(title || '').trim();
    if (t.length < 1) throw new DomainError('TITLE_REQUIRED', 'title is required', 400);
    if (id) {
      const updated = await this.pool.query(
        `UPDATE project_use_of_funds_items SET
           title=$3, description=$4, status=$5, sort_order=$6, updated_at=now()
         WHERE id=$1 AND project_id=$2
         RETURNING *`,
        [id, projectId, t, description || null, st, Number(sortOrder) || 0],
      );
      if (!updated.rowCount) throw new DomainError('MILESTONE_NOT_FOUND', 'Milestone not found', 404);
      return mapMilestoneRow(updated.rows[0]);
    }
    const inserted = await this.pool.query(
      `INSERT INTO project_use_of_funds_items(project_id, title, description, status, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [projectId, t, description || null, st, Number(sortOrder) || 0],
    );
    const milestone = mapMilestoneRow(inserted.rows[0]);
    await audit(this.pool, ownerUserId, 'project_milestone.upserted', 'project_milestone', milestone.id, milestone);
    return milestone;
  };

  proto.deleteOwnerProjectMilestone = async function deleteOwnerProjectMilestone(projectId, milestoneId, ownerUserId) {
    await this._assertOwnsProject(projectId, ownerUserId);
    const deleted = await this.pool.query(
      `DELETE FROM project_use_of_funds_items WHERE id=$1 AND project_id=$2 RETURNING id`,
      [milestoneId, projectId],
    );
    if (!deleted.rowCount) throw new DomainError('MILESTONE_NOT_FOUND', 'Milestone not found', 404);
    await audit(this.pool, ownerUserId, 'project_milestone.deleted', 'project_milestone', milestoneId, { projectId });
    return { deleted: true, id: milestoneId };
  };

  // --- Funding pause/close requests ---
  proto.requestOwnerFundingAction = async function requestOwnerFundingAction(
    projectId,
    ownerUserId,
    { requestType, reason } = {},
  ) {
    const type = String(requestType || '').trim();
    if (!['pause', 'close'].includes(type)) {
      throw new DomainError('INVALID_REQUEST_TYPE', 'requestType must be pause or close', 400);
    }
    const r = String(reason || '').trim();
    if (r.length < 5) throw new DomainError('REASON_REQUIRED', 'reason must be at least 5 characters', 400);
    const project = await this._assertOwnsProject(projectId, ownerUserId);
    if (!['published', 'paused'].includes(project.status) && type === 'pause') {
      throw new DomainError('INVALID_STATUS', 'Pause requests only for published projects', 409);
    }
    if (!['published', 'paused'].includes(project.status) && type === 'close') {
      throw new DomainError('INVALID_STATUS', 'Close requests only for published/paused projects', 409);
    }
    const inserted = await this.pool.query(
      `INSERT INTO project_funding_requests(project_id, owner_user_id, request_type, reason)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [projectId, ownerUserId, type, r],
    );
    const req = mapFundingRequestRow(inserted.rows[0]);
    await audit(this.pool, ownerUserId, 'project_funding_request.created', 'project_funding_request', req.id, req);
    return req;
  };

  proto.listAdminFundingRequests = async function listAdminFundingRequests({ status = 'pending' } = {}) {
    const params = [];
    let sql = `
      SELECT fr.*, p.title AS project_title
      FROM project_funding_requests fr
      JOIN projects p ON p.id = fr.project_id
      WHERE 1=1`;
    if (status) {
      params.push(status);
      sql += ` AND fr.status = $${params.length}`;
    }
    sql += ' ORDER BY fr.created_at DESC';
    const result = await this.pool.query(sql, params);
    return result.rows.map(mapFundingRequestRow);
  };

  proto.reviewAdminFundingRequest = async function reviewAdminFundingRequest(
    requestId,
    actorId,
    { approve = true, reviewNote = '' } = {},
  ) {
    const locked = await this.pool.query(`SELECT * FROM project_funding_requests WHERE id=$1`, [requestId]);
    if (!locked.rowCount) throw new DomainError('REQUEST_NOT_FOUND', 'Funding request not found', 404);
    const row = locked.rows[0];
    if (row.status !== 'pending') {
      throw new DomainError('REQUEST_NOT_PENDING', `Request already ${row.status}`, 409);
    }
    if (approve) {
      if (row.request_type === 'pause') {
        await this.pauseProject(row.project_id, actorId, row.reason);
      } else {
        await this.closeFunding(row.project_id, actorId, row.reason);
      }
    }
    const updated = await this.pool.query(
      `UPDATE project_funding_requests SET
         status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4, updated_at=now()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [requestId, approve ? 'approved' : 'rejected', actorId, reviewNote || null],
    );
    if (!updated.rowCount) throw new DomainError('REQUEST_NOT_PENDING', 'Request already resolved', 409);
    const req = mapFundingRequestRow(updated.rows[0]);
    await audit(
      this.pool,
      actorId,
      approve ? 'project_funding_request.approved' : 'project_funding_request.rejected',
      'project_funding_request',
      req.id,
      req,
    );
    return req;
  };

  proto.downloadOwnerReportPdf = async function downloadOwnerReportPdf(ownerUserId) {
    const summary = await this.getOwnerReportSummary(ownerUserId);
    const metrics = await this.getOwnerHomeMetrics(ownerUserId);
    const progressLines = (metrics.fundingProgress || []).slice(0, 12).map((p) => {
      const pct = Math.round((Number(p.ratio) || 0) * 100);
      return `- ${String(p.title || p.projectId || 'project').slice(0, 40)}: ${pct}% (${p.unitsSold}/${p.unitsTarget} units)`;
    });
    const bodyLines = [
      `Generated: ${summary.generatedAt}`,
      `Owner: ${ownerUserId}`,
      '',
      `Total fundraise (poisha): ${summary.totalFundraisePoisha}`,
      `Published projects: ${summary.publishedProjectsCount}`,
      `Shares sold: ${summary.sharesSoldCount}`,
      '',
      'Share sales by category:',
      ...summary.shareSalesByCategory.map(
        (c) => `- ${c.category}: ${c.unitsSold} units / ${c.investmentPoisha} poisha`,
      ),
      '',
      'Per-project funding progress:',
      ...(progressLines.length ? progressLines : ['- (none)']),
      '',
      'Withdrawals: not available in staging.',
      'Staging data may be fictional demo seed.',
    ];
    const pdf = buildFictionalPlaceholderPdf({
      title: 'Owner fundraise summary report',
      bodyLines,
    });
    return {
      filename: `owner-report-${ownerUserId.slice(0, 8)}.pdf`,
      contentType: 'application/pdf',
      body: pdf,
      summary,
      fictionalBanner: FICTIONAL_BANNER,
    };
  };

  proto.uploadOwnerProjectPhoto = async function uploadOwnerProjectPhoto(
    projectId,
    ownerUserId,
    { filename, mimeType, base64Content, requestContext = {} } = {},
  ) {
    await this._assertOwnsProject(projectId, ownerUserId);
    if (!base64Content) throw new DomainError('DOCUMENT_CONTENT_REQUIRED', 'base64Content is required', 400);
    const buffer = Buffer.from(String(base64Content), 'base64');
    const { sanitizedFilename, ext } = assertProjectPhotoUpload({
      filename,
      mimeType,
      byteSize: buffer.length,
    });
    const scan = runMalwareScanStub({ mimeType });
    if (scan.status === 'stub_rejected') {
      throw new DomainError('DOCUMENT_SCAN_REJECTED', scan.note, 400);
    }
    const storageKey = newStorageKey({ ownerUserId, kind: 'project_photo', ext });
    const put = await photoStore.putObject({ storageKey, buffer });
    const hash = sha256Buffer(buffer);

    return withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT photo_document_ids FROM projects WHERE id=$1 FOR UPDATE`,
        [projectId],
      );
      if (!locked.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
      const existing = Array.isArray(locked.rows[0].photo_document_ids)
        ? locked.rows[0].photo_document_ids.map(String)
        : [];
      if (existing.length >= 10) {
        throw new DomainError('PROJECT_PHOTO_LIMIT', 'Maximum 10 project photos', 400);
      }
      const inserted = await client.query(
        `INSERT INTO private_documents(
           owner_user_id, subject_type, subject_id, document_kind, original_filename, sanitized_filename,
           mime_type, byte_size, content_sha256, storage_backend, storage_key, is_fictional_demo,
           fictional_banner, malware_scan_status, review_status
         ) VALUES ($1,'project',$2,'project_photo',$3,$4,$5,$6,$7,$8,$9,true,$10,$11,'submitted')
         RETURNING *`,
        [
          ownerUserId,
          projectId,
          filename,
          sanitizedFilename,
          mimeType,
          buffer.length,
          hash,
          put.backend || photoStore.backend,
          storageKey,
          FICTIONAL_BANNER,
          scan.status,
        ],
      );
      const doc = inserted.rows[0];
      const nextIds = [...existing, doc.id];
      await client.query(
        `UPDATE projects SET photo_document_ids=$2::jsonb, updated_at=now() WHERE id=$1`,
        [projectId, JSON.stringify(nextIds)],
      );
      await client.query(
        `INSERT INTO private_document_access_logs(document_id, actor_id, action, ip_address, user_agent)
         VALUES ($1,$2,'upload',$3::inet,$4)`,
        [doc.id, ownerUserId, requestContext.ip || null, requestContext.userAgent || null],
      );
      const signed = photoStore.createSignedUrl({ documentId: doc.id, actorId: ownerUserId, ttlSeconds: 120 });
      return {
        documentId: doc.id,
        photoDocumentIds: nextIds,
        mimeType: doc.mime_type,
        byteSize: Number(doc.byte_size),
        sanitizedFilename: doc.sanitized_filename,
        fictionalBanner: FICTIONAL_BANNER,
        malwareScanStatus: doc.malware_scan_status,
        signedUrl: signed,
        note: 'Private storage key only — no public permanent URL. FICTIONAL DEMO label applied.',
      };
    });
  };

  proto.listOwnerProjectPhotoSignedUrls = async function listOwnerProjectPhotoSignedUrls(
    projectId,
    actorId,
    { asOwner = false, roles = [] } = {},
  ) {
    const result = await this.pool.query(
      `SELECT p.id, p.status, p.photo_document_ids, b.owner_user_id
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       WHERE p.id=$1`,
      [projectId],
    );
    if (!result.rowCount) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    const row = result.rows[0];
    const isOwner = row.owner_user_id === actorId;
    const publishedOk = ['published', 'funding_closed', 'active', 'completed'].includes(row.status);
    const isStaff = (roles || []).some((r) =>
      ['super_admin', 'compliance_reviewer', 'finance_officer', 'project_reviewer'].includes(r),
    );
    if (asOwner && !isOwner && !isStaff) {
      throw new DomainError('FORBIDDEN', 'Not your project', 403);
    }
    if (!asOwner && !isOwner && !isStaff && !publishedOk) {
      throw new DomainError('FORBIDDEN', 'Photos only available for published projects', 403);
    }
    const ids = Array.isArray(row.photo_document_ids) ? row.photo_document_ids.map(String) : [];
    const photos = [];
    for (const documentId of ids) {
      const signed = photoStore.createSignedUrl({ documentId, actorId, ttlSeconds: 120 });
      photos.push({
        documentId,
        signedUrl: signed,
        fictionalBanner: FICTIONAL_BANNER,
      });
    }
    return {
      projectId,
      status: row.status,
      photoDocumentIds: ids,
      photos,
      fictionalBanner: FICTIONAL_BANNER,
    };
  };

  proto.setOwnerProjectPhotoDocumentIds = async function setOwnerProjectPhotoDocumentIds(
    projectId,
    ownerUserId,
    photoDocumentIds,
  ) {
    await this._assertOwnsProject(projectId, ownerUserId);
    const ids = Array.isArray(photoDocumentIds)
      ? photoDocumentIds.map(String).filter(Boolean).slice(0, 10)
      : [];
    if (ids.length) {
      const docs = await this.pool.query(
        `SELECT id FROM private_documents
         WHERE id = ANY($1::uuid[])
           AND owner_user_id=$2
           AND document_kind='project_photo'`,
        [ids, ownerUserId],
      );
      if (docs.rowCount !== ids.length) {
        throw new DomainError('PROJECT_PHOTO_INVALID', 'All photo documents must be owned project_photo uploads', 400);
      }
    }
    await this.pool.query(
      `UPDATE projects SET photo_document_ids=$2::jsonb, updated_at=now() WHERE id=$1`,
      [projectId, JSON.stringify(ids)],
    );
    return this.getOwnerProject(projectId, ownerUserId);
  };

    /** Called from submitOwnerProject — ensure fee is submitted/verified/waived. */
  proto.assertReviewFeeReadyForSubmit = async function assertReviewFeeReadyForSubmit(projectId, client) {
    const fee = await client.query(`SELECT * FROM project_review_fees WHERE project_id=$1`, [projectId]);
    if (!fee.rowCount || fee.rows[0].status === 'unpaid') {
      throw new DomainError(
        'REVIEW_FEE_REQUIRED',
        'Submit fictional cash/bank review fee before/at submit-for-review (status submitted/verified/waived)',
        402,
      );
    }
    if (!['submitted', 'verified', 'waived'].includes(fee.rows[0].status)) {
      throw new DomainError('REVIEW_FEE_REQUIRED', 'Review fee must be submitted, verified, or waived', 402);
    }
    return mapReviewFeeRow(fee.rows[0]);
  };
}

/** Patch mapProjectRow-compatible public view extras for investors. */
export function publicOwnerPackView(project) {
  if (!project) return null;
  const base = publicProjectView(project);
  return {
    ...base,
    locationAddress: project.locationAddress || null,
    photoUrls: project.photoUrls || [],
    photoDocumentIds: project.photoDocumentIds || [],
    detailsText: project.detailsText || null,
    investmentYears: project.investmentYears,
    estimatedYearlyProfitBps: project.estimatedYearlyProfitBps,
    badLossSummary: project.badLossSummary || null,
    ownerExperience: project.ownerExperience || null,
    educationalBackground: project.educationalBackground || null,
    fundingProgress: project.fundingProgress || null,
  };
}
