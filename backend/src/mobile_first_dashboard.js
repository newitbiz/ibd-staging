/**
 * Mobile-first dashboard helpers — investor summary enrichment, owner fundraising vs
 * personal-invest separation, project share links (no owner PII), projection labeling.
 * Attached onto PostgresGrowBangladeshService.prototype.
 */
import { DomainError } from './domain.js';
import { assertSafeInteger } from './project_workflow.js';

/** Exact label required on projected earnings in UI and API. */
export const PROJECTION_ONLY_LABEL = 'Projection only—not guaranteed';

/**
 * Integer-poisha projection: trunc toward zero.
 * Never add projected into confirmed / available / withdrawable.
 */
export function calcProjectedProfitPoisha({
  principalPoisha,
  annualReturnBps,
  elapsedDays,
  dayCountBasis = 365,
}) {
  const principal = assertSafeInteger(principalPoisha, 'principalPoisha', 0);
  const bps = assertSafeInteger(annualReturnBps, 'annualReturnBps', 0);
  const days = assertSafeInteger(elapsedDays, 'elapsedDays', 0);
  const basis = assertSafeInteger(dayCountBasis, 'dayCountBasis', 1);
  // (principal * bps * days) / (10000 * basis) — trunc
  return Math.trunc((principal * bps * days) / (10000 * basis));
}

/** Confirmed profit must exclude projection. */
export function assertProjectionNotInConfirmed({ confirmedPoisha, projectedPoisha, availablePoisha, withdrawnPoisha }) {
  const c = assertSafeInteger(confirmedPoisha ?? 0, 'confirmedPoisha', 0);
  const p = assertSafeInteger(projectedPoisha ?? 0, 'projectedPoisha', 0);
  const a = assertSafeInteger(availablePoisha ?? 0, 'availablePoisha', 0);
  const w = assertSafeInteger(withdrawnPoisha ?? 0, 'withdrawnPoisha', 0);
  // Soft invariant for docs/tests: available and withdrawn must not silently include projection.
  return {
    confirmedPoisha: c,
    projectedPoisha: p,
    availablePoisha: a,
    withdrawnPoisha: w,
    projectionLabel: PROJECTION_ONLY_LABEL,
    projectionCountedAsConfirmed: false,
    projectionCountedAsAvailable: false,
    projectionCountedAsWithdrawable: false,
  };
}

export function buildProjectSharePayload({
  projectId,
  projectTitle,
  projectSlug,
  referralCode,
  webBase,
}) {
  if (!projectId) throw new DomainError('PROJECT_REQUIRED', 'projectId required', 400);
  const base = String(webBase || process.env.STAGING_WEB_BASE_URL || 'https://web-production-ba84bb.up.railway.app').replace(/\/$/, '');
  const code = referralCode ? String(referralCode) : null;
  const path = projectSlug ? `/p/${encodeURIComponent(projectSlug)}` : `/projects/${encodeURIComponent(projectId)}`;
  const url = code
    ? `${base}${path}?ref=${encodeURIComponent(code)}`
    : `${base}${path}`;
  const shareText = code
    ? `Explore ${projectTitle || 'this project'} on Invest in Bd. Referral code ${code}: ${url}`
    : `Explore ${projectTitle || 'this project'} on Invest in Bd: ${url}`;
  return {
    projectId,
    projectTitle: projectTitle || null,
    projectSlug: projectSlug || null,
    referralCode: code,
    shareUrl: url,
    shareText,
    containsOwnerPii: false,
    note: 'Share link uses public project identity + optional referrer code only — never owner phone/email.',
  };
}

