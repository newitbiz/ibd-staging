import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERFORMANCE_REPORT_STATUS,
  AVAILABLE_PAYABLE_DISCLAIMER,
  DISTRIBUTION_RULE,
  AUDIT_ACTION_PREFIXES,
  requireNonNegativePoisha,
  computeActualProfitPoisha,
  requireRejectionReason,
  optionalSupportingDocumentKey,
  proRataByInvestmentPoisha,
  parseReportPeriod,
  mapPerformanceReport,
  normalizeAuditPrefixes,
} from '../src/performance_reports.js';
import { DomainError } from '../src/domain.js';

test('computeActualProfitPoisha equals revenue minus expense', () => {
  assert.equal(computeActualProfitPoisha(1_000_000, 250_000), 750_000);
  assert.equal(computeActualProfitPoisha(100, 100), 0);
  assert.equal(computeActualProfitPoisha(100, 150), -50);
});

test('requireNonNegativePoisha rejects negatives and non-integers', () => {
  assert.equal(requireNonNegativePoisha(0, 'revenuePoisha'), 0);
  assert.throws(() => requireNonNegativePoisha(-1, 'revenuePoisha'), (e) => e.code === 'INVALID_AMOUNT');
  assert.throws(() => requireNonNegativePoisha(1.5, 'expensePoisha'), (e) => e.code === 'INVALID_AMOUNT');
});

test('parseReportPeriod validates dates and order', () => {
  assert.deepEqual(parseReportPeriod({ periodStart: '2026-01-01', periodEnd: '2026-01-31' }), {
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
  });
  assert.throws(
    () => parseReportPeriod({ periodStart: '2026-02-01', periodEnd: '2026-01-01' }),
    (e) => e.code === 'INVALID_PERIOD',
  );
});

test('requireRejectionReason enforces min length', () => {
  assert.equal(requireRejectionReason('incomplete evidence'), 'incomplete evidence');
  assert.throws(() => requireRejectionReason('no'), (e) => e.code === 'REASON_REQUIRED');
});

test('optionalSupportingDocumentKey allows stub strings', () => {
  assert.equal(optionalSupportingDocumentKey('stub/docs/report-q1.pdf'), 'stub/docs/report-q1.pdf');
  assert.equal(optionalSupportingDocumentKey(''), null);
});

test('proRataByInvestmentPoisha preserves exact total with remainder on last', () => {
  const shares = proRataByInvestmentPoisha(
    [
      { id: 'a', investment_poisha: 100_000 },
      { id: 'b', investment_poisha: 300_000 },
      { id: 'c', investment_poisha: 600_000 },
    ],
    1_000_000,
  );
  assert.equal(shares.reduce((s, x) => s + x.confirmedProfitPoisha, 0), 1_000_000);
  assert.equal(shares.find((s) => s.allocationId === 'a').confirmedProfitPoisha, 100_000);
  assert.equal(shares.find((s) => s.allocationId === 'b').confirmedProfitPoisha, 300_000);
  assert.equal(shares.find((s) => s.allocationId === 'c').confirmedProfitPoisha, 600_000);
});

test('proRataByInvestmentPoisha handles rounding remainder', () => {
  const shares = proRataByInvestmentPoisha(
    [
      { allocationId: 'x', investmentPoisha: 1 },
      { allocationId: 'y', investmentPoisha: 1 },
      { allocationId: 'z', investmentPoisha: 1 },
    ],
    100,
  );
  assert.equal(shares.reduce((s, x) => s + x.confirmedProfitPoisha, 0), 100);
});

test('proRata rejects negative profit and empty allocations', () => {
  assert.throws(
    () => proRataByInvestmentPoisha([{ id: 'a', investment_poisha: 10 }], -5),
    (e) => e.code === 'NEGATIVE_PROFIT',
  );
  assert.throws(() => proRataByInvestmentPoisha([], 10), (e) => e.code === 'NO_ACTIVE_ALLOCATIONS');
});

test('disclaimer and labels never say wallet', () => {
  assert.match(AVAILABLE_PAYABLE_DISCLAIMER, /not a wallet/i);
  assert.match(AVAILABLE_PAYABLE_DISCLAIMER, /payoutEnabled:false/i);
  assert.match(DISTRIBUTION_RULE, /Pro-rata by investment_poisha/i);
  assert.doesNotMatch(AVAILABLE_PAYABLE_DISCLAIMER.toLowerCase().replace('not a wallet', ''), /\bwallet\b/);
  assert.ok(Object.values(PERFORMANCE_REPORT_STATUS).includes('approved'));
});

test('mapPerformanceReport marks display-only', () => {
  const mapped = mapPerformanceReport({
    id: 'r1',
    project_id: 'p1',
    period_start: '2026-01-01',
    period_end: '2026-03-31',
    revenue_poisha: 5000,
    expense_poisha: 2000,
    actual_profit_poisha: 3000,
    status: 'submitted',
    submitted_by: 'u1',
    submitted_at: new Date().toISOString(),
  });
  assert.equal(mapped.payoutEnabled, false);
  assert.equal(mapped.fundsMoved, false);
  assert.equal(mapped.label, 'Performance report');
  assert.equal(mapped.actualProfitPoisha, 3000);
  assert.doesNotMatch(JSON.stringify(mapped).toLowerCase(), /wallet/);
});

test('normalizeAuditPrefixes defaults and validates', () => {
  assert.deepEqual(normalizeAuditPrefixes(null), [...AUDIT_ACTION_PREFIXES]);
  assert.ok(normalizeAuditPrefixes('profit_').includes('profit_'));
  assert.throws(() => normalizeAuditPrefixes('hack_'), (e) => e instanceof DomainError);
});
