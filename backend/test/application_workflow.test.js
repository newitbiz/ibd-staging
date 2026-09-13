import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertApplicationTransition,
  previewInvestmentCalculation,
  APPLICATION_WORKFLOW_STATUS as S,
} from '../src/application_workflow.js';
import { DomainError } from '../src/domain.js';

test('previewInvestmentCalculation: 3×8500 BDT at 15% fee', () => {
  // 8500 BDT = 850000 poisha; 15% = 1500 bps
  const preview = previewInvestmentCalculation({
    unitInvestmentPoisha: 850_000,
    administrationFeeBps: 1500,
    units: 3,
  });
  assert.equal(preview.investmentPoisha, 2_550_000); // 25500 BDT
  assert.equal(preview.administrationFeePoisha, 382_500); // 3825 BDT
  assert.equal(preview.totalPayablePoisha, 2_932_500); // 29325 BDT
  assert.match(preview.projectedReturnDisclaimer, /not guaranteed/i);
  assert.equal(preview.withdrawable, false);
});

test('application status transitions enforce review machine', () => {
  assertApplicationTransition(S.SUBMITTED, S.APPROVED_PAYMENT_PENDING);
  assertApplicationTransition(S.SUBMITTED, S.CHANGES_REQUESTED);
  assertApplicationTransition(S.CHANGES_REQUESTED, S.SUBMITTED);
  assert.throws(
    () => assertApplicationTransition(S.REJECTED, S.SUBMITTED),
    (err) => err instanceof DomainError && err.code === 'INVALID_STATUS_TRANSITION',
  );
  assert.throws(
    () => assertApplicationTransition(S.APPROVED_PAYMENT_PENDING, S.SUBMITTED),
    (err) => err instanceof DomainError && err.code === 'INVALID_STATUS_TRANSITION',
  );
});