export function attachMobileFirstDashboard(proto) {
  /**
   * Enrich investor home with mobile-first summary fields.
   * Calls existing getInvestorHome then adds withdrawn / payable / referral counts.
   */
  const prior = proto.getInvestorHome;
  proto.getInvestorHome = async function getInvestorHomeMobileFirst(investorId) {
    const home = await prior.call(this, investorId);

    const withdrawn = await this.pool.query(
      `SELECT COALESCE(SUM(amount_poisha), 0)::bigint AS total
       FROM referral_reward_payout_requests
       WHERE investor_id=$1 AND status='paid'`,
      [investorId],
    );

    // Available payable = approved referral available + confirmed profit not yet marked paid (display).
    // Confirmed profit stays separate; projection NEVER included.
    const availablePayablePoisha = Number(home.approvedReferralRewardAvailablePoisha || 0);
    const withdrawnPoisha = Number(withdrawn.rows[0].total);

    const referralStats = await this.pool.query(
      `SELECT COUNT(*)::int AS referral_count FROM referrals WHERE referrer_id=$1`,
      [investorId],
    );
    const qualifiedStats = await this.pool.query(
      `SELECT COUNT(*)::int AS qualified_count
       FROM referral_rewards rr
       JOIN referrals r ON r.id = rr.referral_id
       WHERE r.referrer_id=$1 AND rr.status IN ('eligible','approved','paid')`,
      [investorId],
    );

    const activeHoldings = Array.isArray(home.holdings) ? home.holdings.length : 0;

    // Live card-grid counts for Investor Home CustomizableDashboard (no hardcoded UI numbers).
    const [appsPending, appsPayDue, payVerify, exitsOpen, unreadMsg, identityRow] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::int AS c FROM investment_applications
         WHERE investor_id=$1 AND status IN ('submitted','under_review','changes_requested','resubmitted')`,
        [investorId],
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS c FROM investment_applications
         WHERE investor_id=$1 AND status='approved_payment_pending'`,
        [investorId],
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS c FROM payments p
         JOIN investment_applications a ON a.id = p.application_id
         WHERE a.investor_id=$1 AND p.status='verification_pending'`,
        [investorId],
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS c FROM exit_requests er
         JOIN allocations al ON al.id = er.allocation_id
         WHERE al.investor_id=$1 AND er.status IN ('requested','under_review','approved','pending','submitted')`,
        [investorId],
      ),
      this.pool.query(
        `SELECT COALESCE(SUM(unread_for_user),0)::int AS c FROM support_cases WHERE opened_by=$1`,
        [investorId],
      ),
      this.pool.query(
        `SELECT COALESCE(iv.status, ip.kyc_status, 'not_started') AS status
         FROM users u
         LEFT JOIN identity_verifications iv ON iv.user_id = u.id
         LEFT JOIN investor_profiles ip ON ip.user_id = u.id
         WHERE u.id=$1`,
        [investorId],
      ),
    ]);

    const pendingApplicationsCount = appsPending.rows[0]?.c ?? 0;
    const paymentsDueCount = appsPayDue.rows[0]?.c ?? 0;
    const paymentVerificationPendingCount = payVerify.rows[0]?.c ?? 0;
    const exitRequestsCount = exitsOpen.rows[0]?.c ?? 0;
    const unreadMessages = unreadMsg.rows[0]?.c ?? 0;
    const idStatus = String(identityRow.rows[0]?.status || '').toLowerCase();
    const verificationComplete = ['verified', 'approved', 'complete', 'completed'].includes(idStatus);

    const summary = {
      confirmedInvestmentPoisha: Number(home.investmentPoisha || 0),
      allocatedShares: Number(home.shareUnits || 0),
      activeHoldings,
      confirmedProfitPoisha: Number(home.confirmedPoisha || 0),
      projectedProfitPoisha: Number(home.projectedPoisha || 0),
      projectedProfitLabel: PROJECTION_ONLY_LABEL,
      referralCount: referralStats.rows[0].referral_count,
      referralQualifiedCount: qualifiedStats.rows[0].qualified_count,
      referralEarningsPoisha: Number(home.approvedReferralRewardTotalPoisha || 0),
      availablePayablePoisha,
      withdrawnPoisha,
      calcBasis: {
        confirmedInvestment: 'sum(active allocations.investment_poisha)',
        allocatedShares: 'sum(active allocations.units)',
        confirmedProfit: 'approved distributions only — projection excluded',
        projectedProfit: 'estimate only — Projection only—not guaranteed — never withdrawable',
        referralEarnings: 'referral_rewards status in (approved, paid) after qualifying event + admin confirmation',
        availablePayable: 'approved referral reward available (not a wallet)',
        withdrawn: 'referral_reward_payout_requests status=paid',
        fundsRaisedNeverMixed: true,
      },
    };

    return {
      ...home,
      ...assertProjectionNotInConfirmed({
        confirmedPoisha: summary.confirmedProfitPoisha,
        projectedPoisha: summary.projectedProfitPoisha,
        availablePoisha: availablePayablePoisha,
        withdrawnPoisha,
      }),
      summary,
      availablePayablePoisha,
      withdrawnPoisha,
      referralCount: summary.referralCount,
      pendingApplicationsCount,
      paymentsDueCount,
      paymentVerificationPendingCount,
      exitRequestsCount,
      unreadMessages,
      verificationComplete,
      mobileFirst: true,
    };
  };

  /** Owner home: fundraising (verified) vs personal investment — never mixed. */
  proto.getOwnerDashboardSeparation = async function getOwnerDashboardSeparation(ownerUserId) {
    const status = await this.getOwnerStatusCards(ownerUserId);
    const funds = await this.getOwnerFundsRaisedDetail(ownerUserId);
    const personal = await this.listOwnerInvestments(ownerUserId);

    const personalItems = personal.items || [];
    let personalInvestmentPoisha = 0;
    let personalUnits = 0;
    for (const row of personalItems) {
      personalInvestmentPoisha += Number(row.investmentPoisha || 0);
      personalUnits += Number(row.units || 0);
    }

    return {
      fundraising: {
        totalFundsRaisedPoisha: status.totalFundsRaisedPoisha,
        totalFundsRaisedBasis: status.totalFundsRaisedBasis || 'verified_payments_only',
        projects: funds.items || [],
        note: 'Verified non-reversed payments only — never mixes personal invest totals',
      },
      personalInvestment: {
        applicationsCount: personalItems.length,
        investmentPoisha: personalInvestmentPoisha,
        units: personalUnits,
        items: personalItems,
        note: 'Owner applications into other projects — separate from fundraising',
      },
      statusCards: status.cards,
      unreadMessages: status.unreadMessages,
      neverMixed: true,
    };
  };

  /** Project share link with optional referral code — no owner PII. */
  proto.getProjectShareLink = async function getProjectShareLink(actorId, projectId) {
    const p = await this.pool.query(
      `SELECT p.id, p.title, p.slug, p.status,
              b.owner_user_id
       FROM projects p
       JOIN businesses b ON b.id = p.business_id
       WHERE p.id=$1`,
      [projectId],
    );
    if (!p.rows[0]) throw new DomainError('PROJECT_NOT_FOUND', 'Project not found', 404);
    const row = p.rows[0];
    const published = ['published', 'paused', 'funding_closed', 'active', 'completed'].includes(row.status);
    if (!published) {
      throw new DomainError('PROJECT_NOT_SHAREABLE', 'Only published (or later) projects can be shared', 400);
    }

    let referralCode = null;
    try {
      const codeRow = await this.ensureMyReferralCode(actorId);
      referralCode = codeRow?.myReferralCode || codeRow?.referralCode || null;
    } catch {
      const u = await this.pool.query(`SELECT referral_code FROM users WHERE id=$1`, [actorId]);
      referralCode = u.rows[0]?.referral_code || null;
    }

    return buildProjectSharePayload({
      projectId: row.id,
      projectTitle: row.title,
      projectSlug: row.slug,
      referralCode,
      webBase: process.env.STAGING_WEB_BASE_URL,
    });
  };
}

export default attachMobileFirstDashboard;
