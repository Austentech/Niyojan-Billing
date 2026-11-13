# ARCHITECTURE — Niyojan Corporation

**Centralized Financial & Billing Management System** · *Structural Growth. Trusted Control.*

---

## 1. Project structure

```
Niyojan-Billing/
├── drizzle/                          # VERSIONED migrations (SQL, applied once, in order)
│   ├── 0000_niyojan_core.sql         #   schema + triggers + atomic security functions
│   ├── 0001_function_execute_hardening.sql
│   └── meta/_journal.json            #   drizzle-kit migration journal
├── drizzle.config.ts                 # drizzle-kit config (generate / migrate / check)
├── src/
│   ├── app/                          # Next.js App Router routes
│   │   ├── page.tsx                  #   /            → administrator login (two-step)
│   │   ├── dashboard/page.tsx        #   /dashboard   → My Firms grid (server-rendered from DB)
│   │   ├── settings/page.tsx         #   /settings    → settings landing (redirects)
│   │   ├── settings/firms/page.tsx   #   /settings/firms     → firm management
│   │   ├── settings/account/page.tsx #   /settings/account    → account settings
│   │   ├── uploads/[...path]/route.ts#   local-dev logo serving only (fails closed in prod)
│   │   ├── api/route.ts              #   GET /api → liveness probe (env + DB reachability)
│   │   ├── layout.tsx / globals.css / error.tsx
│   │   └── proxy.ts (middleware)     #   security perimeter: fast-path redirect, CSRF seed,
│   │                                 #   CSP nonce + security headers
│   ├── components/
│   │   ├── auth/                     # login form, OTP screen, lockout screen, countdown
│   │   ├── dashboard/                # console header, profile menu
│   │   ├── firms/                    # firm cards, list, add-firm dialog, logo
│   │   ├── settings/                 # corporation profile card, password form, settings nav
│   │   ├── common/                   # PageHeader, StatCard, FieldRow, EmptyState, LocalTime
│   │   ├── brand/                    # official logo components
│   │   └── ui/                       # shadcn/ui primitives (trimmed to used set)
│   ├── server/actions/               # "use server" — the ONLY state-changing endpoints
│   │   ├── auth-actions.ts           #   login / verify-otp / resend / logout
│   │   ├── firm-actions.ts           #   createFirmAction
│   │   └── account-actions.ts        #   profile / email-change / password actions
│   ├── lib/
│   │   ├── db/                       # SINGLE database connection module
│   │   │   ├── index.ts              #   Drizzle over postgres.js (lazy, TLS, pooler-safe)
│   │   │   └── schema.ts             #   the 10 tables (source of truth for migrations)
│   │   ├── auth/                     # authentication domain
│   │   │   ├── service.ts            #     flow engine (submitCredentials / verifyOtp / resend)
│   │   │   ├── validation.ts         #     Zod schemas + password policy
│   │   │   ├── types.ts              #     shared row/state types, maskEmail()
│   │   │   └── server/               #     db access, bootstrap, session, cookies, otp,
│   │   │                             #     lockout, rate-limit, audit, email, request-guard
│   │   ├── firms/                    # firm domain (service, storage, validation, errors, types)
│   │   ├── account/                  # account-settings domain (service, storage, validation)
│   │   ├── config/env.ts             # THE environment contract (Zod, lazy, fail-closed)
│   │   ├── storage/                  # image-codec (sharp hardening), s3 (AWS SigV4 upload)
│   │   ├── constants.ts              # every policy constant (single source of truth)
│   │   └── utils.ts / format.ts
│   └── types/                        # client-visible action-state types (serialized safely)
├── scripts/                          # test suites + harness + bootstrap + env loader
├── verify-harness/                   # embedded local PostgreSQL (development only)
├── public/brand/                     # official logo assets
├── .env.example                      # annotated environment reference
└── DEPLOYMENT.md · ARCHITECTURE.md · DATABASE.md · SECURITY.md · PROJECT_AUDIT.md
```

---

## 2. Application architecture

**Rendering:** server components everywhere; `force-dynamic` on every authenticated page (session- and data-dependent). Client components only for interactive forms (login, OTP, firm dialog, profile/password forms) — all mutations through Server Actions, none through REST.

**Request lifecycle for a mutation (identical in every action):**

```
Browser ──(Server Action POST: csrf + fields)
  → assertTrustedMutation()      Origin vs Host/APP_URL + CSRF double-submit cookie
  → getSessionContext()           server-side session validation (cookie → token hash → DB row)
  → enforceRateLimit()            PostgreSQL atomic fixed-window counter (rate_limits)
  → Zod parse                     server-authoritative validation
  → service layer                 pure functions, explicit inputs (unit/integration-testable)
  → Drizzle / SQL function call   parameterized only
  → revalidatePath()              every surface that renders the touched data
  → safe client state             no ids, hashes, codes, paths or internal detail
```

**Failure philosophy:** fail closed. Unreachable limiter → request rejected. Undeliverable OTP email → challenge deleted. Unconfigured environment → sign-in disabled. Render-time DB outage → explicit error banner, never stale or fabricated data.

**Environment discipline:** `src/lib/config/env.ts` is the only reader of secrets; it validates lazily (never at build time), lists **variable names** only in errors, and is never imported from client code.

---

## 3. Authentication flow

