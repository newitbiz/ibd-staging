import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLegalProductionAllowed,
  requiredDocsForRole,
  contentHash,
  fillTemplate,
  DRAFT_BANNER,
  TEMPORARY_DRAFTS,
  COMPANY_PLACEHOLDERS,
} from '../src/legal_agreements.js';
import { DomainError } from '../src/domain.js';

test('temporary drafts carry legal-review banner and placeholders', () => {
  for (const type of Object.keys(TEMPORARY_DRAFTS)) {
    const d = TEMPORARY_DRAFTS[type];
    assert.match(d.en, /Temporary draft—legal review pending/);
    assert.match(d.en, /LEGAL PLACEHOLDER/);
    assert.match(d.bn, /pending lawyer review|আইনজীবী/i);
    assert.equal(d.en.includes('lawyer-approved') && d.en.includes('not'), true);
  }
  assert.equal(DRAFT_BANNER, 'Temporary draft—legal review pending');
  assert.match(COMPANY_PLACEHOLDERS.legalName, /LEGAL PLACEHOLDER/);
});

test('required docs by role', () => {
  assert.deepEqual(requiredDocsForRole('investor'), ['investor_agreement', 'privacy_notice']);
  assert.deepEqual(requiredDocsForRole('project_owner'), ['project_owner_agreement', 'privacy_notice']);
});

test('production blocked when review pending', () => {
  assert.throws(
    () =>
      assertLegalProductionAllowed({
        env: { NODE_ENV: 'production', LEGAL_PRODUCTION_BLOCK: 'true' },
        allReviewStatuses: ['pending'],
      }),
    (e) => e instanceof DomainError && e.code === 'LEGAL_PRODUCTION_BLOCKED',
  );
});

test('staging allowed even with pending review', () => {
  const r = assertLegalProductionAllowed({
    env: { NODE_ENV: 'staging', LEGAL_PRODUCTION_BLOCK: 'true' },
    allReviewStatuses: ['pending'],
  });
  assert.equal(r.allowed, true);
});

test('contentHash stable', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
});

test('fillTemplate replaces project fields', () => {
  const out = fillTemplate('Units {{units}} price {{unit_price_poisha}}', {
    units: 3,
    unit_price_poisha: 850000,
  });
  assert.equal(out, 'Units 3 price 850000');
});

test('investor agreement includes risk acknowledgment section', () => {
  assert.match(TEMPORARY_DRAFTS.investor_agreement.en, /Risk Acknowledgment/i);
  assert.match(TEMPORARY_DRAFTS.investor_agreement.en, /Capital may be partially or entirely lost/i);
  assert.match(TEMPORARY_DRAFTS.investor_agreement.en, /not guaranteed/i);
  assert.match(TEMPORARY_DRAFTS.investor_agreement.en, /not a guarantor/i);
});

test('project investment template includes live field placeholders', () => {
  const en = TEMPORARY_DRAFTS.project_investment_agreement_template.en;
  for (const key of [
    'issuer_owner_legal_name',
    'instrument_type',
    'units',
    'unit_price_poisha',
    'principal_poisha',
    'fee_poisha',
    'total_payable_poisha',
    'duration_days',
    'maturity_rule',
    'projected_return',
    'loss_risks',
    'exit_refund_rule',
    'payment_recipient',
  ]) {
    assert.match(en, new RegExp(`\\{\\{${key}\\}\\}`));
  }
});
