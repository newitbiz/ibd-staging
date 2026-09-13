BEGIN;

-- Admin investor/owner drilldown + project status-update cadence (additive).

-- ---------------------------------------------------------------------------
-- A) Project status update cadence (7 / 15 / 30 days; default 15)
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS status_update_cadence_days integer NOT NULL DEFAULT 15;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS last_owner_status_update_at timestamptz;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS status_update_overdue_flagged_at timestamptz;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS status_update_overdue_flagged_by uuid REFERENCES users(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_status_update_cadence_days_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_status_update_cadence_days_check
      CHECK (status_update_cadence_days IN (7, 15, 30));
  END IF;
END $$;

COMMENT ON COLUMN projects.status_update_cadence_days IS
  'Owner must post a project status update every N days (7|15|30). Default 15.';
COMMENT ON COLUMN projects.last_owner_status_update_at IS
  'Timestamp of the latest owner status update (project_updates published or explicit status history).';

-- Backfill last update from latest published project_updates, else published_at, else created_at.
UPDATE projects p
SET last_owner_status_update_at = COALESCE(
  (
    SELECT MAX(COALESCE(pu.published_at, pu.created_at))
    FROM project_updates pu
    WHERE pu.project_id = p.id
      AND pu.status IN ('published', 'submitted')
  ),
  p.published_at,
  p.created_at
)
WHERE p.last_owner_status_update_at IS NULL;

-- ---------------------------------------------------------------------------
-- B) Immutable project status-update history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_status_update_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  source text NOT NULL DEFAULT 'owner_update'
    CHECK (source IN ('owner_update', 'admin_note', 'system_backfill', 'nudge', 'flag', 'unflag')),
  body text,
  project_update_id uuid REFERENCES project_updates(id) ON DELETE SET NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_status_update_history_project_idx
  ON project_status_update_history (project_id, occurred_at DESC);

COMMENT ON TABLE project_status_update_history IS
  'Immutable history of project status updates and admin overdue actions. Rows are never updated/deleted by app code.';

-- ---------------------------------------------------------------------------
-- C) Admin overdue actions (nudge / flag) audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_update_overdue_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('nudge', 'flag', 'unflag')),
  note text,
  support_case_id uuid REFERENCES support_cases(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_update_overdue_actions_project_idx
  ON project_update_overdue_actions (project_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- D) Investor profile review / update requests (support-case style)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profile_review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  required_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'cancelled')),
  support_case_id uuid REFERENCES support_cases(id) ON DELETE SET NULL,
  admin_note text,
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_review_requests_investor_idx
  ON profile_review_requests (investor_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS profile_review_requests_status_idx
  ON profile_review_requests (status, created_at DESC);

COMMENT ON TABLE profile_review_requests IS
  'Admin-requested profile review/update for an investor. Status pending|done|cancelled. No private doc bytes stored.';

COMMIT;
