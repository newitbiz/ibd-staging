BEGIN;

-- Final Demo / UAT: user lifecycle, identity verification, related persons,
-- private documents, profile completion, business verification items, agreements.
-- Idempotent additive migration. Private TEST/STAGING only.

-- ---------------------------------------------------------------------------
-- A) User lifecycle (deactivate/suspend/archive — NOT hard-delete with deps)
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_lifecycle text,
  ADD COLUMN IF NOT EXISTS lifecycle_reason text,
  ADD COLUMN IF NOT EXISTS lifecycle_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_changed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS profile_photo_document_id uuid,
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_policy_flag text;

UPDATE users SET account_lifecycle = CASE
  WHEN status = 'active' THEN 'active'
  WHEN status = 'suspended' THEN 'suspended'
  WHEN status = 'closed' THEN 'archived'
  WHEN status = 'pending_verification' THEN 'pending'
  ELSE COALESCE(account_lifecycle, 'pending')
END
WHERE account_lifecycle IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_account_lifecycle_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_account_lifecycle_check
      CHECK (account_lifecycle IS NULL OR account_lifecycle IN (
        'pending','active','paused','suspended','deactivated','archived'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_account_lifecycle_idx ON users (account_lifecycle);
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_mobile_idx ON users (mobile);

-- ---------------------------------------------------------------------------
-- D) Private document storage metadata (bytes never in GitHub; keys in Postgres)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS private_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  subject_type text NOT NULL CHECK (subject_type IN (
    'user_identity','related_person','business','project','agreement','payment_evidence','other'
  )),
  subject_id uuid,
  document_kind text NOT NULL,
  original_filename text NOT NULL,
  sanitized_filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 52428800),
  content_sha256 text NOT NULL,
  storage_backend text NOT NULL DEFAULT 'local_volume'
    CHECK (storage_backend IN ('local_volume','s3_compatible','railway_bucket')),
  storage_key text NOT NULL UNIQUE,
  is_fictional_demo boolean NOT NULL DEFAULT true,
  fictional_banner text NOT NULL DEFAULT 'FICTIONAL DEMO — NOT A REAL DOCUMENT',
  malware_scan_status text NOT NULL DEFAULT 'stub_pending'
    CHECK (malware_scan_status IN ('stub_pending','stub_clean','stub_rejected','clean','rejected')),
  review_status text NOT NULL DEFAULT 'submitted'
    CHECK (review_status IN (
      'not_provided','submitted','under_review','correction_required','verified','rejected','expired'
    )),
  review_note text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  replaced_by_document_id uuid REFERENCES private_documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS private_documents_owner_idx ON private_documents (owner_user_id);
CREATE INDEX IF NOT EXISTS private_documents_subject_idx ON private_documents (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS private_documents_kind_idx ON private_documents (document_kind);

CREATE TABLE IF NOT EXISTS private_document_access_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES private_documents(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('upload','view_meta','signed_url','download','replace','review','delete_meta')),
  ip_address inet,
  user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS private_document_access_logs_doc_idx
  ON private_document_access_logs (document_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- B) Identity verification (owner + investor)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity_verifications (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  legal_name text,
  date_of_birth date,
  nationality text,
  phone text,
  phone_verification_label text NOT NULL DEFAULT 'Staging verification — mobile OTP not enabled',
  present_address text,
  permanent_address text,
  id_document_type text CHECK (id_document_type IS NULL OR id_document_type IN ('nid','passport')),
  id_number_ciphertext text,
  id_number_last4 text,
  id_front_document_id uuid REFERENCES private_documents(id),
  id_back_document_id uuid REFERENCES private_documents(id),
  profile_photo_document_id uuid REFERENCES private_documents(id),
  selfie_document_id uuid REFERENCES private_documents(id),
  selfie_review_mode text NOT NULL DEFAULT 'manual'
    CHECK (selfie_review_mode = 'manual'),
  status text NOT NULL DEFAULT 'not_provided'
    CHECK (status IN (
      'not_provided','submitted','under_review','correction_required','verified','rejected','expired'
    )),
  admin_comments text,
  reviewer_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  is_fictional_demo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_verification_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  previous_status text,
  new_status text NOT NULL,
  reason text,
  actor_id uuid REFERENCES users(id),
  audit_event_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_verification_history_user_idx
  ON identity_verification_history (user_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- C) Related persons (optional, access-controlled, fictional only in staging)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS related_persons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  relationship text NOT NULL CHECK (relationship IN (
    'father','mother','spouse','child','nominee','other'
  )),
  full_name text NOT NULL,
  date_of_birth date,
  is_minor boolean NOT NULL DEFAULT false,
  nationality text,
  phone text,
  email text,
  present_address text,
  id_document_type text CHECK (id_document_type IS NULL OR id_document_type IN ('nid','passport','birth_certificate','none')),
  id_number_ciphertext text,
  id_number_last4 text,
  id_document_id uuid REFERENCES private_documents(id),
  notes text,
  is_fictional_demo boolean NOT NULL DEFAULT true,
  fictional_banner text NOT NULL DEFAULT 'FICTIONAL DEMO — NOT A REAL DOCUMENT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS related_persons_owner_idx ON related_persons (owner_user_id);

-- ---------------------------------------------------------------------------
-- E) Profile completion snapshots (DB-calculated fields also live on row)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profile_completion (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  personal_pct integer NOT NULL DEFAULT 0 CHECK (personal_pct BETWEEN 0 AND 100),
  identity_pct integer NOT NULL DEFAULT 0 CHECK (identity_pct BETWEEN 0 AND 100),
  business_pct integer NOT NULL DEFAULT 0 CHECK (business_pct BETWEEN 0 AND 100),
  overall_pct integer NOT NULL DEFAULT 0 CHECK (overall_pct BETWEEN 0 AND 100),
  missing_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- F) Project Owner business verification items
-- ---------------------------------------------------------------------------
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS trade_name text,
  ADD COLUMN IF NOT EXISTS registered_address text,
  ADD COLUMN IF NOT EXISTS business_phone text,
  ADD COLUMN IF NOT EXISTS business_email text,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS business_type text,
  ADD COLUMN IF NOT EXISTS incorporation_date date,
  ADD COLUMN IF NOT EXISTS business_verification_pct integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS business_status text,
  ADD COLUMN IF NOT EXISTS admin_review_note text,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_fictional_demo boolean DEFAULT true;

UPDATE businesses SET business_status = COALESCE(business_status, verification_status, 'pending')
WHERE business_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'businesses_business_status_check') THEN
    ALTER TABLE businesses ADD CONSTRAINT businesses_business_status_check
      CHECK (business_status IS NULL OR business_status IN (
        'not_provided','submitted','under_review','correction_required','verified','rejected','expired','pending'
      ));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS business_verification_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  item_code text NOT NULL,
  label text NOT NULL,
  value_text text,
  document_id uuid REFERENCES private_documents(id),
  status text NOT NULL DEFAULT 'not_provided'
    CHECK (status IN (
      'not_provided','submitted','under_review','correction_required','verified','rejected','expired'
    )),
  admin_note text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  is_fictional_demo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, item_code)
);

