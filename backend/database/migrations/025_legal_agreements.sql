BEGIN;

-- Legal document catalog + versioned bodies (Admin → Legal Documents).
-- Temporary drafts only until legal_review_status = approved.
-- Additive only; never overwrite historical acceptances.

CREATE TABLE IF NOT EXISTS legal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type text NOT NULL UNIQUE
    CHECK (document_type IN (
      'investor_agreement',
      'project_owner_agreement',
      'project_investment_agreement_template',
      'privacy_notice'
    )),
  title text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legal_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES legal_documents(id),
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  language text NOT NULL DEFAULT 'en'
    CHECK (language IN ('en', 'bn')),
  title text NOT NULL,
  content_markdown text NOT NULL,
  content_html text,
  content_hash text NOT NULL,
  change_summary text,
  effective_at timestamptz,
  published_at timestamptz,
  published_by uuid REFERENCES users(id),
  archived_at timestamptz,
  legal_review_status text NOT NULL DEFAULT 'pending'
    CHECK (legal_review_status IN ('pending', 'approved', 'rejected')),
  is_temporary_draft boolean NOT NULL DEFAULT true,
  draft_banner text NOT NULL DEFAULT 'Temporary draft—legal review pending',
  language_precedence_note text NOT NULL DEFAULT
    'English is the controlling language until a lawyer-approved Bangla translation is published. Bangla stubs are pending lawyer review.',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_number, language)
);

CREATE INDEX IF NOT EXISTS legal_document_versions_doc_status_idx
  ON legal_document_versions (document_id, status, version_number DESC);
CREATE INDEX IF NOT EXISTS legal_document_versions_published_idx
  ON legal_document_versions (document_id, language, status)
  WHERE status = 'published';

