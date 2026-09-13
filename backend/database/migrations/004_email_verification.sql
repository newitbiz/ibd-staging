BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

COMMENT ON COLUMN users.email_verified_at IS 'Set when the user completes email verification; null until verified';

CREATE TABLE IF NOT EXISTS email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  code_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 100),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  invalidated_at timestamptz,
  created_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS email_verifications_user_idx
  ON email_verifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS email_verifications_active_idx
  ON email_verifications(user_id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

COMMIT;
