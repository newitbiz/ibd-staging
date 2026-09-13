BEGIN;

-- Staged disbursement plan (admin-defined). Release ≤ verified funds.
-- Complements existing disbursement_rules_json + owner_disbursement_requests.

CREATE TABLE IF NOT EXISTS project_disbursement_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_number integer NOT NULL CHECK (stage_number >= 1 AND stage_number <= 20),
  title text NOT NULL CHECK (char_length(trim(title)) >= 1 AND char_length(title) <= 200),
  percent_bps integer CHECK (percent_bps IS NULL OR (percent_bps >= 0 AND percent_bps <= 10000)),
  amount_poisha bigint CHECK (amount_poisha IS NULL OR amount_poisha >= 0),
  expected_release_date date,
  conditions text,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'pending_review', 'approved', 'released', 'held', 'cancelled')),
  actual_release_date date,
  payment_reference text,
  admin_note text,
  funds_moved boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, stage_number),
  CONSTRAINT project_disbursement_stages_pct_or_amount CHECK (
    percent_bps IS NOT NULL OR amount_poisha IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS project_disbursement_stages_project_idx
  ON project_disbursement_stages (project_id, stage_number);

CREATE TABLE IF NOT EXISTS project_disbursement_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id uuid NOT NULL REFERENCES project_disbursement_stages(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  note text,
  before_json jsonb,
  after_json jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_disbursement_stage_history_stage_idx
  ON project_disbursement_stage_history (stage_id, occurred_at DESC);

COMMENT ON TABLE project_disbursement_stages IS
  'Admin-defined staged disbursement plan. Percents must total 10000 bps (100%) or amounts equal funding target. Released total ≤ verified funds. Staging funds_moved always false.';

COMMIT;