CREATE INDEX IF NOT EXISTS business_verification_items_biz_idx
  ON business_verification_items (business_id);

-- ---------------------------------------------------------------------------
-- G–H) Project draft / disclaimer extensions
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS location_text text,
  ADD COLUMN IF NOT EXISTS funding_purpose text,
  ADD COLUMN IF NOT EXISTS risk_summary text,
  ADD COLUMN IF NOT EXISTS projection_disclaimer text,
  ADD COLUMN IF NOT EXISTS pause_notice text,
  ADD COLUMN IF NOT EXISTS is_fictional_demo boolean DEFAULT true;

UPDATE projects
SET projection_disclaimer = COALESCE(
  projection_disclaimer,
  'Projected returns are illustrative estimates on principal only, never withdrawable, and not a guarantee of profit. Administration fee is separate from principal.'
)
WHERE projection_disclaimer IS NULL;

-- ---------------------------------------------------------------------------
-- K) Final investment agreements (PDF metadata + email delivery status)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS investment_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_number text NOT NULL UNIQUE,
  application_id uuid NOT NULL UNIQUE REFERENCES investment_applications(id),
  allocation_id uuid UNIQUE REFERENCES allocations(id),
  investor_id uuid NOT NULL REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  terms_version integer NOT NULL,
  acceptance_id uuid REFERENCES agreement_acceptances(id),
  acceptance_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_document_id uuid REFERENCES private_documents(id),
  units integer NOT NULL,
  investment_poisha bigint NOT NULL,
  administration_fee_poisha bigint NOT NULL,
  total_payable_poisha bigint NOT NULL,
  projected_annual_profit_poisha bigint,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','final','void')),
  email_delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (email_delivery_status IN ('pending','recorded_memory','sent','failed','resend_queued')),
  email_delivery_note text,
  emailed_at timestamptz,
  is_fictional_demo boolean NOT NULL DEFAULT true,
  fictional_banner text NOT NULL DEFAULT 'FICTIONAL DEMO — NOT A REAL DOCUMENT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investment_agreements_investor_idx ON investment_agreements (investor_id);
CREATE INDEX IF NOT EXISTS investment_agreements_project_idx ON investment_agreements (project_id);

ALTER TABLE agreement_acceptances
  ADD COLUMN IF NOT EXISTS agreement_version text,
  ADD COLUMN IF NOT EXISTS device_meta jsonb,
  ADD COLUMN IF NOT EXISTS snapshot_json jsonb;

-- Platform settings for staging labels / retention stubs
CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

INSERT INTO platform_settings(key, value_json)
VALUES
  ('phone_otp_staging_label', '"Staging verification — mobile OTP not enabled"'::jsonb),
  ('selfie_review_mode', '"manual"'::jsonb),
  ('retention_anonymize_enabled', 'false'::jsonb),
  ('document_storage_backend', '"local_volume"'::jsonb),
  ('fictional_demo_banner', '"FICTIONAL DEMO — NOT A REAL DOCUMENT"'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
