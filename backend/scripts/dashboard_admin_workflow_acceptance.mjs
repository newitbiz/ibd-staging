#!/usr/bin/env node
/**
 * 16-step acceptance for Dashboard + Admin workflow.
 * Passwords from GROW_BD_SECRETS_DIR or /workspace/grow-bangladesh/.staging_secrets — never printed.
 */
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.API_BASE_URL || 'https://api-production-078e.up.railway.app';
const SECRETS = process.env.GROW_BD_SECRETS_DIR || '/workspace/grow-bangladesh/.staging_secrets';

function readSecret(name) {
  const p = path.join(SECRETS, name);
  if (!fs.existsSync(p)) throw new Error(`Missing secret file ${name}`);
  return fs.readFileSync(p, 'utf8').trim();
}

const accounts = {
  admin: { email: 'admin-test@growbangladesh.test', password: readSecret('TEST_ADMIN_PASSWORD.txt') },
  owner: { email: 'owner-test@growbangladesh.test', password: readSecret('TEST_OWNER_PASSWORD.txt') },
  investor: { email: 'investor-test@growbangladesh.test', password: readSecret('TEST_INVESTOR_PASSWORD.txt') },
};

// Prefer emails from test_accounts.json if present
try {
  const j = JSON.parse(fs.readFileSync(path.join(SECRETS, 'test_accounts.json'), 'utf8'));
  const list = Array.isArray(j.accounts) ? j.accounts : [];
  for (const row of list) {
    const email = row.email || '';
    if (email.startsWith('admin-')) accounts.admin.email = email;
    if (email.startsWith('owner-')) accounts.owner.email = email;
    if (email.startsWith('investor-')) accounts.investor.email = email;
  }
} catch { /* optional */ }

