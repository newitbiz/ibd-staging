BEGIN;

-- Phase 6: Exit requests / Exit payment workflow fields.
-- Additive only — creates display-only Exit payment records (payouts.early_exit); never moves funds.

ALTER TABLE exit_requests ADD COLUMN IF NOT EXISTS deduction_poisha bigint;
ALTER TABLE exit_requests ADD COLUMN IF NOT EXISTS estimated_payable_poisha bigint;
ALTER TABLE exit_requests ADD COLUMN IF NOT EXISTS liquidity_note text;
ALTER TABLE exit_requests ADD COLUMN IF NOT EXISTS min_hold_days integer;
ALTER TABLE exit_requests ADD COLUMN IF NOT EXISTS hold_days_elapsed integer;
ALTER TABLE exit_requests ADD COLUMN IF NOT EXISTS payout_id uuid;
ALTER TABLE exit_requests ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE exit_requests
SET updated_at = COALESCE(updated_at, decided_at, requested_at, now())
WHERE updated_at IS NULL;

ALTER TABLE exit_requests
  ALTER COLUMN updated_at SET DEFAULT now();

-- Link optional Exit payment (payout) record
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'exit_requests_payout_id_fkey'
  ) THEN
    ALTER TABLE exit_requests
      ADD CONSTRAINT exit_requests_payout_id_fkey
      FOREIGN KEY (payout_id) REFERENCES payouts(id);
  END IF;
END $$;

ALTER TABLE exit_requests DROP CONSTRAINT IF EXISTS exit_requests_deduction_poisha_check;
ALTER TABLE exit_requests ADD CONSTRAINT exit_requests_deduction_poisha_check CHECK (
  deduction_poisha IS NULL OR deduction_poisha >= 0
);

ALTER TABLE exit_requests DROP CONSTRAINT IF EXISTS exit_requests_estimated_payable_poisha_check;
ALTER TABLE exit_requests ADD CONSTRAINT exit_requests_estimated_payable_poisha_check CHECK (
  estimated_payable_poisha IS NULL OR estimated_payable_poisha >= 0
);

ALTER TABLE exit_requests DROP CONSTRAINT IF EXISTS exit_requests_min_hold_days_check;
ALTER TABLE exit_requests ADD CONSTRAINT exit_requests_min_hold_days_check CHECK (
  min_hold_days IS NULL OR min_hold_days >= 0
);

ALTER TABLE exit_requests DROP CONSTRAINT IF EXISTS exit_requests_hold_days_elapsed_check;
ALTER TABLE exit_requests ADD CONSTRAINT exit_requests_hold_days_elapsed_check CHECK (
  hold_days_elapsed IS NULL OR hold_days_elapsed >= 0
);

ALTER TABLE exit_requests DROP CONSTRAINT IF EXISTS exit_requests_liquidity_note_len_check;
ALTER TABLE exit_requests ADD CONSTRAINT exit_requests_liquidity_note_len_check CHECK (
  liquidity_note IS NULL OR char_length(liquidity_note) <= 2000
);

ALTER TABLE exit_requests DROP CONSTRAINT IF EXISTS exit_requests_reason_len_check;
ALTER TABLE exit_requests ADD CONSTRAINT exit_requests_reason_len_check CHECK (
  reason IS NULL OR char_length(reason) <= 2000
);

ALTER TABLE exit_requests DROP CONSTRAINT IF EXISTS exit_requests_decision_note_len_check;
ALTER TABLE exit_requests ADD CONSTRAINT exit_requests_decision_note_len_check CHECK (
  decision_note IS NULL OR char_length(decision_note) <= 2000
);

-- At most one open exit request per allocation
CREATE UNIQUE INDEX IF NOT EXISTS exit_requests_one_open_per_allocation_idx
  ON exit_requests(allocation_id)
  WHERE status IN ('submitted', 'under_review', 'approved_waiting_liquidity', 'approved');

CREATE INDEX IF NOT EXISTS exit_requests_investor_requested_idx
  ON exit_requests(investor_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS exit_requests_status_requested_idx
  ON exit_requests(status, requested_at DESC);

CREATE INDEX IF NOT EXISTS exit_requests_allocation_idx
  ON exit_requests(allocation_id, requested_at DESC);

COMMIT;
