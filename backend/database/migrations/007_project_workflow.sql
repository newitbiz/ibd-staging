BEGIN;

-- Phase 2: project workflow fields, category FK, status rename, version history.
-- Idempotent: safe to re-run after partial apply within schema_migrations guard.

-- 1) Expand projects with workflow + commercial columns (nullable until constraints tighten).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES categories(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_code text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS version_number integer NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS funding_target_poisha bigint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS funding_target_exception boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS funding_target_exception_reason text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS projected_return_min_bps integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS projected_return_max_bps integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS selected_rate_bps integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS funding_opens_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS funding_closes_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_starts_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_ends_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS risk_disclosure text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS terms_text text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS exit_policy text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS change_request_reason text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS paused_by uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS funding_closed_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS funding_closed_by uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES users(id);

-- 2) Convert status enum → text with Phase-2 workflow names (map legacy values).
-- Drop table CHECK constraints first (legacy status<>'published' compares enum to text and blocks ALTER TYPE).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'projects'::regclass
      AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE projects DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE projects ALTER COLUMN status DROP DEFAULT;
ALTER TABLE projects ALTER COLUMN status TYPE text USING (
  CASE status::text
    WHEN 'submitted' THEN 'submitted_for_review'
    WHEN 'under_review' THEN 'submitted_for_review'
    WHEN 'revision_requested' THEN 'changes_requested'
    WHEN 'approved_unpublished' THEN 'approved'
    WHEN 'funding_paused' THEN 'paused'
    WHEN 'funded' THEN 'funding_closed'
    WHEN 'closed' THEN 'cancelled'
    WHEN 'suspended' THEN 'archived'
    WHEN 'defaulted' THEN 'cancelled'
    ELSE status::text
  END
);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_workflow_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_workflow_check CHECK (
  status IN (
    'draft',
    'submitted_for_review',
    'changes_requested',
    'resubmitted',
    'approved',
    'published',
    'paused',
    'funding_closed',
    'active',
    'completed',
    'rejected',
    'cancelled',
    'archived'
  )
);
ALTER TABLE projects ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_units_cap_check;
ALTER TABLE projects ADD CONSTRAINT projects_units_cap_check
  CHECK (reserved_units + active_units <= total_units);

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_published_terms_check;
ALTER TABLE projects ADD CONSTRAINT projects_published_terms_check
  CHECK (
    (status <> 'published')
    OR (published_terms_version IS NOT NULL AND published_at IS NOT NULL)
  );

-- Restore column-level money checks dropped with table checks above.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_total_units_check;
ALTER TABLE projects ADD CONSTRAINT projects_total_units_check CHECK (total_units > 0);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_reserved_units_check;
ALTER TABLE projects ADD CONSTRAINT projects_reserved_units_check CHECK (reserved_units >= 0);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_active_units_check;
ALTER TABLE projects ADD CONSTRAINT projects_active_units_check CHECK (active_units >= 0);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_unit_investment_poisha_check;
ALTER TABLE projects ADD CONSTRAINT projects_unit_investment_poisha_check CHECK (unit_investment_poisha > 0);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_administration_fee_bps_check;
ALTER TABLE projects ADD CONSTRAINT projects_administration_fee_bps_check CHECK (administration_fee_bps BETWEEN 0 AND 10000);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_target_profit_bps_check;
ALTER TABLE projects ADD CONSTRAINT projects_target_profit_bps_check CHECK (target_profit_bps BETWEEN 0 AND 10000);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_duration_days_check;
ALTER TABLE projects ADD CONSTRAINT projects_duration_days_check CHECK (duration_days > 0);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_minimum_exit_days_check;
ALTER TABLE projects ADD CONSTRAINT projects_minimum_exit_days_check
  CHECK (minimum_exit_days IS NULL OR minimum_exit_days >= 0);