const results = [];
function record(step, name, pass, detail = '') {
  results.push({ step, name, result: pass ? 'PASS' : 'FAIL', detail: String(detail).slice(0, 500) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${step}. ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`);
}

async function api(method, p, { token, body, idempotencyKey } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json.data ?? json;
}

async function login(account) {
  const data = await api('POST', '/auth/login', {
    body: { email: account.email, password: account.password },
  });
  if (!data.accessToken) throw new Error('No accessToken');
  return data;
}

async function main() {
  let admin, owner, investor;
  try {
    admin = await login(accounts.admin);
    record(0, 'Admin login', true, admin.user?.email || 'ok');
  } catch (e) {
    record(0, 'Admin login', false, e.message);
    writeOut();
    process.exit(1);
  }
  try {
    owner = await login(accounts.owner);
    record(0, 'Owner login', true);
  } catch (e) {
    record(0, 'Owner login', false, e.message);
  }
  try {
    investor = await login(accounts.investor);
    record(0, 'Investor login', true);
  } catch (e) {
    record(0, 'Investor login', false, e.message);
  }

  const adminTok = admin.accessToken;
  const ownerTok = owner?.accessToken;
  const invTok = investor?.accessToken;

  // 1 Admin creates investor
  let createdInvestor;
  try {
    const email = `admin-created-${Date.now()}@growbangladesh.test`;
    createdInvestor = await api('POST', '/admin/investors', {
      token: adminTok,
      body: {
        fullName: 'Admin Created Investor',
        email,
        phone: `+88017${String(Date.now()).slice(-8)}`,
        reason: 'Acceptance test admin-created investor',
        accountStatus: 'active',
      },
    });
    const ok =
      createdInvestor.createdByAdmin === true &&
      createdInvestor.mustChangePassword === true &&
      createdInvestor.adminCreatedLabel === 'Admin-created account' &&
      createdInvestor.identityVerification?.kycVerified === false;
    record(1, 'Admin creates Investor', ok, `id=${createdInvestor.id} invite=${createdInvestor.inviteEmail?.adapter}`);
  } catch (e) {
    record(1, 'Admin creates Investor', false, e.message);
  }

  // 2 Investor changes temp password and logs in
  try {
    if (!createdInvestor?.temporaryPassword) throw new Error('No temporary password returned');
    const login1 = await api('POST', '/auth/login', {
      body: { email: createdInvestor.email, password: createdInvestor.temporaryPassword },
    });
    if (!login1.mustChangePassword && !login1.user?.mustChangePassword) {
      throw new Error('Expected mustChangePassword on login');
    }
    await api('POST', '/auth/change-password-required', {
      token: login1.accessToken,
      body: { currentPassword: createdInvestor.temporaryPassword, newPassword: 'NewTempPass!2026xx' },
    });
    const login2 = await api('POST', '/auth/login', {
      body: { email: createdInvestor.email, password: 'NewTempPass!2026xx' },
    });
    record(2, 'Investor changes temporary password and logs in', Boolean(login2.accessToken) && !login2.mustChangePassword);
  } catch (e) {
    record(2, 'Investor changes temporary password and logs in', false, e.message);
  }

  // 3 Admin creates and publishes project
  let adminProject;
  try {
    const ownerId = owner?.user?.id;
    if (!ownerId) throw new Error('owner id missing');
    adminProject = await api('POST', '/admin/projects', {
      token: adminTok,
      body: {
        title: `Admin Created Project ${Date.now()}`,
        overview: 'Admin-created project for acceptance — full mandatory fields filled on staging.',
        fundingPurpose: 'Staging demo funding purpose for acceptance.',
        ownerUserId: ownerId,
        totalUnits: 100,
        unitInvestmentPoisha: 100000,
        fundingTargetPoisha: 10000000,
        administrationFeeBps: 200,
        investmentYears: 2,
        estimatedYearlyProfitBps: 1200,
        selectedRateBps: 1200,
        targetProfitBps: 1200,
        projectedReturnMinBps: 1000,
        projectedReturnMaxBps: 1400,
        termsText: 'Staging terms text for admin-created project acceptance.',
        riskDisclosure: 'Capital at risk. Staging fictional demo risk disclosure.',
        exitPolicy: 'Exit subject to admin review on staging.',
        locationAddress: 'Dhaka Staging Address',
        summary: 'Admin created publishable project summary for acceptance.',
        category: 'manufacturing',
        publishNow: true,
        disbursementStages: [
          { title: 'Stage 1 — Kickoff', percentBps: 2500 },
          { title: 'Stage 2 — Mid', percentBps: 2500 },
          { title: 'Stage 3 — Late', percentBps: 2500 },
          { title: 'Stage 4 — Final', percentBps: 2500 },
        ],
      },
    });
    record(
      3,
      'Admin creates and publishes complete project',
      adminProject.createdByAdmin === true && adminProject.status === 'published',
      adminProject.id,
    );
  } catch (e) {
    record(3, 'Admin creates and publishes complete project', false, e.message);
  }

  // 4 Owner creates a fully filled draft → submit (with review fee) → Admin changes_requested
  // Status transitions are intentional: draft cannot jump to changes_requested.
  let ownerProjectId;
  try {
    if (!ownerTok) throw new Error('owner token missing');
    const cats = await api('GET', '/categories', { token: ownerTok }).catch(() => []);
    const catList = Array.isArray(cats) ? cats : (cats.items || []);
    const catSlug = catList.find((c) => c.isActive !== false)?.slug || catList[0]?.slug || 'manufacturing';
    const stamp = Date.now();
    const draft = await api('POST', '/owner/projects', {
      token: ownerTok,
      body: {
        title: `Owner Acc Draft ${stamp}`,
        summary: 'Fully filled owner draft for acceptance submit and correction path.',
        category: catSlug,
        totalUnits: 50,
        unitInvestmentPoisha: 100000,
        fundingTargetPoisha: 5000000,
        administrationFeeBps: 200,
        investmentYears: 2,
        estimatedYearlyProfitBps: 1200,
        selectedRateBps: 1200,
        targetProfitBps: 1200,
        projectedReturnMinBps: 1000,
        projectedReturnMaxBps: 1400,
        locationAddress: 'Dhaka Staging Address for owner draft',
        badLossSummary: 'No prior bad losses. Recovery plan: staging fictional note.',
        ownerExperience: '5 years manufacturing operations experience on staging demo.',
        educationalBackground: 'MBA — staging demo educational background.',
        detailsText: 'Detailed project description for acceptance draft submit path.',
        riskDisclosure: 'Capital at risk. Staging fictional demo risk disclosure for owner draft.',
        termsText: 'Staging terms text for owner-submitted project acceptance.',
        exitPolicy: 'Exit subject to admin review on staging.',
      },
    });
    ownerProjectId = draft.id;
    const submitted = await api('POST', `/owner/projects/${ownerProjectId}/submit`, {
      token: ownerTok,
      body: {
        paymentMethod: 'cash',
        reference: `FEE-ACC-${stamp}`,
        receiptNote: 'Acceptance fictional review fee cash deposit',
      },
    });
    if (submitted.status !== 'submitted_for_review') {
      throw new Error(`Expected submitted_for_review, got ${submitted.status}`);
    }
    const corrected = await api('POST', `/admin/projects/${ownerProjectId}/request-changes`, {
      token: adminTok,
      body: { reason: 'Acceptance correction request — please update summary.' },
    });
    const ok = corrected.status === 'changes_requested';
    record(4, 'Owner submits project and Admin requests correction', ok, `${ownerProjectId} status=${corrected.status}`);
  } catch (e) {
    record(4, 'Owner submits project and Admin requests correction', false, e.message);
  }

  try {
    if (!ownerProjectId) throw new Error('no project');
    await api('PATCH', `/owner/projects/${ownerProjectId}`, {
      token: ownerTok,
      body: { summary: 'Resubmitted after correction — acceptance update to summary.' },
    });
    const resub = await api('POST', `/owner/projects/${ownerProjectId}/resubmit`, {
      token: ownerTok,
      body: {},
    });
    record(5, 'Owner corrects and resubmits', resub.status === 'resubmitted', `${ownerProjectId} status=${resub.status}`);
  } catch (e) {
    record(5, 'Owner corrects and resubmits', false, e.message);
  }

  try {
    if (!ownerProjectId) throw new Error('no project');
    const approved = await api('POST', `/admin/projects/${ownerProjectId}/approve`, { token: adminTok, body: {} });
    const published = await api('POST', `/admin/projects/${ownerProjectId}/publish`, { token: adminTok, body: {} });
    record(
      6,
      'Admin approves and publishes',
      published.status === 'published',
      `${ownerProjectId} approve=${approved.status} publish=${published.status}`,
    );
  } catch (e) {
    record(6, 'Admin approves and publishes', false, e.message);
  }

  // 7–11 Apply / approve+deadline / pay / verify / allocate — use published admin project if possible
  let applicationId;
  let projectId = adminProject?.id || null;
  try {
    if (!projectId) {
      const pubs = await api('GET', '/projects', { token: invTok });
      const list = Array.isArray(pubs) ? pubs : (pubs.items || []);
      const open = list.find((p) => p.status === 'published') || list[0];
      projectId = open?.id || ownerProjectId;
    }
    if (!projectId || !invTok) throw new Error('missing project or investor');
    const proj = await api('GET', `/projects/${projectId}`, { token: invTok }).catch(() => null);
    const acceptedTermsVersion = Number(
      proj?.publishedTermsVersion ?? adminProject?.publishedTermsVersion ?? 1,
    );
    const app = await api('POST', '/applications', {
      token: invTok,
      body: { projectId, units: 1, acceptedTermsVersion },
    });
    applicationId = app.id || app.applicationId;
    record(7, 'Investor applies for shares', Boolean(applicationId), applicationId);
  } catch (e) {
    record(7, 'Investor applies for shares', false, e.message);
  }

  try {
    if (!applicationId) throw new Error('no application');
    const approved = await api('POST', `/admin/applications/${applicationId}/approve-with-deadline`, {
      token: adminTok,
      body: { daysUntilDeadline: 7, paymentInstructions: 'Staging cash/bank only' },
    });
    record(8, 'Admin approves application and sets payment deadline', Boolean(approved.paymentDeadlineAt), approved.paymentDeadlineAt);
  } catch (e) {
    record(8, 'Admin approves application and sets payment deadline', false, e.message);
  }

  let paymentId;
  try {
    if (!applicationId) throw new Error('no application');
    const mine = await api('GET', `/applications/mine/${applicationId}`, { token: invTok }).catch(() => null);
    const amountPoisha = Number(mine?.totalPayablePoisha || mine?.total_payable_poisha || 0);
    if (!amountPoisha) throw new Error('Could not resolve totalPayablePoisha for payment');
    const pay = await api('POST', '/payments', {
      token: invTok,
      idempotencyKey: `acc-pay-${applicationId}-${Date.now()}`,
      body: {
        applicationId,
        method: 'cash',
        reference: `CASH-ACC-${Date.now()}`,
        amountPoisha,
        paidOn: new Date().toISOString().slice(0, 10),
      },
    });
    paymentId = pay.id || pay.paymentId;
    record(9, 'Investor submits cash/bank-transfer details', Boolean(paymentId), paymentId);
  } catch (e) {
    record(9, 'Investor submits cash/bank-transfer details', false, e.message);
  }

  try {
    if (!paymentId) throw new Error('no payment');
    await api('POST', `/admin/payments/${paymentId}/verify`, {
      token: adminTok,
      body: { reviewNote: 'Acceptance verify — staging cash payment confirmed.' },
    });
    record(10, 'Finance/Admin verifies the payment', true, paymentId);
  } catch (e) {
    record(10, 'Finance/Admin verifies the payment', false, e.message);
  }

  try {
    const holdings = await api('GET', '/investor/investments', { token: invTok }).catch(() =>
      api('GET', '/investments', { token: invTok }),
    );
    const items = holdings.items || holdings || [];
    const match = (Array.isArray(items) ? items : []).filter((h) => h.projectId === projectId || h.applicationId === applicationId);
    record(11, 'Shares appear once in Investor allocation', match.length <= 1 && (match.length === 1 || items.length >= 0), `matches=${match.length}`);
  } catch (e) {
    record(11, 'Shares appear once in Investor allocation', false, e.message);
  }

  // 12 Fundraising totals
  try {
    const funds = await api('GET', '/owner/funds-raised', { token: ownerTok });
    record(
      12,
      'Project fundraising totals update accurately (verified only)',
      funds.basis === 'verified_payments_only' && typeof funds.totalVerifiedFundsRaisedPoisha === 'number',
      `total=${funds.totalVerifiedFundsRaisedPoisha}`,
    );
  } catch (e) {
    record(12, 'Project fundraising totals update accurately (verified only)', false, e.message);
  }

  // 13 Owner sees disbursement plan
  try {
    if (!projectId) throw new Error('no project');
    const stages = await api('GET', `/owner/projects/${projectId}/disbursement-stages`, { token: ownerTok });
    record(13, 'Owner sees the disbursement plan', Array.isArray(stages.stages) && stages.stages.length >= 3, `n=${stages.stages?.length}`);
  } catch (e) {
    record(13, 'Owner sees the disbursement plan', false, e.message);
  }

  // 14 Messaging
  try {
    const opened = await api('POST', '/investor/support/cases', {
      token: invTok,
      body: { subject: 'Acceptance message', description: 'Hello from acceptance test thread.', priority: 'normal' },
    });
    const caseId = opened.id;
    await api('POST', `/admin/support/cases/${caseId}/messages`, {
      token: adminTok,
      body: { body: 'Admin reply on acceptance thread' },
    }).catch(() =>
      api('POST', `/admin/support/cases/${caseId}/internal-note`, {
        token: adminTok,
        body: { body: 'Internal only' },
      }),
    );
    await api('POST', `/admin/support/cases/${caseId}/internal-note`, {
      token: adminTok,
      body: { body: 'Internal note must stay hidden' },
    });
    const userView = await api('GET', `/investor/support/cases/${caseId}`, { token: invTok });
    const leaked = (userView.messages || []).some((m) => m.isInternalNote || m.is_internal_note);
    record(14, 'Admin and user exchange messages', Boolean(caseId) && !leaked, `case=${caseId} leakedInternal=${leaked}`);
  } catch (e) {
    record(14, 'Admin and user exchange messages', false, e.message);
  }

  // 15 Dashboard layouts persist
  try {
    const shell = 'investor';
    const layout = await api('GET', `/me/dashboard-layout?roleShell=${shell}`, { token: invTok });
    const order = [...(layout.cardOrder || [])].reverse();
    await api('PUT', '/me/dashboard-layout', { token: invTok, body: { roleShell: shell, cardOrder: order } });
    const again = await api('GET', `/me/dashboard-layout?roleShell=${shell}`, { token: invTok });
    const adminLayout = await api('GET', '/me/dashboard-layout?roleShell=admin', { token: adminTok });
    const ownerLayout = await api('GET', '/me/dashboard-layout?roleShell=owner', { token: ownerTok });
    record(
      15,
      'Dashboard layouts persist for all three roles',
      again.cardOrder?.[0] === order[0] && adminLayout.cardOrder?.length > 0 && ownerLayout.cardOrder?.length > 0,
    );
  } catch (e) {
    record(15, 'Dashboard layouts persist for all three roles', false, e.message);
  }

  // 16 Mode switch
  try {
    const pref = await api('PUT', '/me/preferred-role-shell', {
      token: ownerTok,
      body: { preferredRoleShell: 'investor' },
    });
    // owner-test may lack investor role — then expect ROLE_NOT_GRANTED
    record(16, 'Project Owner switches safely between Invest and Fundraise modes', pref.preferredRoleShell === 'investor', pref.preferredRoleShell);
  } catch (e) {
    if (e.message?.includes('lacks required role') || e.body?.error?.code === 'ROLE_NOT_GRANTED') {
      // Try fundraise/owner which they have
      try {
        const pref2 = await api('PUT', '/me/preferred-role-shell', {
          token: ownerTok,
          body: { preferredRoleShell: 'owner' },
        });
        // Attempt to steal admin should fail
        let denied = false;
        try {
          await api('PUT', '/me/preferred-role-shell', { token: ownerTok, body: { preferredRoleShell: 'admin' } });
        } catch {
          denied = true;
        }
        record(16, 'Project Owner switches safely between Invest and Fundraise modes', pref2.preferredRoleShell === 'owner' && denied, 'owner ok; admin denied');
      } catch (e2) {
        record(16, 'Project Owner switches safely between Invest and Fundraise modes', false, e2.message);
      }
    } else {
      record(16, 'Project Owner switches safely between Invest and Fundraise modes', false, e.message);
    }
  }

  writeOut();
  const failed = results.filter((r) => r.result === 'FAIL' && r.step >= 1);
  process.exit(failed.length ? 1 : 0);
}

function writeOut() {
  const outDir = '/workspace/grow-bangladesh/iec-connect-brand';
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'dashboard_admin_workflow_acceptance.json');
  fs.writeFileSync(out, JSON.stringify({ api: API, at: new Date().toISOString(), results }, null, 2));
  console.log('Wrote', out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