-- Immutable admin audit for legal document edits/publishes (no delete/update by app).
CREATE TABLE IF NOT EXISTS legal_document_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES legal_documents(id),
  version_id uuid REFERENCES legal_document_versions(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  before_json jsonb,
  after_json jsonb,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legal_document_audit_doc_idx
  ON legal_document_audit (document_id, occurred_at DESC);

-- Platform-level + purchase legal acceptances (immutable evidence).
-- Complements agreement_acceptances (application-scoped) without replacing it.
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  role_context text NOT NULL
    CHECK (role_context IN ('investor', 'project_owner', 'admin_created', 'purchase')),
  document_type text NOT NULL,
  document_version_id uuid NOT NULL REFERENCES legal_document_versions(id),
  version_number integer NOT NULL,
  content_hash text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  acceptance_method text NOT NULL DEFAULT 'checkbox_after_view'
    CHECK (acceptance_method IN (
      'checkbox_after_view',
      'purchase_checkbox_after_view',
      'first_login_gate',
      'role_switch_gate'
    )),
  application_id uuid REFERENCES investment_applications(id),
  transaction_key text,
  snapshot_markdown text NOT NULL,
  snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted_from_ip inet,
  accepted_user_agent text,
  ip_ua_retention_note text NOT NULL DEFAULT
    'IP/UA retained only as needed for dispute evidence; subject to platform retention policy.',
  evidence_disclaimer text NOT NULL DEFAULT
    'Evidence logging is not a certified electronic signature under any jurisdiction.',
  marketing_consent boolean,
  capital_may_be_lost_ack boolean,
  projection_not_guaranteed_ack boolean,
  viewed_at timestamptz,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_signup_unique
  ON legal_acceptances (user_id, document_type, version_number, role_context)
  WHERE application_id IS NULL AND transaction_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS legal_acceptances_purchase_unique
  ON legal_acceptances (user_id, application_id, document_type, version_number)
  WHERE application_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS legal_acceptances_user_idx
  ON legal_acceptances (user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS legal_acceptances_app_idx
  ON legal_acceptances (application_id)
  WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS legal_acceptances_version_idx
  ON legal_acceptances (document_version_id);

-- Optional marketing consent (separate from agreements; unchecked by default).
CREATE TABLE IF NOT EXISTS marketing_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  consented boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'signup',
  accepted_from_ip inet,
  accepted_user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketing_consents_user_idx ON marketing_consents (user_id, created_at DESC);

-- Gate flags for admin-created / role-switch pending acceptances.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_legal_acceptance boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_owner_agreement boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS legal_acceptance_completed_at timestamptz;

COMMENT ON COLUMN users.pending_legal_acceptance IS
  'When true, user must personally accept applicable published legal docs at first login. Admin cannot accept for them.';
COMMENT ON COLUMN users.pending_owner_agreement IS
  'When true after project_owner role grant, user must accept Project Owner Agreement before owner features.';

-- Instrument type + principal repayment placeholders (no blanket guarantee).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS instrument_type text
  DEFAULT 'profit_participation'
  CHECK (instrument_type IS NULL OR instrument_type IN (
    'profit_participation',
    'revenue_share',
    'convertible_note_placeholder',
    'other_placeholder'
  ));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS principal_repayment_rule text
  DEFAULT 'No blanket principal guarantee. Repayment depends on project performance and instrument terms.';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repayment_debtor_placeholder text
  DEFAULT '[LEGAL PLACEHOLDER: repayment debtor legal name]';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS security_placeholder text
  DEFAULT '[LEGAL PLACEHOLDER: security / collateral description — none unless separately agreed]';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS iec_guarantor_status text
  DEFAULT 'IEC Connect is not a guarantor of principal or return without a separate lawyer-approved guarantee agreement.';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS maturity_rule text
  DEFAULT 'Maturity follows project duration_days from allocation activation unless otherwise stated in the project-specific agreement.';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS exit_refund_rule text
  DEFAULT '[LEGAL PLACEHOLDER: exit / early-exit / refund terms]';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS payment_recipient_placeholder text
  DEFAULT '[LEGAL PLACEHOLDER: payment recipient legal name and bank details]';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS loss_risks_summary text
  DEFAULT 'Capital may be partially or entirely lost. Projected returns are illustrative and not guaranteed.';

-- Purchase-time project-specific agreement snapshots (immutable once accepted).
CREATE TABLE IF NOT EXISTS project_investment_agreement_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES investment_applications(id),
  allocation_id uuid UNIQUE REFERENCES allocations(id),
  investor_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  template_version_id uuid NOT NULL REFERENCES legal_document_versions(id),
  template_version_number integer NOT NULL,
  project_terms_version integer NOT NULL,
  content_markdown text NOT NULL,
  content_hash text NOT NULL,
  filled_fields_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  acceptance_id uuid REFERENCES legal_acceptances(id),
  status text NOT NULL DEFAULT 'pending_acceptance'
    CHECK (status IN ('pending_acceptance', 'accepted', 'finalized', 'void')),
  email_delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (email_delivery_status IN ('pending', 'sent', 'failed', 'resend_queued', 'recorded_memory')),
  email_delivery_attempts integer NOT NULL DEFAULT 0,
  email_last_error text,
  emailed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz
);

CREATE INDEX IF NOT EXISTS project_inv_agr_investor_idx
  ON project_investment_agreement_instances (investor_id, created_at DESC);

-- Extend legacy agreement_acceptances with legal linkage (additive).
ALTER TABLE agreement_acceptances
  ADD COLUMN IF NOT EXISTS legal_acceptance_id uuid REFERENCES legal_acceptances(id),
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS language text DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS acceptance_method text DEFAULT 'checkbox_after_view',
  ADD COLUMN IF NOT EXISTS role_context text DEFAULT 'purchase';

-- Platform settings: block production while legal review pending.
INSERT INTO platform_settings(key, value_json)
VALUES
  ('legal_production_block', 'true'::jsonb),
  ('legal_review_required_for_production', 'true'::jsonb),
  ('legal_draft_banner', '"Temporary draft—legal review pending"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Seed document catalog (versions seeded by app on boot / migrate seed).
INSERT INTO legal_documents(document_type, title, description) VALUES
  ('investor_agreement', 'Investor Agreement', 'Platform investor terms including risk acknowledgment section.'),
  ('project_owner_agreement', 'Project Owner Agreement', 'Terms for project owners listing opportunities on IEC Connect.'),
  ('project_investment_agreement_template', 'Project Investment Agreement (template)', 'Project-specific investment agreement filled at purchase.'),
  ('privacy_notice', 'Privacy Notice', 'How IEC Connect processes personal data.')
ON CONFLICT (document_type) DO NOTHING;

COMMIT;