```
STEP 1  /  (login page)
  POST loginAction
   ├─ lockout check (auth_lockout_state)         — DB, atomic, global
   ├─ ensureAdminBootstrapped()                  — idempotent, never overwrites
   ├─ admin lookup (parameterized) + Argon2id verify (dummy verify when unknown
   │   username — timing equalized, no user enumeration)
   ├─ failure → auth_register_failure()          — atomic counter; 4th → 24h lockout
   └─ success → issueOtpForAdmin()
        ├─ hourly OTP cap + 60 s resend cooldown (auth_check_rate_limit)
        ├─ auth_invalidate_pending_otps()        — previous codes die
        ├─ insert auth_otp_challenges (HMAC-SHA256(code, OTP_SECRET) ONLY)
        ├─ sendOtpEmail() — Nodemailer; failure deletes the challenge (fail closed)
        └─ set signed preauth cookie {cid, aid}+HMAC(AUTH_SESSION_SECRET), 10 min

STEP 2  OTP screen
  POST verifyOtpAction
   ├─ lockout check (fail closed)
   ├─ auth_consume_otp(challenge, admin, hash)   — FOR UPDATE row lock: single-use,
   │   5-minute expiry, ≤5 attempts, racing requests see already_used
   ├─ failure → auth_register_failure() (OTP failures count toward lockout)
   └─ verified → auth_register_success() (resets counter)
        ├─ createSession() → new 256-bit token; SHA-256(token) stored
        ├─ HttpOnly+SameSite=Lax+Secure cookie (8 h absolute, 60 min idle)
        └─ last_login_at = now (ONLY on complete OTP-verified login)

Logout   revokeSessionByToken() → revoked_at set → cookie cleared
```

**Global 24-hour lockout:** single `security_lockouts` row (`id='GLOBAL'`) — device-, browser-, cookie- and IP-independent; redeploy-safe; failed requests can neither extend nor reset it; only a complete success resets the counter. Recovery is an operator-only SQL command (documented) — no public endpoint exists.

---

## 4. Database design

PostgreSQL, accessed exclusively through `src/lib/db` (Drizzle ORM over postgres.js):

- **Connection:** lazy singleton; TLS for every non-local host; `prepare:false` + small pool → safe behind Neon's transaction-mode pooler and across serverless cold starts; `DATABASE_URL` (pooled) for runtime, `DATABASE_URL_UNPOOLED` (optional, direct) for migrations.
- **10 tables:** `admin_accounts`, `auth_attempts`, `security_audit_logs`, `auth_otp_challenges`, `admin_sessions`, `security_lockouts`, `rate_limits`, `firms`, `corporation_profile`, `email_change_requests` — UUID PKs, timestamptz (UTC) everywhere, FKs with correct ON DELETE behavior, CHECK constraints mirroring the Zod rules, targeted + partial indexes, `updated_at` maintained by a DB trigger.
- **Atomic security engine (SECURITY DEFINER, pinned search_path, EXECUTE revoked from PUBLIC):** `auth_register_failure/success`, `auth_consume_otp`, `auth_invalidate_pending_otps`, `auth_check_rate_limit`, `auth_lockout_state`, `account_consume_email_change`, `account_invalidate_pending_email_changes`, `auth_cleanup_auth_data`. Race-free by construction (single UPSERT / FOR UPDATE statements).

See `DATABASE.md` for column-level documentation and `src/lib/db/schema.ts` for the code definition.

---

## 5. Security architecture

| Layer | Mechanism |
|---|---|
| Transport | HSTS (prod), CSP with per-request nonce + strict-dynamic, nosniff, no-referrer, frame-ancestors none, permissions-policy lockdown |
| Injection | Drizzle parameterized statements only; identifiers whitelisted; no string concatenation of untrusted input anywhere |
| XSS | React safe rendering; no `dangerouslySetInnerHTML`; URLs validated http(s) before storage; images re-encoded server-side |
| CSRF | Origin/Host validation + HttpOnly double-submit CSRF cookie embedded as a hidden field in every form; SameSite=Lax cookies |
| Brute force | 4 consecutive failures → 24 h global lockout (DB-atomic); per-action rate limits (login 10/5 min, OTP issue 6/h, verify 12/5 min, firm create 12/h, profile 10/h, password 5/h, email-change flows) |
| Sessions | 256-bit random tokens; only SHA-256 hash stored; rotation on login; idle + absolute expiry server-side; revocation on logout/password change |
| Secrets | Env-only, name-only errors, never logged/serialized; two distinct HMAC keys |
| Audit | `auth_attempts` (every attempt) + `security_audit_logs` (significant events) — sanitized, append-only |
| Uploads | Magic-byte sniffing, sharp full re-encode (≤512 px, EXIF stripped, junk truncated), 2 MB cap, UUID filenames, S3-only in production |

Full detail, threat model and recovery procedures: `SECURITY.md`.

---

## 6. Future expansion strategy

The current schema is the stable spine for the planned financial modules — they will attach without rewriting anything that exists today:

- **Firm-scoped modules** (billing, invoices, GST, income/expenses, transactions, accounting, firm-wise reports) will reference `firms(id)` — a UUID FK anchor with indexes on `created_at`/`firm_name` already in place.
- **Multi-entry ledgers** follow the same pattern as `auth_otp_challenges`/`email_change_requests`: append-only rows + one atomic SECURITY DEFINER function per state transition.
- **Rate limiting and audit** are generic — new action scopes add one constant + one `key` prefix, no new infrastructure.
- **Logo storage** already proves the object-storage path (S3 SigV4) that document exports/attachments will reuse.
- **UI** keeps server-rendered pages + Server Actions; a new module is one route, one service module, one action file, one migration.

Nothing in the current scope will be rewritten: billing features will extend `firms`, not modify it.
