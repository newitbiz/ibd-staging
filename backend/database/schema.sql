BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('pending_verification', 'active', 'suspended', 'closed');
CREATE TYPE project_status AS ENUM ('draft', 'submitted', 'under_review', 'revision_requested', 'approved_unpublished', 'published', 'funding_paused', 'funded', 'active', 'completed', 'defaulted', 'suspended', 'rejected', 'closed');
CREATE TYPE application_status AS ENUM ('submitted', 'under_review', 'approved_payment_pending', 'payment_verification_pending', 'active', 'matured', 'exit_requested', 'exit_processing', 'exited', 'payment_rejected', 'cancelled', 'defaulted');
CREATE TYPE payment_method AS ENUM ('cash', 'bank_transfer', 'bkash', 'sslcommerz');
CREATE TYPE payment_status AS ENUM ('created', 'verification_pending', 'verified', 'rejected', 'reversed', 'refunded', 'partially_refunded');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile text UNIQUE,
  email text UNIQUE,
  password_hash text NOT NULL,
  status user_status NOT NULL DEFAULT 'pending_verification',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mobile IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE investor_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  full_name text NOT NULL,
  date_of_birth date,
  nid_hash text UNIQUE,
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'under_review', 'verified', 'rejected', 'expired')),
  risk_acknowledged_at timestamptz,
  payout_account_last4 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  device_label text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE roles (
  code text PRIMARY KEY CHECK (code IN ('investor', 'project_owner', 'super_admin', 'compliance_reviewer', 'project_reviewer', 'finance_officer', 'support', 'auditor'))
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role_code text NOT NULL REFERENCES roles(code),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_code)
);

INSERT INTO roles(code) VALUES ('investor'), ('project_owner'), ('super_admin'), ('compliance_reviewer'), ('project_reviewer'), ('finance_officer'), ('support'), ('auditor');

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  legal_name text NOT NULL,
  registration_number text,
  trade_license_number text,
  tin text,
  bin text,
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'under_review', 'verified', 'rejected', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'business', 'project')),
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'revision_requested', 'verified', 'rejected', 'expired')),
  assigned_to uuid REFERENCES users(id),
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  title text NOT NULL,
  category text NOT NULL,
  summary text NOT NULL,
  status project_status NOT NULL DEFAULT 'draft',
  total_units integer NOT NULL CHECK (total_units > 0),
  reserved_units integer NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  active_units integer NOT NULL DEFAULT 0 CHECK (active_units >= 0),
  unit_investment_poisha bigint NOT NULL CHECK (unit_investment_poisha > 0),
  administration_fee_bps integer NOT NULL CHECK (administration_fee_bps BETWEEN 0 AND 10000),
  target_profit_bps integer NOT NULL CHECK (target_profit_bps BETWEEN 0 AND 10000),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  minimum_exit_days integer CHECK (minimum_exit_days IS NULL OR minimum_exit_days >= 0),
  published_terms_version integer,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved_units + active_units <= total_units),
  CHECK ((status <> 'published') OR (published_terms_version IS NOT NULL AND published_at IS NOT NULL))
);

CREATE TABLE project_terms (
  project_id uuid NOT NULL REFERENCES projects(id),
  version integer NOT NULL CHECK (version > 0),
  terms_json jsonb NOT NULL,
  content_hash text NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, version)
);

CREATE TABLE project_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  document_type text NOT NULL,
  storage_key text NOT NULL,
  content_hash text NOT NULL,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'verified', 'rejected', 'expired')),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  title text NOT NULL,
  release_percentage_bps integer NOT NULL CHECK (release_percentage_bps BETWEEN 0 AND 10000),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'evidence_submitted', 'approved', 'rejected', 'released')),
  evidence_storage_key text,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  UNIQUE(project_id, sequence_number)
);

CREATE TABLE project_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  author_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'published', 'rejected')),
  approved_by uuid REFERENCES users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE investment_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  investor_id uuid NOT NULL REFERENCES users(id),
  units integer NOT NULL CHECK (units > 0),
  unit_investment_poisha bigint NOT NULL CHECK (unit_investment_poisha > 0),
  investment_poisha bigint NOT NULL CHECK (investment_poisha > 0),
  administration_fee_poisha bigint NOT NULL CHECK (administration_fee_poisha >= 0),
  total_payable_poisha bigint NOT NULL CHECK (total_payable_poisha > 0),
  terms_version integer NOT NULL,
  status application_status NOT NULL DEFAULT 'submitted',
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, terms_version) REFERENCES project_terms(project_id, version),
  CHECK (investment_poisha = unit_investment_poisha * units),
  CHECK (total_payable_poisha = investment_poisha + administration_fee_poisha)
);

