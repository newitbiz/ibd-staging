BEGIN;

-- Super Admin feature pack: owner disbursements, disbursement rules, role access, service charge.
-- Additive / idempotent. Staging only — no live bank rails.

-- ---------------------------------------------------------------------------
-- A) Platform settings: default service charge (administration fee) in bps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

INSERT INTO platform_settings(key, value_json)
VALUES ('default_administration_fee_bps', '200'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Role → route-group allowlist (checklist). value is { "role_code": ["overview","projects",...] }
INSERT INTO platform_settings(key, value_json)
VALUES (
  'role_route_access',
  '{
    "super_admin": ["overview","projects","payments","allocations","settings","disbursements","users","audit","referrals","exits","reports"],
    "project_reviewer": ["overview","projects","disbursements"],
    "compliance_reviewer": ["overview","projects","users"],
    "finance_officer": ["overview","payments","allocations","disbursements","referrals","exits","reports"],
    "support": ["overview","users"],
    "auditor": ["overview","allocations","audit","reports"]
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- B) Project disbursement rules (milestone % schedule) — set by admin after review
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS disbursement_rules_json jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS disbursement_rules_set_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS disbursement_rules_set_by uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS disbursement_rules_notes text;

COMMENT ON COLUMN projects.disbursement_rules_json IS
  'Array of {label, percentBps, trigger} milestones for owner disbursement schedule (staging guidance).';

-- ---------------------------------------------------------------------------
-- C) Owner disbursement requests (display-only payout records; funds_moved=false)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS owner_disbursement_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  amount_poisha bigint NOT NULL CHECK (amount_poisha > 0),
  explanation text NOT NULL CHECK (char_length(trim(explanation)) >= 10 AND char_length(explanation) <= 4000),
  project_update_text text,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'under_review', 'approved', 'rejected', 'paid_recorded')),
  project_status_at_request text NOT NULL,
  funding_progress_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  step_hint text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  approved_amount_poisha bigint CHECK (approved_amount_poisha IS NULL OR approved_amount_poisha > 0),
  paid_recorded_at timestamptz,
  paid_recorded_by uuid REFERENCES users(id),
  payout_reference text,
  payout_method text CHECK (payout_method IS NULL OR payout_method IN ('bank_transfer_record', 'cash_record', 'other_record')),
  funds_moved boolean NOT NULL DEFAULT false,
  ledger_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS owner_disbursement_requests_status_idx
  ON owner_disbursement_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS owner_disbursement_requests_project_idx
  ON owner_disbursement_requests (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS owner_disbursement_requests_owner_idx
  ON owner_disbursement_requests (owner_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- D) Optional explicit role_route_access table (mirrors setting; for checklist UI)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_route_access (
  role_code text NOT NULL,
  route_group text NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  PRIMARY KEY (role_code, route_group)
);

-- Seed from platform_settings default if empty
INSERT INTO role_route_access(role_code, route_group, allowed)
SELECT r.key AS role_code, g.value AS route_group, true
FROM platform_settings ps
CROSS JOIN LATERAL jsonb_each(ps.value_json) AS r(key, val)
CROSS JOIN LATERAL jsonb_array_elements_text(r.val) AS g(value)
WHERE ps.key = 'role_route_access'
ON CONFLICT (role_code, route_group) DO NOTHING;

COMMIT;
