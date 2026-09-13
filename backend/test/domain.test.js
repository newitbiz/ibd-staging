import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLICATION_STATUS,
  DomainError,
  GrowBangladeshService,
  PAYMENT_STATUS,
  calculateAmounts,
  calculateEstimatedProfit,
  seedService
} from '../src/domain.js';

test('calculates default one-unit amounts in integer poisha', () => {
  assert.deepEqual(calculateAmounts({ unitInvestmentPoisha: 850_000, administrationFeeBps: 1500, units: 1 }), {
    investmentPoisha: 850_000,
    administrationFeePoisha: 127_500,
    totalPayablePoisha: 977_500
  });
});

test('calculates a 20 percent full-year estimate', () => {
  assert.equal(calculateEstimatedProfit({
    investmentPoisha: 850_000,
    targetProfitBps: 2000,
    elapsedDays: 365,
    projectDays: 365
  }), 170_000);
});

test('supports application, approval, payment verification, and allocation', () => {
  const service = seedService();
  const project = service.listPublishedProjects()[0];
  const application = service.applyForUnits({ projectId: project.id, investorId: 'investor-1', units: 3 });
  service.approveApplication(application.id, 'admin-1');
  assert.equal(application.status, APPLICATION_STATUS.APPROVED_PAYMENT_PENDING);
  assert.equal(project.reservedUnits, 3);

  const payment = service.submitPayment({
    applicationId: application.id,
    method: 'bank_transfer',
    reference: 'TXN-458702',
    amountPoisha: 2_932_500,
    evidenceId: 'evidence-1'
  }, 'investor-1');
  assert.equal(payment.status, PAYMENT_STATUS.VERIFICATION_PENDING);

  const result = service.verifyPayment(payment.id, 'finance-admin', 'Matched with bank statement');
  assert.equal(result.payment.status, PAYMENT_STATUS.VERIFIED);
  assert.equal(result.allocation.units, 3);
  assert.equal(result.allocation.investmentPoisha, 2_550_000);
  assert.equal(project.reservedUnits, 0);
  assert.equal(project.activeUnits, 3);
  assert.equal(application.status, APPLICATION_STATUS.ACTIVE);
});

test('does not allocate units before payment verification', () => {
  const service = seedService();
  const project = service.listPublishedProjects()[0];
  const application = service.applyForUnits({ projectId: project.id, investorId: 'investor-1', units: 2 });
  service.approveApplication(application.id, 'admin-1');
  service.submitPayment({
    applicationId: application.id,
    method: 'cash',
    reference: 'RCPT-00731',
    amountPoisha: 1_955_000,
    evidenceId: 'cash-receipt-1'
  }, 'investor-1');
  assert.equal(service.allocations.size, 0);
  assert.equal(project.activeUnits, 0);
  assert.equal(project.reservedUnits, 2);
});

test('rejects payment amount mismatch', () => {
  const service = seedService();
  const project = service.listPublishedProjects()[0];
  const application = service.applyForUnits({ projectId: project.id, investorId: 'investor-1', units: 1 });
  service.approveApplication(application.id, 'admin-1');
  assert.throws(() => service.submitPayment({
    applicationId: application.id,
    method: 'bkash',
    reference: 'BK7K2M92',
    amountPoisha: 850_000,
    evidenceId: 'bkash-proof-1'
  }, 'investor-1'), error => error instanceof DomainError && error.code === 'PAYMENT_AMOUNT_MISMATCH');
});

test('prevents duplicate payment verification', () => {
  const service = seedService();
  const project = service.listPublishedProjects()[0];
  const application = service.applyForUnits({ projectId: project.id, investorId: 'investor-1', units: 1 });
  service.approveApplication(application.id, 'admin-1');
  const payment = service.submitPayment({
    applicationId: application.id,
    method: 'sslcommerz',
    reference: 'SSL-0001',
    amountPoisha: 977_500,
    evidenceId: 'ssl-event-1'
  }, 'investor-1');
  service.verifyPayment(payment.id, 'finance-admin', 'Gateway settlement matched');
  assert.throws(() => service.verifyPayment(payment.id, 'finance-admin', 'Again'), error => error instanceof DomainError && error.code === 'PAYMENT_NOT_VERIFIABLE');
});

test('prevents applications exceeding unit availability', () => {
  const service = new GrowBangladeshService();
  const project = service.createProject({
    ownerId: 'owner-1', title: 'Small project', category: 'retail', totalUnits: 2,
    unitInvestmentPoisha: 850_000, administrationFeeBps: 1500, targetProfitBps: 1800, durationDays: 365
  }, 'owner-1');
  service.publishProject(project.id, 'admin-1');
  assert.throws(() => service.applyForUnits({ projectId: project.id, investorId: 'investor-1', units: 3 }), error => error instanceof DomainError && error.code === 'INSUFFICIENT_UNITS');
});
