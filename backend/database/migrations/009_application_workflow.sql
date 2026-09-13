BEGIN;

-- Phase 4: investment application review workflow (browse/apply already partially present).
-- Convert application_status enum → text with extended statuses; add decision columns.

-- 1) Decision / review columns
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS changes_requested_reason text;
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES users(id);
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS under_review_at timestamptz;
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS under_review_by uuid REFERENCES users(id);
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id);
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS project_version_number integer;
ALTER TABLE investment_applications ADD COLUMN IF NOT EXISTS resubmitted_at timestamptz;

-- Backfill project_version_number from projects.version_number when missing
UPDATE investment_applications app
SET project_version_number = COALESCE(app.project_version_number, p.version_number, 1)
FROM projects p
WHERE p.id = app.project_id
  AND app.project_version_number IS NULL;

ALTER TABLE investment_applications
  ALTER COLUMN project_version_number SET DEFAULT 1;

-- 2) Convert status enum → text with Phase-4 workflow names
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'investment_applications'::regclass
      AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE investment_applications DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE investment_applications ALTER COLUMN status DROP DEFAULT;

-- Only alter type if still enum
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_attribute a ON a.atttypid = t.oid
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'investment_applications' AND a.attname = 'status' AND t.typtype = 'e'
  ) OR EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'investment_applications'
      AND column_name = 'status'
      AND udt_name = 'application_status'
  ) THEN
    ALTER TABLE investment_applications
      ALTER COLUMN status TYPE text USING status::text;
  END IF;
END $$;

-- Ensure column is text even if already converted
ALTER TABLE investment_applications
  ALTER COLUMN status TYPE text USING status::text;

ALTER TABLE investment_applications DROP CONSTRAINT IF EXISTS applications_status_workflow_check;
ALTER TABLE investment_applications ADD CONSTRAINT applications_status_workflow_check CHECK (
  status IN (
    'draft',
    'submitted',
    'under_review',
    'changes_requested',
    'approved_payment_pending',
    'payment_verification_pending',
    'active',
    'rejected',
    'expired',
    'cancelled',
    'payment_rejected',
    'matured',
    'exit_requested',
    'exit_processing',
    'exited',
    'defaulted'
  )
);

ALTER TABLE investment_applications ALTER COLUMN status SET DEFAULT 'submitted';

-- Re-add financial CHECKs dropped above
ALTER TABLE investment_applications DROP CONSTRAINT IF EXISTS investment_applications_units_check;
ALTER TABLE investment_applications ADD CONSTRAINT investment_applications_units_check CHECK (units > 0);
ALTER TABLE investment_applications DROP CONSTRAINT IF EXISTS investment_applications_unit_investment_poisha_check;
ALTER TABLE investment_applications ADD CONSTRAINT investment_applications_unit_investment_poisha_check CHECK (unit_investment_poisha > 0);
ALTER TABLE investment_applications DROP CONSTRAINT IF EXISTS investment_applications_investment_poisha_check;
ALTER TABLE investment_applications ADD CONSTRAINT investment_applications_investment_poisha_check CHECK (investment_poisha > 0);
ALTER TABLE investment_applications DROP CONSTRAINT IF EXISTS investment_applications_administration_fee_poisha_check;
ALTER TABLE investment_applications ADD CONSTRAINT investment_applications_administration_fee_poisha_check CHECK (administration_fee_poisha >= 0);
ALTER TABLE investment_applications DROP CONSTRAINT IF EXISTS investment_applications_total_payable_poisha_check;
ALTER TABLE investment_applications ADD CONSTRAINT investment_applications_total_payable_poisha_check CHECK (total_payable_poisha > 0);
ALTER TABLE investment_applications DROP CONSTRAINT IF EXISTS investment_applications_check;
ALTER TABLE investment_applications ADD CONSTRAINT investment_applications_investment_eq CHECK (investment_poisha = unit_investment_poisha * units);
ALTER TABLE investment_applications DROP CONSTRAINT IF EXISTS investment_applications_check1;
ALTER TABLE investment_applications ADD CONSTRAINT investment_applications_total_eq CHECK (total_payable_poisha = investment_poisha + administration_fee_poisha);

CREATE INDEX IF NOT EXISTS applications_status_created_idx ON investment_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS applications_project_status_idx ON investment_applications(project_id, status);

COMMIT;
