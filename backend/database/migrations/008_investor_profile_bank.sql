BEGIN;

-- Extend investor_profiles with Phase 3 identity / nominee / KYC fields (idempotent).
ALTER TABLE investor_profiles
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS nationality text,
  ADD COLUMN IF NOT EXISTS occupation text,
  ADD COLUMN IF NOT EXISTS present_address text,
  ADD COLUMN IF NOT EXISTS permanent_address text,
  ADD COLUMN IF NOT EXISTS nominee_name text,
  ADD COLUMN IF NOT EXISTS nominee_relationship text,
  ADD COLUMN IF NOT EXISTS nominee_phone text,
  ADD COLUMN IF NOT EXISTS kyc_status text;

-- Backfill kyc_status from legacy verification_status when missing.
UPDATE investor_profiles
SET kyc_status = CASE
  WHEN verification_status IN ('verified') THEN 'approved'
  WHEN verification_status IN ('under_review', 'pending') THEN 'pending'
  WHEN verification_status IN ('rejected', 'expired') THEN 'rejected'
  ELSE 'not_started'
END
WHERE kyc_status IS NULL;

ALTER TABLE investor_profiles
  ALTER COLUMN kyc_status SET DEFAULT 'not_started';

UPDATE investor_profiles SET kyc_status = 'not_started' WHERE kyc_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'investor_profiles_kyc_status_check'
  ) THEN
    ALTER TABLE investor_profiles
      ADD CONSTRAINT investor_profiles_kyc_status_check
      CHECK (kyc_status IN ('not_started', 'pending', 'approved', 'rejected'));
  END IF;
END $$;

-- Optional phone verification timestamp on users (display only in Phase 3).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

COMMENT ON COLUMN users.phone_verified_at IS 'Set when mobile/OTP phone verification completes; null until verified';

-- Encrypted bank / MFS payout destination (one row per investor).
CREATE TABLE IF NOT EXISTS investor_bank_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_holder_name text NOT NULL,
  bank_name text NOT NULL,
  branch_name text NOT NULL,
  account_type text NOT NULL,
  account_number_ciphertext text NOT NULL,
  account_number_last4 text NOT NULL,
  routing_number_ciphertext text NOT NULL,
  routing_number_last4 text NOT NULL,
  mfs_type text,
  mfs_number_ciphertext text,
  mfs_number_last4 text,
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verified_at timestamptz,
  verified_by uuid REFERENCES users(id),
  verification_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT investor_bank_account_type_check
    CHECK (account_type IN ('savings', 'current', 'other')),
  CONSTRAINT investor_bank_account_last4_check
    CHECK (account_number_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT investor_bank_routing_last4_check
    CHECK (routing_number_last4 ~ '^[0-9A-Za-z]{2,8}$'),
  CONSTRAINT investor_bank_mfs_consistency_check
    CHECK (
      (mfs_type IS NULL AND mfs_number_ciphertext IS NULL AND mfs_number_last4 IS NULL)
      OR (mfs_type IS NOT NULL AND mfs_number_ciphertext IS NOT NULL AND mfs_number_last4 IS NOT NULL)
    )
);

DROP TRIGGER IF EXISTS investor_bank_accounts_set_updated_at ON investor_bank_accounts;
CREATE TRIGGER investor_bank_accounts_set_updated_at
BEFORE UPDATE ON investor_bank_accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS investor_bank_accounts_status_idx
  ON investor_bank_accounts (verification_status);

COMMIT;
