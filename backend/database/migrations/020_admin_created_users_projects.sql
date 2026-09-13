BEGIN;

-- Admin-created investors/projects + password-change gate + preferred role shell.
-- Activation ≠ KYC. Do not invent verified identity flags here.

ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_admin_id uuid REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_admin_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_admin_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_role_shell text
  CHECK (preferred_role_shell IS NULL OR preferred_role_shell IN ('investor', 'owner', 'admin'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_created_label text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_source text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_created_by_admin_reason_len;
ALTER TABLE users ADD CONSTRAINT users_created_by_admin_reason_len CHECK (
  created_by_admin_reason IS NULL
  OR (char_length(trim(created_by_admin_reason)) >= 3 AND char_length(created_by_admin_reason) <= 2000)
);

COMMENT ON COLUMN users.created_by_admin IS
  'True when Super Admin created this account. Does NOT imply KYC/NID/phone/selfie verified.';
COMMENT ON COLUMN users.must_change_password IS
  'When true, user must change temporary password before using the app.';
COMMENT ON COLUMN users.admin_created_label IS
  'UI label e.g. Admin-created account — never Fully verified.';

ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by_admin boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by_admin_id uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by_admin_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by_admin_reason text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS admin_created_label text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS funding_target_override_reason text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS application_payment_deadline_at timestamptz;

COMMENT ON COLUMN projects.created_by_admin IS
  'True when Super Admin created/published bypassing owner submission workflow.';
COMMENT ON COLUMN projects.admin_created_label IS
  'Internal label e.g. Created by Super Admin.';

-- Immutable project status history (additive; existing transitions keep writing audit_logs too).
CREATE TABLE IF NOT EXISTS project_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  reason text,
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_status_history_project_idx
  ON project_status_history (project_id, occurred_at DESC);

-- Payment deadline on approved applications (Admin-set).
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS payment_deadline_at timestamptz;
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS payment_instructions text;

COMMENT ON COLUMN investment_applications.payment_deadline_at IS
  'Admin-set deadline for cash/bank payment after approval. Shares allocate only after verified payment.';

COMMIT;
