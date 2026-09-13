import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('PostgreSQL schema contains all MVP financial records', async () => {
  const schema = await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8');
  for (const table of [
    'users', 'businesses', 'projects', 'project_terms',
    'investment_applications', 'agreement_acceptances', 'payments',
    'cash_receipts', 'allocations', 'performance_reports',
    'profit_confirmations', 'payouts', 'exit_requests', 'referrals',
    'referral_rewards', 'audit_logs',
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE ${table} \\(`));
  }
});

test('allocation implementation locks financial rows', async () => {
  const service = await readFile(new URL('../src/postgres_service.js', import.meta.url), 'utf8');
  assert.match(service, /payments WHERE id=\$1 FOR UPDATE/);
  assert.match(service, /investment_applications WHERE id=\$1 FOR UPDATE/);
  assert.match(service, /projects WHERE id=\$1 FOR UPDATE/);
  assert.match(service, /reserved_units=reserved_units-\$2/);
  assert.match(service, /active_units=active_units\+\$2/);
});

test('audit history is append-only at database level', async () => {
  const schema = await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /audit_logs_no_update/);
  assert.match(schema, /BEFORE UPDATE OR DELETE ON audit_logs/);
});

test('Phase 8 performance reports migration and service methods exist', async () => {
  const migration = await readFile(new URL('../database/migrations/013_performance_reports_workflow.sql', import.meta.url), 'utf8');
  assert.match(migration, /performance_reports/);
  assert.match(migration, /distributions_generated_at/);
  const service = await readFile(new URL('../src/postgres_service.js', import.meta.url), 'utf8');
  assert.match(service, /submitPerformanceReport/);
  assert.match(service, /getInvestorAvailablePayable/);
  assert.match(service, /listAuditLogs/);
  assert.match(service, /generateDistributionsFromPerformanceReport/);
  const openapi = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');
  assert.match(openapi, /version: 0\.11\.0/);
  assert.match(openapi, /\/investor\/available-payable/);
  assert.match(openapi, /\/admin\/performance-reports/);
});

test('legal agreements migration and service exist', async () => {
  const migration = await readFile(new URL('../database/migrations/025_legal_agreements.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS legal_documents/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS legal_document_versions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS legal_acceptances/);
  assert.match(migration, /instrument_type/);
  assert.match(migration, /pending_legal_acceptance/);
  const service = await readFile(new URL('../src/legal_agreements.js', import.meta.url), 'utf8');
  assert.match(service, /attachLegalAgreementMethods/);
  assert.match(service, /acceptProjectInvestmentAgreement/);
  assert.match(service, /LEGAL_PRODUCTION_BLOCKED/);
  const pg = await readFile(new URL('../src/postgres_service.js', import.meta.url), 'utf8');
  assert.match(pg, /attachLegalAgreementMethods/);
});
