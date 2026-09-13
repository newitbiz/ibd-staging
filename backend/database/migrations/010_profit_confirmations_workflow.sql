BEGIN;

-- Phase 5: Approved distributions (profit_confirmations) workflow fields.
-- Additive only — does not alter payouts / exits / referrals.

ALTER TABLE profit_confirmations ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE profit_confirmations ADD COLUMN IF NOT EXISTS declaration_note text;
ALTER TABLE profit_confirmations ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE profit_confirmations ADD COLUMN IF NOT EXISTS available_payable_poisha bigint;
ALTER TABLE profit_confirmations ADD COLUMN IF NOT EXISTS created_at timestamptz;

UPDATE profit_confirmations
SET status = COALESCE(status, 'approved')
WHERE status IS NULL;

UPDATE profit_confirmations
SET available_payable_poisha = COALESCE(available_payable_poisha, confirmed_profit_poisha)
WHERE available_payable_poisha IS NULL;

UPDATE profit_confirmations
SET created_at = COALESCE(created_at, approved_at, now())
WHERE created_at IS NULL;

ALTER TABLE profit_confirmations
  ALTER COLUMN status SET DEFAULT 'approved';

ALTER TABLE profit_confirmations
  ALTER COLUMN created_at SET DEFAULT now();

-- Status check (approved distributions only in Phase 5; draft/cancelled reserved)
ALTER TABLE profit_confirmations DROP CONSTRAINT IF EXISTS profit_confirmations_status_check;
ALTER TABLE profit_confirmations ADD CONSTRAINT profit_confirmations_status_check CHECK (
  status IN ('approved', 'cancelled')
);

-- Notes length soft guard via CHECK (nullable)
ALTER TABLE profit_confirmations DROP CONSTRAINT IF EXISTS profit_confirmations_notes_len_check;
ALTER TABLE profit_confirmations ADD CONSTRAINT profit_confirmations_notes_len_check CHECK (
  notes IS NULL OR char_length(notes) <= 2000
);
ALTER TABLE profit_confirmations DROP CONSTRAINT IF EXISTS profit_confirmations_declaration_note_len_check;
ALTER TABLE profit_confirmations ADD CONSTRAINT profit_confirmations_declaration_note_len_check CHECK (
  declaration_note IS NULL OR char_length(declaration_note) <= 2000
);

-- available_payable mirrors confirmed for approved rows; never negative
ALTER TABLE profit_confirmations DROP CONSTRAINT IF EXISTS profit_confirmations_available_payable_check;
ALTER TABLE profit_confirmations ADD CONSTRAINT profit_confirmations_available_payable_check CHECK (
  available_payable_poisha IS NULL OR available_payable_poisha >= 0
);

CREATE INDEX IF NOT EXISTS profit_confirmations_allocation_approved_idx
  ON profit_confirmations(allocation_id, approved_at DESC);
CREATE INDEX IF NOT EXISTS profit_confirmations_status_idx
  ON profit_confirmations(status);
CREATE INDEX IF NOT EXISTS profit_confirmations_source_report_idx
  ON profit_confirmations(source_report_id)
  WHERE source_report_id IS NOT NULL;

-- Helpful allocation listing for admin declaration queue
CREATE INDEX IF NOT EXISTS allocations_status_activated_idx
  ON allocations(status, activated_at DESC);
CREATE INDEX IF NOT EXISTS allocations_project_status_idx
  ON allocations(project_id, status);

COMMIT;
