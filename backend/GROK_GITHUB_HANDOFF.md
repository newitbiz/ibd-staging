# Grok Bot GitHub Handoff

## Objective

Turn this PostgreSQL-ready release into a private GitHub repository and finish the production authentication and infrastructure layers without changing the approved business rules.

## Repository setup

1. Create a private repository named `grow-bangladesh-platform`.
2. Place this folder at `grow-bangladesh-backend/`.
3. Place the Flutter package at `grow-bangladesh-mobile/`.
4. Generate and commit `package-lock.json` using the approved Node.js LTS version.
5. Protect the default branch and require passing tests before merge.
6. Never commit `.env`, signing keys, identity documents, or payment secrets.

## Commands

```bash
cd grow-bangladesh-backend
cp .env.example .env
npm install
npm test
docker compose up --build
```

Verify:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/projects
```

## Rules that must not change

- BDT amounts are integer poisha.
- Rates are integer basis points.
- One default unit invests BDT 8,500 and has a separately disclosed 15% administration fee.
- Estimated profit is never confirmed or withdrawable profit.
- Only a verified payment activates units.
- Payment verification and allocation occur in one PostgreSQL transaction.
- Project, application, and payment rows are locked before allocation.
- Published project terms are versioned.
- Audit events are append-only.
- Referral rewards are fixed, single-level, and never funded from investment principal.
- No user-to-user value transfer is introduced.

## Work still required before public testing

1. Add password/OTP authentication and rotating refresh tokens.
2. Replace the development `x-user-id` identity header with verified JWT claims.
3. Enforce roles server-side for every endpoint.
4. Add request validation and global rate limiting.
5. Add private object storage with signed upload/download URLs.
6. Implement KYC/KYB provider adapters.
7. Implement project review, milestone, reporting, confirmed-profit, exit, referral, notification, and payout endpoints.
8. Add SSLCommerz sandbox initiation, IPN validation, and transaction validation.
9. Add approved bKash integration only after merchant onboarding.
10. Add integration tests against a disposable PostgreSQL database.
11. Add CI for tests, migrations, secret scanning, and container scanning.
12. Configure staging before production.

## Definition of deployment-ready

- `npm test` and PostgreSQL integration tests pass.
- Migrations run from a clean database and are repeatable.
- Restarting the API does not lose data.
- Two simultaneous approvals cannot oversubscribe a project.
- Duplicate payment callbacks do not duplicate an allocation.
- Investors cannot access another investor's records.
- Project owners cannot access investor identity or banking details.
- Finance staff cannot edit published commercial terms.
- Backups restore successfully to a fresh database.
- All live credentials exist only in protected hosting secrets.


## Phase 2 progress

Completed on branch `phase-2-auth-postgres`:

1. Password/OTP authentication and rotating refresh tokens
2. JWT claims replace production use of `x-user-id`
3. Server-side role enforcement on protected endpoints
4. PostgreSQL integration tests against disposable databases
5. CI for unit tests, migrations, secret scanning, and Docker build

Still required before public testing: rate limiting, private object storage, KYC/KYB adapters, remaining milestone/reporting/payout endpoints, SSLCommerz sandbox, approved bKash onboarding, and staging secrets in the host.
