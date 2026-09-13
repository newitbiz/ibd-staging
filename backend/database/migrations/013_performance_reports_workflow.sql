BEGIN;

-- Phase 8: Performance reports workflow + Available payable amount support.
-- Additive only. Approving a report may generate Approved distributions (profit_confirmations)
-- pro-rata by investment_poisha. Never moves funds / never enables live payouts.

ALTER TABLE performance_reports ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE performance_reports ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE performance_reports ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE performance_reports ADD COLUMN IF NOT EXISTS under_review_at timestamptz;
ALTER TABLE performance_reports ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE performance_reports ADD COLUMN IF NOT EXISTS decided_by uuid;
ALTER TABLE performance_reports ADD COLUMN IF NOT EXISTS distributions_generated_at timestamptz;
ALTER TABLE performance_reports ADD COLUMN IF NOT EXISTS distributions_generated_count integer;

UPDATE performance_reports
SET updated_at = COALESCE(updated_at, approved_at, submitted_at, now())
WHERE updated_at IS NULL;

ALTER TABLE performance_reports
  ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'performance_reports_decided_by_fkey'
  ) THEN
    ALTER TABLE performance_reports
      ADD CONSTRAINT performance_reports_decided_by_fkey
      FOREIGN KEY (decided_by) REFERENCES users(id);
  END IF;
END $$;

ALTER TABLE performance_reports DROP CONSTRAINT IF EXISTS performance_reports_rejection_reason_len_check;
ALTER TABLE performance_reports ADD CONSTRAINT performance_reports_rejection_reason_len_check CHECK (
  rejection_reason IS NULL OR char_length(rejection_reason) <= 2000
);

ALTER TABLE performance_reports DROP CONSTRAINT IF EXISTS performance_reports_review_note_len_check;
ALTER TABLE performance_reports ADD CONSTRAINT performance_reports_review_note_len_check CHECK (
  review_note IS NULL OR char_length(review_note) <= 2000
);

ALTER TABLE performance_reports DROP CONSTRAINT IF EXISTS performance_reports_supporting_document_key_len_check;
ALTER TABLE performance_reports ADD CONSTRAINT performance_reports_supporting_document_key_len_check CHECK (
  supporting_document_key IS NULL OR char_length(supporting_document_key) <= 500
);

CREATE INDEX IF NOT EXISTS performance_reports_project_submitted_idx
  ON performance_reports(project_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS performance_reports_owner_submitted_idx
  ON performance_reports(submitted_by, submitted_at DESC);

CREATE INDEX IF NOT EXISTS performance_reports_status_submitted_idx
  ON performance_reports(status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS profit_confirmations_source_report_idx
  ON profit_confirmations(source_report_id)
  WHERE source_report_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_logs_action_occurred_idx
  ON audit_logs(action, occurred_at DESC);

CREATE INDEX IF NOT EXISTS payouts_investor_status_type_idx
  ON payouts(investor_id, status, payout_type);

COMMIT;
