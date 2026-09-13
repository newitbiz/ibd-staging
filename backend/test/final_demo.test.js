import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDemoInvestment, computeProfileCompletionParts } from '../src/final_demo_service.js';
import {
  assertAllowedUpload,
  sanitizeFilename,
  FICTIONAL_BANNER,
  STAGING_PHONE_OTP_LABEL,
  buildFictionalPlaceholderPdf,
} from '../src/document_storage.js';
import { INVESTOR_BROWSE_STATUSES, PROJECT_WORKFLOW_STATUS } from '../src/project_workflow.js';

test('demo calc matches owner example (poisha/bps integers)', () => {
  const c = calculateDemoInvestment();
  assert.equal(c.units, 3);
  assert.equal(c.unitPricePoisha, 850000);
  assert.equal(c.investmentPoisha, 2550000);
  assert.equal(c.administrationFeePoisha, 382500);
  assert.equal(c.totalPayablePoisha, 2932500);
  assert.equal(c.projectedAnnualProfitPoisha, 510000);
  assert.equal(c.projectionsWithdrawable, false);
  assert.equal(c.demoExample.bdt.principal, 25500);
  assert.equal(c.demoExample.bdt.fee, 3825);
  assert.equal(c.demoExample.bdt.total, 29325);
  assert.equal(c.demoExample.bdt.projectedAnnual, 5100);
  assert.ok(Math.abs(c.dailyProjectedApproxBdt - 13.97) < 0.02);
});

test('document upload rejects executables and allows pdf', () => {
  assert.throws(() => assertAllowedUpload({ filename: 'x.exe', mimeType: 'application/pdf', byteSize: 100 }));
  const ok = assertAllowedUpload({ filename: 'nid.pdf', mimeType: 'application/pdf', byteSize: 1000 });
  assert.equal(ok.sanitizedFilename, 'nid.pdf');
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
});

test('fictional banner and staging OTP label constants', () => {
  assert.equal(FICTIONAL_BANNER, 'FICTIONAL DEMO — NOT A REAL DOCUMENT');
  assert.equal(STAGING_PHONE_OTP_LABEL, 'Staging verification — mobile OTP not enabled');
  const pdf = buildFictionalPlaceholderPdf({ title: 'Test' });
  assert.ok(pdf.includes(Buffer.from('FICTIONAL DEMO')));
});

test('paused projects excluded from investor browse set', () => {
  assert.equal(INVESTOR_BROWSE_STATUSES.has(PROJECT_WORKFLOW_STATUS.PAUSED), false);
  assert.equal(INVESTOR_BROWSE_STATUSES.has(PROJECT_WORKFLOW_STATUS.PUBLISHED), true);
});

test('profile completion computes missing items', () => {
  const parts = computeProfileCompletionParts({
    user: { email: 'a@b.c', email_verified_at: null, display_name: null, mobile: null },
    identity: null,
    business: null,
    businessItems: [],
    roles: ['investor'],
  });
  assert.ok(parts.overallPct < 50);
  assert.ok(parts.missingItems.length > 0);
});
