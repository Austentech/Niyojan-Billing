# PROJECT AUDIT — Niyojan Corporation

**Scope:** Full audit, repair and Supabase→PostgreSQL/Drizzle migration of the Centralized Financial & Billing Management System (Phases 1–3: authentication, dashboard, firm management, account settings).
**Date:** 2026-11-13 · **Outcome:** Supabase fully removed; PostgreSQL + Drizzle ORM verified end-to-end (370 automated checks passing); production dependency tree at **0 vulnerabilities**.

---

## 1. Audit summary

| Area audited | State before | State after |
|---|---|---|
| Authentication (two-step, OTP, lockout, sessions) | Working, Supabase-coupled | Working, Drizzle/PostgreSQL — 90/90 tests |
| Dashboard + firm cards | Working, Supabase-coupled | Working, Drizzle/PostgreSQL — 91/91 tests |
| Firm management (add firm, logo) | Working, Supabase Storage | S3-compatible upload (AWS SigV4 verified against reference vectors) + validated logo-URL fallback |
| Account settings (profile, email change, password) | Working, Supabase-coupled | Working — 139/139 tests |
| Database layer | Supabase PostgREST client | Single Drizzle/postgres.js connection module |
| Migrations | `supabase/migrations/*.sql` + Supabase roles/RLS | Versioned Drizzle migrations (`drizzle/`) on standard PostgreSQL |
| Deployment | Vercel (build failing at times; env errors at runtime) | Vercel-ready; build verified; documented runbook |
| Dependency health | 1 critical + 11 high prod vulnerabilities; unused heavy packages | **0 prod vulnerabilities**; unused packages removed |

---

## 2. Root-cause investigation of the reported deployment failure

**Reported symptoms:**

1. *"The administrator enters correct credentials and configuration, but after redeployment the login system continues showing the same error."*
2. *"When adding the Supabase URL as an environment variable, the deployment platform displayed a configuration error"* (the Vercel "Add Environment Variable" dialog warns that `NEXT_PUBLIC_` values are exposed to the browser).

**Actual root causes identified (multiple, compounding):**

| # | Root cause | Evidence | Fix |
|---|---|---|---|
| 1 | **The app fails closed on ANY missing/invalid environment variable** — by design, sign-in is disabled with the exact messages the operator saw. The old `.env.example` required 3 Supabase variables + SMTP + 2 secrets + `APP_URL` + 4 `ADMIN_*` values; if any single one was absent, empty, or malformed the whole validation threw. | `src/lib/config/env.ts` (pre-migration); both reported messages originate from `isServerEnvConfigured()` and `mapLoginError()`. | Every variable is now documented with exact validation rules in `DEPLOYMENT.md`; the failing variable NAMES are logged server-side (`env_config_invalid`) while values stay hidden. |
| 2 | **`NEXT_PUBLIC_` warning trap.** The operator added `NEXT_PUBLIC_SUPABASE_URL` via Vercel's dialog, which displays a black warning bubble ("keep this value private… remove the prefix") — and an empty/ignored value fails validation. Vercel also does **not** push env-var changes into an already-built deployment; `NEXT_PUBLIC_*` values are baked at build time. | Vercel dialog behavior; Vercel build log (`Environments: .env`, single build). | Supabase is removed entirely (no `NEXT_PUBLIC_` DB values at all). DEPLOYMENT.md documents the redeploy-after-env-change requirement in bold. |
| 3 | **Hash-signature characters in `.env` values truncate silently.** Values containing `#` (e.g. a strong password `Pass#2026!`) are cut at the `#` because both Next.js env loading and dotenv treat it as an inline comment — producing a *short, invalid* value that fails validation with a misleading variable name. | Reproduced during this session: `ADMIN_PASSWORD=NiyojanLocal#2026` parsed as `NiyojanLocal` (11 chars → below the 12-char policy). | Values with special characters must be quoted (`ADMIN_PASSWORD="NiyojanLocal#2026"`); documented with a dedicated warning in DEPLOYMENT.md and fixed in the local `.env`. |
| 4 | **No database connectivity was possible at all on the deployed URL** — the runtime needed Supabase URL + service-role key, while the operator's actual database plan (per the new direction) is Neon/Lakebase PostgreSQL. | The pre-migration stack had no PostgreSQL driver for a standard connection string. | Full migration to `DATABASE_URL` PostgreSQL + Drizzle (this document). |