CREATE TABLE agreement_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES investment_applications(id),
  investor_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  terms_version integer NOT NULL,
  accepted_from_ip inet,
  accepted_user_agent text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, terms_version) REFERENCES project_terms(project_id, version)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES investment_applications(id),
  method payment_method NOT NULL,
  status payment_status NOT NULL DEFAULT 'verification_pending',
  amount_poisha bigint NOT NULL CHECK (amount_poisha > 0),
  reference text NOT NULL,
  evidence_storage_key text,
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  review_note text,
  idempotency_key text NOT NULL UNIQUE,
  UNIQUE(method, reference)
);

CREATE TABLE cash_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
  receipt_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  branch text NOT NULL,
  received_by uuid NOT NULL REFERENCES users(id),
  investor_acknowledged_at timestamptz,
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  application_id uuid NOT NULL UNIQUE REFERENCES investment_applications(id),
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
  investor_id uuid NOT NULL REFERENCES users(id),
  units integer NOT NULL CHECK (units > 0),
  investment_poisha bigint NOT NULL CHECK (investment_poisha > 0),
  target_profit_bps integer NOT NULL CHECK (target_profit_bps BETWEEN 0 AND 10000),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  activated_at timestamptz NOT NULL,
  maturity_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'matured', 'exit_requested', 'exit_processing', 'exited', 'defaulted', 'reversed')),
  CHECK (maturity_at > activated_at)
);

CREATE TABLE performance_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  revenue_poisha bigint NOT NULL CHECK (revenue_poisha >= 0),
  expense_poisha bigint NOT NULL CHECK (expense_poisha >= 0),
  actual_profit_poisha bigint NOT NULL,
  supporting_document_key text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'approved', 'rejected')),
  submitted_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  CHECK (period_end >= period_start),
  CHECK (actual_profit_poisha = revenue_poisha - expense_poisha),
  UNIQUE(project_id, period_start, period_end)
);

CREATE TABLE profit_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL REFERENCES allocations(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  confirmed_profit_poisha bigint NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  source_report_id uuid REFERENCES performance_reports(id),
  CHECK (period_end >= period_start),
  UNIQUE(allocation_id, period_start, period_end)
);

CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid REFERENCES allocations(id),
  investor_id uuid NOT NULL REFERENCES users(id),
  payout_type text NOT NULL CHECK (payout_type IN ('confirmed_profit', 'capital_return', 'refund', 'early_exit', 'referral_reward')),
  amount_poisha bigint NOT NULL CHECK (amount_poisha > 0),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'approved', 'processing', 'paid', 'failed', 'reversed')),
  destination_reference text NOT NULL,
  provider_reference text,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exit_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL REFERENCES allocations(id),
  investor_id uuid NOT NULL REFERENCES users(id),
  reason text,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'approved_waiting_liquidity', 'approved', 'rejected', 'completed', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text
);

CREATE TABLE referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES users(id),
  referred_user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  referral_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_id <> referred_user_id)
);

CREATE TABLE referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL REFERENCES referrals(id),
  qualifying_application_id uuid NOT NULL UNIQUE REFERENCES investment_applications(id),
  reward_poisha bigint NOT NULL CHECK (reward_poisha > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'eligible', 'approved', 'paid', 'reversed', 'rejected')),
  eligible_at timestamptz,
  approved_by uuid REFERENCES users(id),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'sms', 'push')),
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'read')),
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_by uuid NOT NULL REFERENCES users(id),
  project_id uuid REFERENCES projects(id),
  subject text NOT NULL,
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'waiting_user', 'resolved', 'closed')),
  assigned_to uuid REFERENCES users(id),
  resolution text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE idempotency_records (
  key text PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  operation text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  reason text,
  before_json jsonb,
  after_json jsonb,
  ip_address inet,
  user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX projects_marketplace_idx ON projects(status, category, published_at DESC);
CREATE INDEX applications_investor_idx ON investment_applications(investor_id, created_at DESC);
CREATE INDEX applications_project_idx ON investment_applications(project_id, status);
CREATE INDEX payments_review_idx ON payments(status, submitted_at);
CREATE INDEX allocations_investor_idx ON allocations(investor_id, activated_at DESC);
CREATE INDEX allocations_maturity_idx ON allocations(status, maturity_at);
CREATE INDEX performance_reports_review_idx ON performance_reports(status, submitted_at);
CREATE INDEX payouts_processing_idx ON payouts(status, created_at);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX support_cases_status_idx ON support_cases(status, priority, opened_at);
CREATE INDEX audit_subject_idx ON audit_logs(subject_type, subject_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER investor_profiles_set_updated_at
BEFORE UPDATE ON investor_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER projects_set_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit logs are append-only';
END;
$$;

CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

COMMIT;
