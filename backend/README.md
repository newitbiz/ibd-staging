# Invest in Bangladesh PostgreSQL Backend

Version 0.3 adds JWT authentication, rotating refresh tokens, OTP verification, password reset, server-side role enforcement, migrations for auth tables, integration tests, and CI. Financial rules from the MVP handoff are unchanged.

## Money and rates (immutable product rules)

- Money is stored as integer poisha (`100 poisha = BDT 1`).
- Rates are stored as integer basis points (`2,000 bps = 20%`).
- Default unit = BDT 8,500 (`850_000` poisha); administration fee 15% (`1500` bps) is separate.
- Estimated profit is never confirmed, earned, guaranteed, or withdrawable.
- Only an approved application may receive payment; only a verified payment activates/allocates units.
- Payment verification and allocation occur in one PostgreSQL transaction with row locks.
- No oversubscription; published terms are versioned/immutable for existing investors.
- Financial corrections use reversal records only; audit logs are append-only.
- Referral rewards are fixed, single-level, and never a percentage of principal. No peer-to-peer or stored-value transfers.

## Quick test without PostgreSQL

```bash
node --test test/*.test.js
node src/server.js
```

## Full local PostgreSQL test

```bash
docker compose up --build
```

API: `http://127.0.0.1:8080`

If API cannot reach Postgres on a restricted host, see `docs/local-docker-networking.md` for an untracked host-network override. Do not commit that override.

Stop without wiping data:

```bash
docker compose stop
```

## Manual local setup

```bash
cp .env.example .env
# set JWT_SECRET to >= 32 chars
node --env-file=.env scripts/migrate.js
node --env-file=.env scripts/seed.js
node --env-file=.env src/server.js
```

## Authentication

| Endpoint | Purpose |
|---|---|
| `POST /auth/register` | Create pending user; send email verification (no tokens) |
| `POST /auth/email/send-verification` | Send / re-issue email verification (generic response) |
| `POST /auth/email/verify-code` | Verify 6-digit email code; issue tokens |
| `GET /auth/email/verify?token=` | Verify one-time email link; issue tokens |
| `POST /auth/email/resend` | Resend email verification (invalidates prior; max 3/hour) |
| `POST /auth/otp/verify` | Secondary phone OTP (password reset / legacy) |
| `POST /auth/login` | Password login (pending → email verification) |
| `POST /auth/token/refresh` | Rotate refresh token |
| `POST /auth/logout` | Revoke session |
| `POST /auth/password/forgot` | Start reset |
| `POST /auth/password/reset` | Complete reset |
| `GET /auth/me` | Current user |
| `POST /auth/sessions/revoke` | Staff session revocation |

`x-user-id` is accepted only when `NODE_ENV != production` **and** `ALLOW_DEV_USER_HEADER=true`.

## Roles

`investor`, `project_owner`, `super_admin`, `finance_officer`, `project_reviewer`, `compliance_reviewer`, `support`, `auditor`

## Demonstration identities

Seed password must be set via `DEMO_SEED_PASSWORD` (12+ chars; never commit the value).

| Role | Email | UUID |
|---|---|---|
| Admin | admin@example.invalid | `00000000-0000-4000-8000-000000000001` |
| Project owner | owner@example.invalid | `00000000-0000-4000-8000-000000000002` |
| Investor | investor@example.invalid | `00000000-0000-4000-8000-000000000003` |

## Deployment / staging

`render.yaml` remains a staging blueprint only. Do not deploy production or attach live payment credentials from this phase.

## Private staging hardening

See `docs/staging-access.md` for Railway vars: SMTP_*, APP_PUBLIC_URL, ALLOW_OTP_PREVIEW, OTP_PREVIEW_ALLOWLIST, STAGING_ACCESS_REQUIRED, STAGING_INVITE_CODE, payment gateway flags, and in-memory auth rate limits.