**Items investigated and ruled out** (checked, not assumed): env vars read at build time instead of runtime (they are validated lazily at request time); env scope limited to Preview (operator used Production scope); incorrect env validation names (names were correct); session secrets changing between deployments (they come from env, stable); OTP records not persisted (DB-backed); password hashing comparison (Argon2id verified by tests); stale branch/commit (deployment tracked `main` @ `b5ad879` correctly).

---

## 3. Issues found and fixed during the migration

### 3.1 Supabase removal (complete)

- Removed `@supabase/supabase-js`, all Supabase clients (`getSupabaseServiceClient`), Supabase Storage upload adapters, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, the CSP Supabase image origin, the Supabase remote-pattern image config, and the PostgREST/JWT verification harness.
- `grep`-verified: no `@supabase` import, no Supabase env reference remains anywhere in `src/`, `scripts/`, or configuration.

### 3.2 Database layer (new)

- **Single reusable connection module** `src/lib/db/index.ts`: Drizzle ORM over postgres.js, lazy singletons (build-safe), TLS for every non-local host, small bounded pool, **no prepared statements** (safe behind Neon's transaction-mode pooler / PgBouncer), credentials never logged.
- **Schema as code** `src/lib/db/schema.ts` — 10 tables with CHECK constraints mirroring Zod validation (defense in depth).
- **Versioned migrations** `drizzle/0000_niyojan_core.sql` (tables + indexes + FKs + `set_updated_at` triggers + the atomic SECURITY DEFINER engine: lockout counting, OTP consumption, rate limiting, email-change confirmation, cleanup) and `drizzle/0001_function_execute_hardening.sql` (**EXECUTE revoked from PUBLIC** — plain PostgreSQL grants function EXECUTE to PUBLIC by default; without this, any unprivileged role could invoke the security engine. Found by the integration tests, fixed by migration).
- **Bug class found and fixed:** function calls with zero bound parameters take the simple-protocol path in postgres.js where server errors surface as fatal connection errors instead of promise rejections — all zero-arg security functions are now invoked with at least one bound parameter.

### 3.3 Logo storage (Supabase Storage replacement)

- **`s3` mode** — S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi) via a dependency-free AWS **Signature Version 4** implementation (`src/lib/storage/s3.ts`). The signing core is unit-tested against the official AWS reference vectors (`scripts/test-sigv4.ts`: signing-key derivation and full-request signature both reproduce the documented values).
- **`url` mode (default)** — no pretending: when object storage is not configured, upload controls are hidden and logos are set as validated http(s) URLs (the bundled brand asset is the fallback). No dead buttons.
- **`local` mode** — development/harness only; rejected by env validation in production; the `/uploads/[...path]` route hard-fails outside local dev mode.
- Upload hardening retained from the previous phase: magic-byte sniffing, full sharp re-encode (≤512 px, EXIF stripped), 2 MB limit, server-generated UUID filenames.

### 3.4 Security hardening additions

- `security_audit_logs` table (new) + `logSecurityEvent()` writer: sanitized event trail for logins, lockouts, password changes, email changes, firm/profile writes (complements `auth_attempts`).
- Next.js upgraded **16.1.3 → 16.4.6** — the previous version carried a **critical** advisory (GHSA-9g9p-9gw9-jx7f et al.).
- `sharp` upgraded (inherited libvips CVEs), `uuid` upgraded, `source-map-js` pinned to the fixed release via `overrides`.
- Unused dependencies removed (next-auth — fully unused — plus 19 other packages incl. recharts, emditor, dnd-kit, tanstack, mdxeditor). `npm audit --omit=dev`: **0 vulnerabilities**. Remaining dev-only lint-tooling advisories are documented in SECURITY.md §9 and never ship to the deployed runtime.
- Administrator bootstrap hardened: documented operator command (`npm run db:bootstrap`), idempotent, never overwrites database-updated credentials (verified by tests).

