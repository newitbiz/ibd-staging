import { randomUUID } from 'node:crypto';

export const PROJECT_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED_FOR_REVIEW: 'submitted_for_review',
  CHANGES_REQUESTED: 'changes_requested',
  RESUBMITTED: 'resubmitted',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  PAUSED: 'paused',
  FUNDING_CLOSED: 'funding_closed',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  ARCHIVED: 'archived',
  // Legacy aliases kept for in-memory demo service
  SUBMITTED: 'submitted_for_review',
  UNDER_REVIEW: 'submitted_for_review',
  APPROVED_UNPUBLISHED: 'approved',
  FUNDED: 'funding_closed',
  SUSPENDED: 'archived',
  CLOSED: 'cancelled',
});

export const APPLICATION_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED_PAYMENT_PENDING: 'approved_payment_pending',
  PAYMENT_VERIFICATION_PENDING: 'payment_verification_pending',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  PAYMENT_REJECTED: 'payment_rejected',
  CANCELLED: 'cancelled',
});

export const PAYMENT_STATUS = Object.freeze({
  VERIFICATION_PENDING: 'verification_pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  REVERSED: 'reversed'
});

export const PAYMENT_METHODS = Object.freeze(['cash', 'bank_transfer', 'bkash', 'sslcommerz']);

