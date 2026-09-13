#!/usr/bin/env node
/**
 * Collect redacted Phase-2 auth + financial workflow evidence against a live API.
 * Demo password: from DEMO_SEED_PASSWORD env (never commit). Tokens redacted to last 4 chars.
 */
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadEnvFile } from '../src/load_env.js';

loadEnvFile();

const API = process.env.EVIDENCE_BASE_URL || 'http://127.0.0.1:8080';
const DEMO_PASSWORD = process.env.DEMO_SEED_PASSWORD;
if (!DEMO_PASSWORD) {
  console.error('Set DEMO_SEED_PASSWORD before collecting evidence');
  process.exit(1);
}
const directory = path.dirname(fileURLToPath(import.meta.url));
const defaultOut = path.join(directory, '..', '..', 'docs', 'test-evidence', 'phase2-auth-postgres-evidence.json');
const OUT = process.env.EVIDENCE_OUT || defaultOut;

function redactValue(key, value) {
  if (typeof value !== 'string') return value;
  const k = String(key).toLowerCase();
  if (['accesstoken', 'refreshtoken', 'oldrefreshtoken', 'resettoken', 'previewcode', 'authorization', 'token'].includes(k)) {
    return value.length > 4 ? `…${value.slice(-4)}` : '…';
  }
  if (k.includes('password') || k === 'jwtssecret') return '[REDACTED]';
  return value;
}

function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redactValue(k, redact(v));
    return out;
  }
  return obj;
}