-- 3) Backfill category_id from free-text category (name/slug).
UPDATE projects p
SET category_id = c.id
FROM categories c
WHERE p.category_id IS NULL
  AND (
    lower(trim(p.category)) = lower(c.name)
    OR lower(trim(p.category)) = lower(c.slug)
    OR lower(replace(trim(p.category), ' ', '-')) = lower(c.slug)
  );

-- Report unmatched categories via NOTICE (no deletes).
DO $$
DECLARE
  r RECORD;
  unmatched_count integer := 0;
BEGIN
  FOR r IN
    SELECT id, title, category
    FROM projects
    WHERE category_id IS NULL
  LOOP
    unmatched_count := unmatched_count + 1;
    RAISE NOTICE '007_project_workflow unmatched category project_id=% title=% category=%',
      r.id, r.title, r.category;
  END LOOP;
  RAISE NOTICE '007_project_workflow unmatched category count=%', unmatched_count;
END $$;

-- Assign unmatched rows to first active category to satisfy NOT NULL without deleting projects.
UPDATE projects p
SET category_id = (
  SELECT id FROM categories WHERE is_active = true ORDER BY display_order ASC, name ASC LIMIT 1
),
category = COALESCE(
  (SELECT name FROM categories WHERE is_active = true ORDER BY display_order ASC, name ASC LIMIT 1),
  p.category
)
WHERE p.category_id IS NULL
  AND EXISTS (SELECT 1 FROM categories WHERE is_active = true);

-- Keep category text in sync with FK name.
UPDATE projects p
SET category = c.name
FROM categories c
WHERE p.category_id = c.id
  AND p.category IS DISTINCT FROM c.name;

-- After backfill, require category_id for all rows going forward.
ALTER TABLE projects ALTER COLUMN category_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS projects_category_id_idx ON projects (category_id);

-- 4) Slug + project_code backfill.
UPDATE projects
SET slug = lower(regexp_replace(regexp_replace(trim(title), '[^a-zA-Z0-9]+', '-', 'g'), '(^-|-$)', '', 'g'))
    || '-' || substr(replace(id::text, '-', ''), 1, 8)
WHERE slug IS NULL OR trim(slug) = '';

UPDATE projects
SET project_code = 'GB-' || to_char(created_at, 'YYYY') || '-' || upper(substr(replace(id::text, '-', ''), 1, 6))
WHERE project_code IS NULL OR trim(project_code) = '';

CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_uidx ON projects (slug);
CREATE UNIQUE INDEX IF NOT EXISTS projects_project_code_uidx ON projects (project_code);

-- 5) Financial backfills (poisha / bps integers — never float).
UPDATE projects
SET funding_target_poisha = unit_investment_poisha * total_units
WHERE funding_target_poisha IS NULL;

UPDATE projects
SET selected_rate_bps = target_profit_bps
WHERE selected_rate_bps IS NULL;

UPDATE projects
SET projected_return_min_bps = GREATEST(0, target_profit_bps - 500),
    projected_return_max_bps = target_profit_bps + 500
WHERE projected_return_min_bps IS NULL OR projected_return_max_bps IS NULL;

UPDATE projects
SET funding_opens_at = COALESCE(published_at, created_at),
    funding_closes_at = COALESCE(published_at, created_at) + (duration_days || ' days')::interval,
    project_starts_at = COALESCE(published_at, created_at),
    project_ends_at = COALESCE(published_at, created_at) + (duration_days || ' days')::interval
WHERE status = 'published'
  AND (funding_opens_at IS NULL OR funding_closes_at IS NULL OR project_starts_at IS NULL OR project_ends_at IS NULL);

-- Soft defaults for risk/terms/exit on already-published rows so publish completeness holds.
UPDATE projects
SET risk_disclosure = COALESCE(NULLIF(trim(risk_disclosure), ''), 'Standard marketplace risk disclosure — capital at risk; returns not guaranteed.'),
    terms_text = COALESCE(NULLIF(trim(terms_text), ''), 'Standard investment terms apply as approved by Grow Bangladesh staff.'),
    exit_policy = COALESCE(NULLIF(trim(exit_policy), ''), 'Early exit subject to minimum hold period and liquidity review. Not a withdrawable balance.')
