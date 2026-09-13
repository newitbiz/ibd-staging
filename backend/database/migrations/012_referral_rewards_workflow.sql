BEGIN;

-- Phase 7: Referral reward workflow (single-level, fixed BDT).
-- Additive only. Referral rewards are funded from platform marketing/admin revenue —
-- never from project investment principal. Display-only payout records; no live money movement.

-- Per-investor shareable referral code
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text;

CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_uidx
  ON users (referral_code)
  WHERE referral_code IS NOT NULL;

-- Platform key/value settings (fixed reward amount in poisha)
CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

INSERT INTO platform_settings(key, value_json)
VALUES ('referral_reward_poisha', '50000'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Referral reward workflow columns
ALTER TABLE referral_rewards ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE referral_rewards ADD COLUMN IF NOT EXISTS payout_id uuid;
ALTER TABLE referral_rewards ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE referral_rewards ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE referral_rewards ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE referral_rewards ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE referral_rewards ADD COLUMN IF NOT EXISTS decided_by uuid;

UPDATE referral_rewards
SET updated_at = COALESCE(updated_at, paid_at, eligible_at, created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE referral_rewards
  ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referral_rewards_payout_id_fkey'
  ) THEN
    ALTER TABLE referral_rewards
      ADD CONSTRAINT referral_rewards_payout_id_fkey
      FOREIGN KEY (payout_id) REFERENCES payouts(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referral_rewards_decided_by_fkey'
  ) THEN
    ALTER TABLE referral_rewards
      ADD CONSTRAINT referral_rewards_decided_by_fkey
      FOREIGN KEY (decided_by) REFERENCES users(id);
  END IF;
END $$;

ALTER TABLE referral_rewards DROP CONSTRAINT IF EXISTS referral_rewards_rejection_reason_len_check;
ALTER TABLE referral_rewards ADD CONSTRAINT referral_rewards_rejection_reason_len_check CHECK (
  rejection_reason IS NULL OR char_length(rejection_reason) <= 2000
);

-- Indexes for investor/admin queues
CREATE INDEX IF NOT EXISTS referrals_referrer_created_idx
  ON referrals(referrer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS referrals_code_idx
  ON referrals(referral_code);

CREATE INDEX IF NOT EXISTS referral_rewards_status_created_idx
  ON referral_rewards(status, created_at DESC);

CREATE INDEX IF NOT EXISTS referral_rewards_referral_idx
  ON referral_rewards(referral_id, created_at DESC);

COMMIT;