export class DomainError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function assertInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new DomainError('INVALID_INTEGER', `${name} must be an integer of at least ${minimum}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function calculateAmounts({ unitInvestmentPoisha, administrationFeeBps, units }) {
  assertInteger(unitInvestmentPoisha, 'unitInvestmentPoisha', 1);
  assertInteger(administrationFeeBps, 'administrationFeeBps', 0);
  assertInteger(units, 'units', 1);
  const investmentPoisha = unitInvestmentPoisha * units;
  const administrationFeePoisha = Math.round((investmentPoisha * administrationFeeBps) / 10_000);
  return {
    investmentPoisha,
    administrationFeePoisha,
    totalPayablePoisha: investmentPoisha + administrationFeePoisha
  };
}

export function calculateEstimatedProfit({ investmentPoisha, targetProfitBps, elapsedDays, projectDays }) {
  assertInteger(investmentPoisha, 'investmentPoisha', 0);
  assertInteger(targetProfitBps, 'targetProfitBps', 0);
  assertInteger(elapsedDays, 'elapsedDays', 0);
  assertInteger(projectDays, 'projectDays', 1);
  const eligibleDays = Math.min(elapsedDays, projectDays);
  return Math.round((investmentPoisha * targetProfitBps * eligibleDays) / (10_000 * projectDays));
}

export class GrowBangladeshService {
  constructor() {
    this.projects = new Map();
    this.applications = new Map();
    this.payments = new Map();
    this.allocations = new Map();
    this.auditEvents = [];
  }

  audit(actorId, action, subjectType, subjectId, detail = {}) {
    this.auditEvents.push({ id: randomUUID(), actorId, action, subjectType, subjectId, detail, occurredAt: nowIso() });
  }

  createProject(input, actorId) {
    assertInteger(input.totalUnits, 'totalUnits', 1);
    assertInteger(input.unitInvestmentPoisha, 'unitInvestmentPoisha', 1);
    assertInteger(input.administrationFeeBps, 'administrationFeeBps', 0);
    assertInteger(input.targetProfitBps, 'targetProfitBps', 0);
    assertInteger(input.durationDays, 'durationDays', 1);
    const project = {
      id: randomUUID(),
      ownerId: input.ownerId,
      title: input.title,
      category: input.category,
      status: PROJECT_STATUS.DRAFT,
      totalUnits: input.totalUnits,
      activeUnits: 0,
      reservedUnits: 0,
      unitInvestmentPoisha: input.unitInvestmentPoisha,
      administrationFeeBps: input.administrationFeeBps,
      targetProfitBps: input.targetProfitBps,
      durationDays: input.durationDays,
      publishedTermsVersion: null,
      createdAt: nowIso()
    };
    this.projects.set(project.id, project);
    this.audit(actorId, 'project.created', 'project', project.id);
    return project;
  }

  publishProject(projectId, actorId) {
    const project = this.requireProject(projectId);
    if (![PROJECT_STATUS.DRAFT, PROJECT_STATUS.APPROVED].includes(project.status)) {
      throw new DomainError('PROJECT_NOT_PUBLISHABLE', 'Project is not in a publishable state');
    }
    project.status = PROJECT_STATUS.PUBLISHED;
    project.publishedTermsVersion = 1;
    project.publishedAt = nowIso();
    this.audit(actorId, 'project.published', 'project', project.id, { termsVersion: 1 });
    return project;
  }

  listPublishedProjects() {
    return [...this.projects.values()].filter(project => project.status === PROJECT_STATUS.PUBLISHED);
  }

  applyForUnits({ projectId, investorId, units }, actorId = investorId) {
    const project = this.requireProject(projectId);
    if (project.status !== PROJECT_STATUS.PUBLISHED) {
      throw new DomainError('PROJECT_NOT_OPEN', 'Project is not accepting applications');
    }
    assertInteger(units, 'units', 1);
    const available = project.totalUnits - project.activeUnits - project.reservedUnits;
    if (units > available) {
      throw new DomainError('INSUFFICIENT_UNITS', `Only ${available} units are available`);
    }
    const amounts = calculateAmounts({
      unitInvestmentPoisha: project.unitInvestmentPoisha,
      administrationFeeBps: project.administrationFeeBps,
      units
    });
    const application = {
      id: randomUUID(),
      projectId,
      investorId,
      units,
      ...amounts,
      termsVersion: project.publishedTermsVersion,
      status: APPLICATION_STATUS.SUBMITTED,
      createdAt: nowIso()
    };
    this.applications.set(application.id, application);
    this.audit(actorId, 'application.submitted', 'application', application.id, { projectId, units });
    return application;
  }

  approveApplication(applicationId, actorId) {
    const application = this.requireApplication(applicationId);
    if (application.status !== APPLICATION_STATUS.SUBMITTED) {
      throw new DomainError('APPLICATION_NOT_APPROVABLE', 'Application is not awaiting approval');
    }
    const project = this.requireProject(application.projectId);
    const available = project.totalUnits - project.activeUnits - project.reservedUnits;
    if (application.units > available) {
      throw new DomainError('INSUFFICIENT_UNITS', `Only ${available} units are available`);
    }
    project.reservedUnits += application.units;
    application.status = APPLICATION_STATUS.APPROVED_PAYMENT_PENDING;
    application.approvedAt = nowIso();
    this.audit(actorId, 'application.approved', 'application', application.id, { reservedUnits: application.units });
    return application;
  }

  submitPayment({ applicationId, method, reference, amountPoisha, evidenceId }, actorId) {
    const application = this.requireApplication(applicationId);
    if (application.status !== APPLICATION_STATUS.APPROVED_PAYMENT_PENDING) {
      throw new DomainError('APPLICATION_NOT_PAYABLE', 'Application is not ready for payment');
    }
    if (!PAYMENT_METHODS.includes(method)) {
      throw new DomainError('INVALID_PAYMENT_METHOD', 'Unsupported payment method');
    }
    assertInteger(amountPoisha, 'amountPoisha', 1);
    if (amountPoisha !== application.totalPayablePoisha) {
      throw new DomainError('PAYMENT_AMOUNT_MISMATCH', 'Payment must match the approved total payable');
    }
    if ([...this.payments.values()].some(payment => payment.reference === reference && payment.status !== PAYMENT_STATUS.REVERSED)) {
      throw new DomainError('DUPLICATE_PAYMENT_REFERENCE', 'Payment reference has already been used');
    }
    const payment = {
      id: randomUUID(),
      applicationId,
      method,
      reference,
      evidenceId,
      amountPoisha,
      status: PAYMENT_STATUS.VERIFICATION_PENDING,
      submittedAt: nowIso()
    };
    this.payments.set(payment.id, payment);
    application.status = APPLICATION_STATUS.PAYMENT_VERIFICATION_PENDING;
    this.audit(actorId, 'payment.submitted', 'payment', payment.id, { applicationId, method, amountPoisha });
    return payment;
  }

  verifyPayment(paymentId, actorId, reviewNote) {
    const payment = this.requirePayment(paymentId);
    if (payment.status !== PAYMENT_STATUS.VERIFICATION_PENDING) {
      throw new DomainError('PAYMENT_NOT_VERIFIABLE', 'Payment is not awaiting verification');
    }
    const application = this.requireApplication(payment.applicationId);
    const project = this.requireProject(application.projectId);
    if (application.status !== APPLICATION_STATUS.PAYMENT_VERIFICATION_PENDING) {
      throw new DomainError('APPLICATION_STATE_CONFLICT', 'Application is not awaiting payment verification');
    }
    if (project.reservedUnits < application.units) {
      throw new DomainError('RESERVATION_CONFLICT', 'Reserved unit inventory is inconsistent', 409);
    }
    payment.status = PAYMENT_STATUS.VERIFIED;
    payment.verifiedAt = nowIso();
    payment.verifiedBy = actorId;
    payment.reviewNote = reviewNote;
    project.reservedUnits -= application.units;
    project.activeUnits += application.units;
    application.status = APPLICATION_STATUS.ACTIVE;
    application.activatedAt = nowIso();
    const allocation = {
      id: randomUUID(),
      projectId: project.id,
      applicationId: application.id,
      paymentId: payment.id,
      investorId: application.investorId,
      units: application.units,
      investmentPoisha: application.investmentPoisha,
      targetProfitBps: project.targetProfitBps,
      durationDays: project.durationDays,
      status: 'active',
      activatedAt: application.activatedAt,
      confirmedProfitPoisha: 0
    };
    this.allocations.set(allocation.id, allocation);
    this.audit(actorId, 'payment.verified', 'payment', payment.id, { allocationId: allocation.id });
    this.audit(actorId, 'allocation.activated', 'allocation', allocation.id, { units: allocation.units });
    return { payment, allocation, project };
  }

  getInvestment(allocationId, asOf = new Date()) {
    const allocation = this.allocations.get(allocationId);
    if (!allocation) throw new DomainError('ALLOCATION_NOT_FOUND', 'Investment allocation was not found', 404);
    const elapsedDays = Math.max(0, Math.floor((asOf.getTime() - new Date(allocation.activatedAt).getTime()) / 86_400_000));
    return {
      ...allocation,
      estimatedProfitPoisha: calculateEstimatedProfit({
        investmentPoisha: allocation.investmentPoisha,
        targetProfitBps: allocation.targetProfitBps,
        elapsedDays,
        projectDays: allocation.durationDays
      }),
      estimateLabel: 'Estimated Profit',
      estimatedAsOf: asOf.toISOString()
    };
  }

  requireProject(id) {
    const project = this.projects.get(id);
    if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
    return project;
  }

  requireApplication(id) {
    const application = this.applications.get(id);
    if (!application) throw new DomainError('APPLICATION_NOT_FOUND', 'Application was not found', 404);
    return application;
  }

  requirePayment(id) {
    const payment = this.payments.get(id);
    if (!payment) throw new DomainError('PAYMENT_NOT_FOUND', 'Payment was not found', 404);
    return payment;
  }
}

export function seedService() {
  const service = new GrowBangladeshService();
  const project = service.createProject({
    ownerId: 'owner-demo',
    title: 'Garment Export Project 01',
    category: 'manufacturing',
    totalUnits: 1000,
    unitInvestmentPoisha: 850_000,
    administrationFeeBps: 1500,
    targetProfitBps: 2000,
    durationDays: 365
  }, 'admin-demo');
  service.publishProject(project.id, 'admin-demo');
  return service;
}
