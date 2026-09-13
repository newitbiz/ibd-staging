BEGIN;

-- Investor feature pack: referral reward payout requests (display-only),
-- apply-to-shares ledger, support message threads, KYC change reason,
-- project-owner access requests. Additive / idempotent. Staging only.
-- NO wallet language. funds_moved always false on payout records.

-- ---------------------------------------------------------------------------
-- A) KYC change reason (after admin approved, edits need reason + re-review)
-- ---------------------------------------------------------------------------
ALTER TABLE investor_profiles ADD COLUMN IF NOT EXISTS change_reason text;
ALTER TABLE investor_profiles ADD COLUMN IF NOT EXISTS change_requested_at timestamptz;
ALTER TABLE investor_profiles ADD COLUMN IF NOT EXISTS previous_kyc_status text;

ALTER TABLE investor_profiles DROP CONSTRAINT IF EXISTS investor_profiles_change_reason_len_check;
ALTER TABLE investor_profiles ADD CONSTRAINT investor_profiles_change_reason_len_check CHECK (
  change_reason IS NULL OR (char_length(trim(change_reason)) >= 10 AND char_length(change_reason) <= 2000)
);

-- ---------------------------------------------------------------------------
-- B) Approved referral reward → display-only bank payout requests
--     (never a withdrawable wallet balance)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_reward_payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id uuid NOT NULL REFERENCES users(id),
  amount_poisha bigint NOT NULL CHECK (amount_poisha > 0),
  note text,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'under_review', 'approved', 'rejected', 'paid_recorded')),
  bank_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  paid_recorded_at timestamptz,
  paid_recorded_by uuid REFERENCES users(id),
  payout_reference text,
  payout_method text
    CHECK (payout_method IS NULL OR payout_method IN ('bank_transfer_record', 'cash_record', 'other_record')),
  funds_moved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_reward_payout_requests_note_len CHECK (
    note IS NULL OR char_length(note) <= 2000
  )
);

CREATE INDEX IF NOT EXISTS referral_reward_payout_requests_investor_idx
  ON referral_reward_payout_requests (investor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS referral_reward_payout_requests_status_idx
  ON referral_reward_payout_requests (status, created_at DESC);

COMMENT ON TABLE referral_reward_payout_requests IS
  'Display-only requests to pay Approved referral reward to investor bank on file. Not a wallet. funds_moved always false on staging.';

-- ---------------------------------------------------------------------------
-- C) Apply Approved referral reward toward a share application (not a wallet)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_reward_apply_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id uuid NOT NULL REFERENCES users(id),
  application_id uuid REFERENCES investment_applications(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  units integer NOT NULL CHECK (units > 0),
  amount_poisha bigint NOT NULL CHECK (amount_poisha > 0),
  unit_investment_poisha bigint NOT NULL CHECK (unit_investment_poisha > 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS referral_reward_apply_ledger_investor_idx
  ON referral_reward_apply_ledger (investor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS referral_reward_apply_ledger_application_idx
  ON referral_reward_apply_ledger (application_id);

COMMENT ON TABLE referral_reward_apply_ledger IS
  'Ledger of Approved referral reward applied toward share applications. Display/audit only — not a wallet balance.';

-- ---------------------------------------------------------------------------
-- D) Support message thread (extends legacy support_cases)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_by uuid NOT NULL REFERENCES users(id),
  project_id uuid REFERENCES projects(id),
  subject text NOT NULL,
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'waiting_user', 'resolved', 'closed')),
  assigned_to uuid REFERENCES users(id),
  resolution text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS support_cases_opened_by_idx
  ON support_cases (opened_by, opened_at DESC);
CREATE INDEX IF NOT EXISTS support_cases_status_idx
  ON support_cases (status, opened_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (char_length(trim(body)) >= 1 AND char_length(body) <= 4000),
  is_staff boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_messages_case_idx
  ON support_messages (case_id, created_at ASC);

-- ---------------------------------------------------------------------------
-- E) Investor → project_owner access request (dual-role path)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS investor_project_owner_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (char_length(trim(reason)) >= 10 AND char_length(reason) <= 2000),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investor_po_access_requests_investor_idx
  ON investor_project_owner_access_requests (investor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS investor_po_access_requests_status_idx
  ON investor_project_owner_access_requests (status, created_at DESC);

COMMIT;
