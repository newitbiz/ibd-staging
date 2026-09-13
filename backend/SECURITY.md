# Security requirements

## Never commit

- `.env` files
- database passwords or connection strings
- authentication signing secrets
- payment provider secrets
- NID/passport images
- bank statements
- Android signing keys
- Apple certificates

## Production requirements

- Use verified JWT authentication. Never accept `x-user-id` as an identity source when `NODE_ENV=production`.
- Optional development identity header is gated behind explicit `ALLOW_DEV_USER_HEADER=true` and is rejected in production.
- Require multi-factor authentication for all administrator and finance accounts.
- Use a maker-checker workflow for manual payment verification, profit confirmation, exits, and payouts.
- Store identity and project documents in private object storage, not public URLs or PostgreSQL byte columns.
- Encrypt sensitive identity fields and retain only the minimum required data.
- Restrict database network access to the API service and approved administrators.
- Enable database backups and test restoration at least quarterly.
- Rotate secrets and revoke staff sessions after role changes.
- Rate-limit authentication, project submission, payment, and document endpoints.
- Add dependency, container, and source-code security scanning to CI.

## Authentication model (phase 2)

- Access tokens are short-lived HS256 JWTs signed with `JWT_SECRET`.
- Refresh tokens are opaque, stored hashed, rotated on every use, and family-revoked on reuse detection.
- OTP challenges are stored hashed with attempt limits.
- Password reset tokens are single-use and revoke all sessions on success.
- Server-side roles are enforced on every protected endpoint.

## Staging only

Do not place live payment credentials in this repository or in local compose files. Staging secrets belong in the hosting provider secret store.

## Field encryption (bank data)

- Account number, routing number, and MFS number are encrypted at rest with AES-256-GCM using `FIELD_ENCRYPTION_KEY` (or `BANK_DATA_KEY`) — a 32-byte key encoded as standard base64.
- API responses and audit logs expose only masked last4 values; never log plaintext bank numbers or the encryption key.
- Store the key only in Railway secrets / local `.staging_secrets/` (mode 600); never commit it.
