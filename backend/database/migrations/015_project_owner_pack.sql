BEGIN;

-- Project Owner feature pack (owner DOCX + approved extras). Additive / idempotent.
-- Avoids conflicting with legacy schema tables project_milestones / project_updates.

-- ---------------------------------------------------------------------------
-- A) Extended Create Funding Project fields on projects
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS location_address text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS details_text text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS investment_years integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS estimated_yearly_profit_bps integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS bad_loss_summary text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_experience text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS educational_background text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_investment_years_check') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_investment_years_check
      CHECK (investment_years IS NULL OR investment_years BETWEEN 1 AND 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_estimated_yearly_profit_bps_check') THEN
    ALTER TABLE projects ADD CONSTRAINT projects_estimated_yearly_profit_bps_check
      CHECK (estimated_yearly_profit_bps IS NULL OR estimated_yearly_profit_bps BETWEEN 0 AND 10000);
  END IF;
END $$;

UPDATE projects
SET investment_years = LEAST(5, GREATEST(1, ROUND(duration_days / 365.0)::integer))
WHERE investment_years IS NULL AND duration_days IS NOT NULL AND duration_days > 0;

UPDATE projects
SET estimated_yearly_profit_bps = COALESCE(selected_rate_bps, target_profit_bps)
WHERE estimated_yearly_profit_bps IS NULL
  AND COALESCE(selected_rate_bps, target_profit_bps) IS NOT NULL;

-- ---------------------------------------------------------------------------
-- B) Platform setting: project review fee (default ৳500 = 50_000 poisha)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

INSERT INTO platform_settings(key, value_json)
VALUES ('project_review_fee_poisha', '50000'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- C) Per-project review fee receipt / status
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_review_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  amount_poisha bigint NOT NULL CHECK (amount_poisha >= 0),
  status text NOT NULL DEFAULT 'unpaid'
    CHECK (status IN ('unpaid', 'submitted', 'verified', 'waived')),
  payment_method text
    CHECK (payment_method IS NULL OR payment_method IN ('cash', 'bank_deposit')),
  reference text,
  receipt_note text,
  submitted_at timestamptz,
  submitted_by uuid REFERENCES users(id),
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  waived_at timestamptz,
  waived_by uuid REFERENCES users(id),
  waive_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id)
);

CREATE INDEX IF NOT EXISTS project_review_fees_status_idx
  ON project_review_fees (status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- D) Owner application interest inbox (read receipts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS owner_application_reads (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  application_id uuid NOT NULL REFERENCES investment_applications(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, application_id)
);

CREATE INDEX IF NOT EXISTS owner_application_reads_owner_idx
  ON owner_application_reads (owner_user_id, read_at DESC);

-- ---------------------------------------------------------------------------
-- E) Extend legacy project_updates for owner feed (photo + soft publish)
-- ---------------------------------------------------------------------------
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS project_updates_project_created_idx
  ON project_updates (project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- F) Use-of-funds checklist (separate from legacy release project_milestones)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_use_of_funds_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(trim(title)) >= 1 AND char_length(title) <= 200),
  description text,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'done')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_use_of_funds_items_project_idx
  ON project_use_of_funds_items (project_id, sort_order ASC, created_at ASC);

-- ---------------------------------------------------------------------------
-- G) Owner request pause / close funding → Admin
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_funding_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  request_type text NOT NULL CHECK (request_type IN ('pause', 'close')),
  reason text NOT NULL CHECK (char_length(trim(reason)) >= 5 AND char_length(reason) <= 2000),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_funding_requests_status_idx
  ON project_funding_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS project_funding_requests_project_idx
  ON project_funding_requests (project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- H) Dual-role: ensure owner-test can also invest
-- ---------------------------------------------------------------------------
INSERT INTO user_roles(user_id, role_code, granted_by)
SELECT u.id, 'investor', u.id
FROM users u
WHERE lower(u.email) = 'owner-test@growbangladesh.test'
ON CONFLICT (user_id, role_code) DO NOTHING;

COMMIT;
