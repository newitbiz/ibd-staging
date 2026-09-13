BEGIN;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS paid_on date,
  ADD COLUMN IF NOT EXISTS submission_context jsonb,
  ADD COLUMN IF NOT EXISTS verification_context jsonb;

COMMENT ON COLUMN payments.paid_on IS 'Investor/staff-reported calendar date of the manual payment';
COMMENT ON COLUMN payments.submission_context IS 'IP/device context captured at manual payment submit';
COMMENT ON COLUMN payments.verification_context IS 'IP/device context captured at verify/activate';

COMMIT;