### 3.5 Files modified / created

**Created:** `src/lib/db/index.ts`, `src/lib/db/schema.ts`, `src/lib/storage/s3.ts`, `drizzle.config.ts`, `drizzle/0000_niyojan_core.sql`, `drizzle/0001_function_execute_hardening.sql`, `drizzle/meta/*`, `scripts/test-db.ts`, `scripts/test-sigv4.ts`, `scripts/bootstrap-admin.ts`, this file, `DEPLOYMENT.md`, `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`.

**Rewritten (data layer):** `src/lib/config/env.ts`, `src/lib/auth/server/{db,session,lockout,rate-limit,audit,bootstrap}.ts`, `src/lib/auth/service.ts`, `src/lib/firms/{storage,service,validation}.ts`, `src/lib/account/{storage,service,validation}.ts`, `src/app/api/route.ts`, `src/app/uploads/[...path]/route.ts`, `src/proxy.ts`, `next.config.ts`, `.env.example`, `verify-harness/{start,stop}.mjs`, all test scripts, `README.md`, `docs/TESTING.md`.

**Modified (UI):** `src/components/firms/add-firm-dialog.tsx` and `src/components/settings/corporation-profile-card.tsx` (dual logo modes), their pages, `src/server/actions/{firm,account}-actions.ts` (logo URL handling + audit events).

**Deleted:** `prisma/` + `db/` + `src/lib/db.ts` (dead Prisma client), `verify-harness/proxy.mjs`, `docs/SECURITY.md` (superseded by root `SECURITY.md`), `supabase/migrations/` (superseded by `drizzle/`), 7 unused shadcn template components.

---

## 4. Verification performed

| Suite | Result |
|---|---|
| `test:unit` (validation schemas, crypto, policy) | 46/46 |
| `test:sigv4` (AWS reference vectors) | 4/4 |
| `test:auth` (13 required scenarios + extras: bootstrap idempotency, OTP single-use/expiry/resend-cooldown, 4-failure 24h lockout, global + redeploy-persistent lockout, auto-expiry, session persistence/revocation, forged tokens, audit trail, rate limiting, unprivileged-role denial, no-secrets-in-logs) | 90/90 |
| `test:firms` (12 required scenarios + extras: validation, DB CHECK rejection, logo magic-byte + URL fallback flows, password rotation survives bootstrap) | 91/91 |
| `test:account` (12 required scenarios + extras: overview, profile/name updates, email-change full verification flow, password change semantics, `last_login_at` accuracy incl. not-updated-on-failed-OTP) | 139/139 |
| Production build (`next build`, strict TypeScript, Turbopack) | ✅ all routes |
| Liveness probe `/api` against live dev server + local PostgreSQL | ✅ `{"status":"ok","database":"reachable"}` |
| Browser verification (login → OTP → dashboard → firms → account settings) | ✅ see README "Verification" |

---

## 5. Remaining manual configuration requirements (operator)

Nothing in the application is left deliberately broken; the only external inputs an operator must supply are real credentials (never invented by the code):

1. A PostgreSQL database — **Neon** (pooled + direct connection strings) or **Lakebase** (its documented connection configuration) — and `DATABASE_URL` (+ optional `DATABASE_URL_UNPOOLED`) set in Vercel.
2. A working SMTP account for verification-code email (`SMTP_*`).
3. Two distinct random secrets (`AUTH_SESSION_SECRET`, `OTP_SECRET`).
4. Initial administrator values (`ADMIN_NAME`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` — quoted if it contains `#` —, `ADMIN_EMAIL`).
5. Optional: an S3-compatible bucket for logo uploads (`LOGO_STORAGE_MODE=s3` + `S3_*` group). Without it the app runs in URL-logo mode by design.