async function req(method, pathname, { body, token, idempotencyKey, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (idempotencyKey) h['idempotency-key'] = idempotencyKey;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

function step(name, result, extra = {}) {
  return {
    name,
    httpStatus: result.status,
    response: redact(result.body),
    ...extra,
  };
}

function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: path.join(directory, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const evidence = {
    title: 'Grow Bangladesh Phase-2 auth + Postgres evidence',
    capturedAt: new Date().toISOString(),
    capturedAtAsiaDhakaNote: 'Convert UTC timestamps to Asia/Dhaka (UTC+6) when reporting to user',
    baseUrl: API,
    redaction: 'Tokens/OTP/preview codes/reset tokens truncated to last 4 chars (…xxxx). Demo password never stored in evidence.',
    demoIdentitiesNote: 'Seed *@example.invalid with DEMO_SEED_PASSWORD (demo-only; value not recorded here).',
    steps: [],
    sections: {},
  };

  // Health
  evidence.steps.push(step('health', await req('GET', '/health')));

  // Registration
  const email = `phase2-evidence-${Date.now()}@example.invalid`;
  const password = process.env.EVIDENCE_REGISTER_PASSWORD || 'EvidenceTempPass123!';
  const reg = await req('POST', '/auth/register', {
    body: { email, password, fullName: 'Phase2 Evidence Investor', role: 'investor' },
  });
  evidence.steps.push(step('registration', reg, { email }));
  const challengeId = reg.body?.data?.otp?.challengeId;
  const previewCode = reg.body?.data?.otp?.previewCode;
  const userId = reg.body?.data?.user?.id;

  // OTP verify
  const otp = await req('POST', '/auth/otp/verify', { body: { challengeId, code: previewCode } });
  evidence.steps.push(step('otp_verification', otp));
  let accessToken = otp.body?.data?.accessToken;
  let refreshToken = otp.body?.data?.refreshToken;

  // Login seed investor + other roles
  const investorLogin = await req('POST', '/auth/login', {
    body: { email: 'investor@example.invalid', password: DEMO_PASSWORD },
  });
  evidence.steps.push(step('login_seed_investor', investorLogin));
  const investorAccessToken = investorLogin.body?.data?.accessToken;
  const investorRefresh = investorLogin.body?.data?.refreshToken;

  const otherRegEmail = `phase2-other-${Date.now()}@example.invalid`;
  const otherReg = await req('POST', '/auth/register', {
    body: { email: otherRegEmail, password, fullName: 'Other Investor', role: 'investor' },
  });
  const otherOtp = await req('POST', '/auth/otp/verify', {
    body: {
      challengeId: otherReg.body?.data?.otp?.challengeId,
      code: otherReg.body?.data?.otp?.previewCode,
    },
  });
  evidence.steps.push(step('other_investor_register_verify', otherOtp, { email: otherRegEmail }));
  const otherInvestorAccessToken = otherOtp.body?.data?.accessToken;

  const adminLogin = await req('POST', '/auth/login', {
    body: { email: 'admin@example.invalid', password: DEMO_PASSWORD },
  });
  evidence.steps.push(step('login_admin', adminLogin));
  const adminAccessToken = adminLogin.body?.data?.accessToken;

  const complianceLogin = await req('POST', '/auth/login', {
    body: { email: 'compliance@example.invalid', password: DEMO_PASSWORD },
  });
  evidence.steps.push(step('login_compliance', complianceLogin));
  const complianceAccessToken = complianceLogin.body?.data?.accessToken;

  const financeLogin = await req('POST', '/auth/login', {
    body: { email: 'finance@example.invalid', password: DEMO_PASSWORD },
  });
  evidence.steps.push(step('login_finance', financeLogin));
  const financeAccessToken = financeLogin.body?.data?.accessToken;

  // Token refresh + rotation
  const refreshed = await req('POST', '/auth/token/refresh', { body: { refreshToken } });
  evidence.steps.push(step('token_refresh_rotation', refreshed));
  const oldRefreshToken = refreshToken;
  accessToken = refreshed.body?.data?.accessToken || accessToken;
  refreshToken = refreshed.body?.data?.refreshToken || refreshToken;

  // Old refresh reuse rejection
  const reuse = await req('POST', '/auth/token/refresh', { body: { refreshToken: oldRefreshToken } });
  evidence.steps.push(step('old_refresh_token_reuse_rejection', reuse));

  // Re-login for remaining auth flows after family revoke
  const reLogin = await req('POST', '/auth/login', { body: { email, password } });
  evidence.steps.push(step('relogin_after_reuse_detection', reLogin));
  accessToken = reLogin.body?.data?.accessToken;
  refreshToken = reLogin.body?.data?.refreshToken;

  // Password reset flow (use a dedicated user so we don't break seed accounts)
  const resetEmail = `phase2-reset-${Date.now()}@example.invalid`;
  const resetReg = await req('POST', '/auth/register', {
    body: { email: resetEmail, password, fullName: 'Reset User', role: 'investor' },
  });
  await req('POST', '/auth/otp/verify', {
    body: {
      challengeId: resetReg.body?.data?.otp?.challengeId,
      code: resetReg.body?.data?.otp?.previewCode,
    },
  });
  const forgot = await req('POST', '/auth/password/forgot', { body: { email: resetEmail } });
  evidence.steps.push(step('password_forgot', forgot));
  const resetOtp = await req('POST', '/auth/otp/verify', {
    body: { challengeId: forgot.body?.data?.challengeId, code: forgot.body?.data?.previewCode },
  });
  evidence.steps.push(step('password_reset_otp_verify', resetOtp));
  const reset = await req('POST', '/auth/password/reset', {
    body: { resetToken: resetOtp.body?.data?.resetToken, newPassword: password },
  });
  evidence.steps.push(step('password_reset', reset));

  // Logout
  const logout = await req('POST', '/auth/logout', {
    token: accessToken,
    body: { refreshToken },
  });
  evidence.steps.push(step('logout', logout));

  // Session revocation (admin on newly registered user)
  const revokeTargetLogin = await req('POST', '/auth/login', { body: { email, password } });
  const revoke = await req('POST', '/auth/sessions/revoke', {
    token: adminAccessToken,
    body: { userId },
  });
  evidence.steps.push(step('session_revocation', revoke));
  const afterRevokeRefresh = await req('POST', '/auth/token/refresh', {
    body: { refreshToken: revokeTargetLogin.body?.data?.refreshToken },
  });
  evidence.steps.push(step('refresh_after_session_revocation', afterRevokeRefresh));

  // Published projects
  const projects = await req('GET', '/projects');
  evidence.steps.push(step('published_project_listing', projects));
  const projectId = projects.body?.data?.[0]?.id;
  const termsVersion = projects.body?.data?.[0]?.publishedTermsVersion;

  // Investment application
  const application = await req('POST', '/applications', {
    token: investorAccessToken,
    body: { projectId, units: 1, acceptedTermsVersion: termsVersion },
  });
  evidence.steps.push(step('investment_application', application));
  const applicationId = application.body?.data?.id;
  const totalPayable = application.body?.data?.totalPayablePoisha;

  // Application approval (compliance)
  const approved = await req('POST', `/admin/applications/${applicationId}/approve`, {
    token: complianceAccessToken,
    body: {},
  });
  evidence.steps.push(step('application_approval', approved));

  // Payment submission
  const idempotencyKey = `phase2-idem-${Date.now()}-abcdefgh`;
  const payment = await req('POST', '/payments', {
    token: investorAccessToken,
    idempotencyKey,
    body: {
      applicationId,
      method: 'bank_transfer',
      paidOn: '2026-09-07',
      evidenceStorageKey: 'evidence/phase2-bank.pdf',
      reference: `P2-${Date.now()}`,
      amountPoisha: totalPayable,
      idempotencyKey,
    },
  });
  evidence.steps.push(step('payment_submission', payment));
  const paymentId = payment.body?.data?.id;

  // Payment verification
  const verified = await req('POST', `/admin/payments/${paymentId}/verify`, {
    token: financeAccessToken,
    body: { reviewNote: 'Phase2 evidence matched bank statement' },
  });
  evidence.steps.push(step('payment_verification', verified));
  const allocationId = verified.body?.data?.allocation?.id;

  // Duplicate verification
  const dup = await req('POST', `/admin/payments/${paymentId}/verify`, {
    token: financeAccessToken,
    body: { reviewNote: 'Phase2 duplicate verify' },
  });
  evidence.steps.push(step('duplicate_verification_same_allocation', dup, {
    sameAllocationId:
      dup.body?.data?.allocation?.id === allocationId && dup.body?.data?.alreadyVerified === true,
  }));

  // Forbidden cross-investor access
  const cross = await req('GET', `/investments/${allocationId}`, {
    token: otherInvestorAccessToken,
  });
  evidence.steps.push(step('forbidden_cross_investor_access', cross));

  // Unauthorized role attempts (investor publish)
  const forbiddenPublish = await req('POST', `/admin/projects/${projectId}/publish`, {
    token: investorAccessToken,
    body: { versionNote: 'should-fail' },
  });
  evidence.steps.push(step('unauthorized_investor_publish', forbiddenPublish));

  // Invalid amount rejection
  const app2 = await req('POST', '/applications', {
    token: investorAccessToken,
    body: { projectId, units: 1, acceptedTermsVersion: termsVersion },
  });
  const app2Id = app2.body?.data?.id;
  await req('POST', `/admin/applications/${app2Id}/approve`, {
    token: complianceAccessToken,
    body: {},
  });
  const badAmount = await req('POST', '/payments', {
    token: investorAccessToken,
    idempotencyKey: `phase2-badamt-${Date.now()}-abcdefgh`,
    body: {
      applicationId: app2Id,
      method: 'bank_transfer',
      paidOn: '2026-09-07',
      evidenceStorageKey: 'evidence/phase2-bank.pdf',
      reference: `BAD-${Date.now()}`,
      amountPoisha: 1,
      idempotencyKey: `phase2-badamt-${Date.now()}-abcdefgh`,
    },
  });
  evidence.steps.push(step('invalid_amount_rejection', badAmount));

  // Project oversubscription rejection (sequential apply exceeding availability on tiny project via owner path)
  // Use service-level concurrent script for true race; also demonstrate sequential apply oversubscribe on seed project
  // by requesting absurd units:
  const overApply = await req('POST', '/applications', {
    token: investorAccessToken,
    body: { projectId, units: 999999, acceptedTermsVersion: termsVersion },
  });
  evidence.steps.push(step('project_oversubscription_rejection_apply', overApply));

  // Concurrent oversubscription (real Promise.all script)
  const concurrentOut = path.join(path.dirname(OUT), 'concurrent-oversubscription-raw.json');
  const concurrentRun = await runNode(
    ['--env-file=.env', 'scripts/concurrent_oversubscription_evidence.js'],
    { EVIDENCE_OUT: concurrentOut },
  );
  let concurrentJson = null;
  try {
    concurrentJson = JSON.parse(await readFile(concurrentOut, 'utf8'));
  } catch {
    try {
      concurrentJson = JSON.parse(concurrentRun.stdout);
    } catch {
      concurrentJson = {
        ok: false,
        parseError: true,
        exitCode: concurrentRun.code,
        stdoutTail: concurrentRun.stdout.slice(-2000),
        stderrTail: concurrentRun.stderr.slice(-2000),
      };
    }
  }
  evidence.steps.push({
    name: 'concurrent_oversubscription_promise_all',
    exitCode: concurrentRun.code,
    result: redact(concurrentJson),
  });

  evidence.sections = {
    auth: evidence.steps.filter((s) =>
      [
        'registration',
        'otp_verification',
        'login_seed_investor',
        'token_refresh_rotation',
        'old_refresh_token_reuse_rejection',
        'password_forgot',
        'password_reset_otp_verify',
        'password_reset',
        'logout',
        'session_revocation',
      ].includes(s.name),
    ),
    financialHappyPath: evidence.steps.filter((s) =>
      [
        'published_project_listing',
        'investment_application',
        'application_approval',
        'payment_submission',
        'payment_verification',
        'duplicate_verification_same_allocation',
      ].includes(s.name),
    ),
    authorizationErrors: evidence.steps.filter((s) =>
      ['forbidden_cross_investor_access', 'unauthorized_investor_publish'].includes(s.name),
    ),
    validationErrors: evidence.steps.filter((s) =>
      ['invalid_amount_rejection', 'project_oversubscription_rejection_apply'].includes(s.name),
    ),
    concurrentOversubscription: evidence.steps.filter((s) =>
      s.name === 'concurrent_oversubscription_promise_all',
    ),
  };

  evidence.summary = {
    concurrentOk: Boolean(concurrentJson?.ok),
    duplicateVerifySameAllocation: Boolean(
      evidence.steps.find((s) => s.name === 'duplicate_verification_same_allocation')?.sameAllocationId,
    ),
    concurrentExitCode: concurrentRun.code,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(evidence, null, 2));
  console.log(`Wrote ${OUT}`);
  console.log(JSON.stringify(evidence.summary, null, 2));
  if (concurrentRun.code !== 0) process.exitCode = 1;
}

await main();
