import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcInvestmentBreakdown,
  validateDisbursementStages,
  DEFAULT_CARD_ORDER,
} from '../src/dashboard_admin_workflow.js';
import { DomainError } from '../src/domain.js';

test('calcInvestmentBreakdown uses integer poisha formulas', () => {
  const r = calcInvestmentBreakdown({
    units: 10,
    unitInvestmentPoisha: 100000, // ৳1,000
    administrationFeeBps: 200, // 2%
  });
  assert.equal(r.baseInvestmentPoisha, 1_000_000);
  assert.equal(r.administrationFeePoisha, 20_000);
  assert.equal(r.totalPayablePoisha, 1_020_000);
});

test('disbursement stages require >=3 and exactly 10000 bps', () => {
  assert.throws(
    () => validateDisbursementStages([{ title: 'A', percentBps: 10000 }]),
    (e) => e instanceof DomainError && e.code === 'STAGES_REQUIRED',
  );
  assert.throws(
    () =>
      validateDisbursementStages([
        { title: 'A', percentBps: 4000 },
        { title: 'B', percentBps: 4000 },
        { title: 'C', percentBps: 1000 },
      ]),
    (e) => e instanceof DomainError && e.code === 'STAGES_PERCENT_INVALID',
  );
  const ok = validateDisbursementStages([
    { title: 'A', percentBps: 2500 },
    { title: 'B', percentBps: 2500 },
    { title: 'C', percentBps: 2500 },
    { title: 'D', percentBps: 2500 },
  ]);
  assert.equal(ok.length, 4);
});

test('disbursement amounts must equal funding target when amounts used', () => {
  assert.throws(
    () =>
      validateDisbursementStages(
        [
          { title: 'A', amountPoisha: 100 },
          { title: 'B', amountPoisha: 100 },
          { title: 'C', amountPoisha: 100 },
        ],
        { fundingTargetPoisha: 500 },
      ),
    (e) => e instanceof DomainError && e.code === 'STAGES_AMOUNT_INVALID',
  );
  const ok = validateDisbursementStages(
    [
      { title: 'A', amountPoisha: 200 },
      { title: 'B', amountPoisha: 200 },
      { title: 'C', amountPoisha: 100 },
    ],
    { fundingTargetPoisha: 500 },
  );
  assert.equal(ok.length, 3);
});

test('default card orders cover all three shells', () => {
  assert.ok(DEFAULT_CARD_ORDER.admin.includes('total_funds_confirmed'));
  assert.ok(DEFAULT_CARD_ORDER.investor.includes('confirmed_investment'));
  assert.ok(DEFAULT_CARD_ORDER.owner.includes('total_funds_raised'));
  assert.ok(DEFAULT_CARD_ORDER.owner.includes('my_investments'));
});

test('funding target equals units × price (clarifying calc)', () => {
  const units = 50;
  const price = 850000;
  const target = units * price;
  assert.equal(target, 42_500_000);
  assert.equal(Number.isSafeInteger(target), true);
});
