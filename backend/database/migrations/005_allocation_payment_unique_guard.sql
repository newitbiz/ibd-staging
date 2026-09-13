-- Idempotent guard: one allocation row per payment (already enforced by schema UNIQUE).
-- Safe to re-run on staging databases that already have the constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'allocations_payment_id_key'
       OR conname = 'allocations_payment_id_uidx'
  ) THEN
    ALTER TABLE allocations ADD CONSTRAINT allocations_payment_id_key UNIQUE (payment_id);
  END IF;
END $$;
