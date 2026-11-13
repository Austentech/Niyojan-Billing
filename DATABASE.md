# DATABASE — Niyojan Corporation

PostgreSQL, accessed exclusively through **Drizzle ORM over postgres.js** (`src/lib/db/index.ts`) with a single validated connection string (`DATABASE_URL`, pooled; `DATABASE_URL_UNPOOLED` optional for migrations). Schema code: `src/lib/db/schema.ts` · Migrations: `drizzle/`.

---

## 1. Schema overview

| Table | Rows | Purpose |
|---|---|---|
| `admin_accounts` | 1 (the administrator) | Sign-in identity: username, email, Argon2id `password_hash`, `credentials_source` (`env_bootstrap`→`database`), `last_login_at`, `password_updated_at` |
| `admin_sessions` | ~1 per active login | Opaque sessions: SHA-256 of the 256-bit cookie token (the raw token is NEVER stored), absolute + idle expiry, revocation, login device meta |
| `auth_otp_challenges` | 1 per issued code | HMAC-SHA256(code, OTP_SECRET) hash only, 5-min expiry, attempt counter, single-use `consumed_at` |
| `security_lockouts` | 1 (`id='GLOBAL'`) | Consecutive-failure counter + 24-hour lockout timestamps — the GLOBAL, device-independent, redeploy-proof lockout |
| `rate_limits` | 1 per action scope | Atomic fixed-window counters shared across all server instances |
| `auth_attempts` | append-only | Every credential/OTP attempt: type, outcome, admin, attempted username, validated IP, truncated UA |
| `security_audit_logs` | append-only | Significant security EVENTS (login success, lockout activation, password/email changes, firm/profile writes) with sanitized detail |
| `firms` | business entities | `firm_name`, `logo_url`, `website_url`, `holding_percentage numeric(5,2) 0–100`, `address`, `description` — the sole source of dashboard cards |
| `corporation_profile` | 1 (`id='CORPORATION'`) | Corporation name + logo — stored COMPLETELY SEPARATELY from authentication |
| `email_change_requests` | 1 per issued code | Verification-gated email changes: new address + HMAC code hash, expiry, attempts, consumed |

**Conventions everywhere:** UUID primary keys (`gen_random_uuid()`), `timestamptz` in UTC (`created_at`, `updated_at` — the latter maintained by the `set_updated_at()` trigger, not by application code), foreign keys with `ON DELETE cascade|set null` as appropriate, CHECK constraints that mirror the application-level Zod validation (defense in depth), targeted indexes (`(admin_id, created_at desc)`, partial `WHERE consumed_at IS NULL`, …).

---

## 2. Relationships

```
admin_accounts 1 ──< admin_sessions          (cascade — deleting an admin kills sessions)
admin_accounts 1 ──< auth_otp_challenges      (cascade)
admin_accounts 1 ──< email_change_requests    (cascade)
admin_accounts 1 ──< auth_attempts            (set null — audit rows survive admin deletion)
admin_accounts 1 ──< security_audit_logs      (set null — event history survives)

firms                 — standalone (the anchor for FUTURE billing/GST/accounting modules)
corporation_profile   — standalone single row (branding, deliberately not in admin_accounts)
security_lockouts     — standalone single row (id = 'GLOBAL')
rate_limits           — standalone keyed counters
```

---

## 3. The atomic security engine (SECURITY DEFINER functions)

Created in `drizzle/0000_niyojan_core.sql`; EXECUTE revoked from PUBLIC in `drizzle/0001`. All pin their `search_path`. All are invoked from the application through parameterized calls.

| Function | Atomicity guarantee |
|---|---|
| `auth_register_failure()` | Single UPSERT increments the counter → the 4th consecutive failure sets `locked_until = now()+24h`. Concurrent requests can never race past the threshold; a lockout, once active, is neither extended nor reset by further failures. |
| `auth_register_success()` | Complete (OTP-verified) login resets the counter; deliberately never touches `locked_until`. |
| `auth_lockout_state()` | Read of the global lockout state (is_locked, deadline, counter). |
| `auth_consume_otp(challenge, admin, code_hash)` | `FOR UPDATE` row lock serializes concurrent verifications: single-use, expiry, ≤`max_attempts` wrong tries; racing duplicate submissions observe `already_used`; the first correct code wins. |
| `auth_invalidate_pending_otps(admin)` | Issuing a new code instantly retires every previous unconsumed one. |
| `auth_check_rate_limit(key, limit, window)` | One UPSERT increments-or-resets the fixed window — race-free across all server instances; returns `allowed` + `retry_after_seconds`. |
| `account_consume_email_change(admin, code_hash)` | `FOR UPDATE` on the latest pending request; verifies the code AND swaps `admin_accounts.email` in ONE transaction — an address can never activate without full verification. |
| `account_invalidate_pending_email_changes(admin)` | New request retires previous ones. |
| `auth_cleanup_auth_data(...)` | Operations housekeeping: purges expired sessions, consumed/expired challenges, old audit rows (safe to schedule via pg_cron). |

---

## 4. Migration instructions

```bash
bun run db:generate    # developer: diff src/lib/db/schema.ts into a new drizzle/NNNN_*.sql
bun run db:migrate     # release: apply pending migrations in order (exactly once)
bun run db:check       # validate migration consistency
```

- Migrations read `DATABASE_URL_UNPOOLED` (preferred, direct connection) falling back to `DATABASE_URL`.
- Each migration is plain SQL — review it, commit it, let the journal track it. **Never** use `drizzle-kit push` against production (that bypasses versioning).
- The committed migrations contain no destructive statements; they are safe to re-run (each applies once, tracked in `drizzle.__drizzle_migrations`).

---

## 5. Backup & restore

- **Backup:** provider tooling (Neon PITR/branch export, Lakebase per docs) or scheduled `pg_dump "$DATABASE_URL" > niyojan-$(date +%F).sql`.
- **Restore:** `psql "$DATABASE_URL" < backup.sql` into a fresh database → repoint `DATABASE_URL` → redeploy.
- **Rollback of a migration:** restore the pre-migration backup or write a compensating forward migration (preferred; no down-migrations exist by policy).

---

## 6. Operational notes

- **Connection limits:** the app keeps a small bounded pool per serverless instance and disables prepared statements — compatible with transaction-mode poolers (Neon `-pooler`) by design.
- **Never logged:** connection strings, credentials, hashes, codes, session tokens — the application's DB layer maps every error to sanitized `SystemAuthError`s carrying only operation names and PostgreSQL error codes.
- **Timestamps:** stored UTC; rendered in the reader's local timezone by the `LocalTime` client component (deterministic UTC on first paint — no hydration mismatch).
- **`last_login_at` semantics:** updated ONLY after a complete OTP-verified login; a credentials-correct/OTP-failed attempt never touches it (asserted by the integration tests).