WHERE status IN ('published', 'paused', 'funding_closed', 'active', 'completed')
  AND (
    risk_disclosure IS NULL OR trim(risk_disclosure) = ''
    OR terms_text IS NULL OR trim(terms_text) = ''
    OR exit_policy IS NULL OR trim(exit_policy) = ''
  );

-- 6) Check constraints for money / rates (allow NULL on drafts for incomplete fields).
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_funding_target_positive;
ALTER TABLE projects ADD CONSTRAINT projects_funding_target_positive
  CHECK (funding_target_poisha IS NULL OR funding_target_poisha > 0);

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_projection_range;
ALTER TABLE projects ADD CONSTRAINT projects_projection_range
  CHECK (
    projected_return_min_bps IS NULL
    OR projected_return_max_bps IS NULL
    OR projected_return_min_bps <= projected_return_max_bps
  );

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_selected_rate_range;
ALTER TABLE projects ADD CONSTRAINT projects_selected_rate_range
  CHECK (
    selected_rate_bps IS NULL
    OR projected_return_min_bps IS NULL
    OR projected_return_max_bps IS NULL
    OR (selected_rate_bps >= projected_return_min_bps AND selected_rate_bps <= projected_return_max_bps)
  );

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_fee_bps_safe;
ALTER TABLE projects ADD CONSTRAINT projects_fee_bps_safe
  CHECK (administration_fee_bps BETWEEN 0 AND 3000);

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_funding_window;
ALTER TABLE projects ADD CONSTRAINT projects_funding_window
  CHECK (
    funding_opens_at IS NULL
    OR funding_closes_at IS NULL
    OR funding_closes_at > funding_opens_at
  );

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_term_window;
ALTER TABLE projects ADD CONSTRAINT projects_term_window
  CHECK (
    project_starts_at IS NULL
    OR project_ends_at IS NULL
    OR project_ends_at > project_starts_at
  );

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_slug_format;
ALTER TABLE projects ADD CONSTRAINT projects_slug_format
  CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_version_positive;
ALTER TABLE projects ADD CONSTRAINT projects_version_positive
  CHECK (version_number >= 1);

-- 7) Version history for material financial-term changes.
CREATE TABLE IF NOT EXISTS project_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  version_number integer NOT NULL CHECK (version_number > 0),
  snapshot_json jsonb NOT NULL,
  content_hash text NOT NULL,
  change_summary text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version_number)
);

CREATE INDEX IF NOT EXISTS project_versions_project_id_idx
  ON project_versions (project_id, version_number DESC);

-- Seed initial version rows for existing projects (idempotent).
INSERT INTO project_versions (project_id, version_number, snapshot_json, content_hash, change_summary, created_by)
SELECT
  p.id,
  p.version_number,
  jsonb_build_object(
    'title', p.title,
    'categoryId', p.category_id,
    'unitInvestmentPoisha', p.unit_investment_poisha,
    'administrationFeeBps', p.administration_fee_bps,
    'totalUnits', p.total_units,
    'fundingTargetPoisha', p.funding_target_poisha,
    'projectedReturnMinBps', p.projected_return_min_bps,
    'projectedReturnMaxBps', p.projected_return_max_bps,
    'selectedRateBps', p.selected_rate_bps,
    'durationDays', p.duration_days,
    'minimumExitDays', p.minimum_exit_days,
    'riskDisclosure', p.risk_disclosure,
    'termsText', p.terms_text,
    'exitPolicy', p.exit_policy,
    'status', p.status
  ),
  md5(
    concat_ws('|',
      p.unit_investment_poisha::text,
      p.administration_fee_bps::text,
      p.total_units::text,
      COALESCE(p.funding_target_poisha::text, ''),
      COALESCE(p.selected_rate_bps::text, ''),
      p.duration_days::text
    )
  ),
  'migration_007_initial_snapshot',
  p.approved_by
FROM projects p
ON CONFLICT (project_id, version_number) DO NOTHING;

COMMIT;
