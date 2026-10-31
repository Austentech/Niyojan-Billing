# Niyojan Corporation — Centralized Financial & Billing Management System

**Structural Growth. Trusted Control.**

Internal administrator console for centrally managing the independent firms registered
under the Niyojan Corporation structure.

---

## Current phase — Phase 1: Secure Admin Authentication ✅

This repository currently contains the **complete, tested authentication system**:

- Two-step administrator sign-in (username + password → emailed 8-character code)
- Global 24-hour login lockout after 4 consecutive failed attempts (server-side,
  database-atomic, device-independent)
- Opaque database-backed sessions with HttpOnly cookies and server-side validation
- Supabase PostgreSQL schema with Row Level Security and SECURITY DEFINER functions
- Argon2id password hashing with a controlled environment bootstrap
- Hardened request pipeline: CSP with per-request nonces, CSRF double-submit tokens,
  origin validation, distributed rate limiting, security headers

**Deliberately out of scope until their own phases** (per the project specification):
the firm dashboard with the 4/2/1 responsive grid, firm management, account settings,
and all billing / invoice / GST / accounting / transactions / expenses / reporting
modules. The `/dashboard` and `/settings` routes are protected placeholders that
authenticate fully but render "reserved for Phase 2" content.

---

## Technology stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack, Server Actions) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS 4 + shadcn/ui primitives, brand tokens from the design system |
| Database | Supabase PostgreSQL (server-side service role only — the browser never talks to Supabase) |
| Auth | Custom two-step authentication (no third-party auth provider) |
| Password hashing | Argon2id (`@node-rs/argon2`, OWASP-aligned parameters) |
| Email | Nodemailer over SMTP |
| Validation | Zod (client mirrors, server authoritative) |

## Project structure

```
src/
  app/
    page.tsx              # "/" — login interface (or lockout screen while locked)
    dashboard/page.tsx    # protected console shell (Phase 2 placeholder)
    settings/page.tsx     # protected route (future account settings)
    api/route.ts          # liveness probe (no data exposure)
  proxy.ts                # edge proxy: CSP nonce, security headers, CSRF seed,
                          # fast-path route protection
  components/auth/        # login form, OTP form, lockout screen, password toggle
  components/brand/       # official logo lockups
  lib/
    config/env.ts         # lazy, fail-fast environment contract (Zod)
    constants.ts          # brand + security policy constants
    auth/
      service.ts          # the two-step flow engine (framework-independent)
      validation.ts       # shared Zod schemas + OTP normalization
      types.ts, errors.ts # shared types, error taxonomy, safe logging
      server/             # db, bootstrap, password, otp, lockout, rate-limit,
                          # session, cookies, email, request-guard, audit
  server/actions/auth-actions.ts   # the ONLY state-changing auth endpoints
supabase/migrations/0001_auth_core.sql   # tables + RLS + atomic functions
scripts/                  # test suites (unit + 13-scenario integration)
verify-harness/           # local PostgreSQL + PostgREST stack (staging tests)
docs/                     # SECURITY.md, TESTING.md
```

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run the entire contents of
   `supabase/migrations/0001_auth_core.sql` (idempotent — safe to re-run).
3. From **Project Settings → API**, copy the project URL, the anon publishable key
   and the service role key.

### 2. SMTP

Provision an authenticated mailbox (e.g. SES, Postmark, Resend SMTP). The
verification-code email is sent on every login. Use an explicit sender identity
your provider has verified.

### 3. Environment

```bash
cp .env.example .env
```

Fill in every variable (see `.env.example` for per-variable documentation) and
generate the two secrets:

```bash
openssl rand -base64 48   # -> AUTH_SESSION_SECRET
openssl rand -base64 48   # -> OTP_SECRET (must differ from AUTH_SESSION_SECRET)
```

The initial administrator is bootstrapped **once** from `ADMIN_NAME`,
`ADMIN_USERNAME`, `ADMIN_PASSWORD` and `ADMIN_EMAIL`. After the first startup the
database record is authoritative; changing these variables later has no effect
(see `docs/SECURITY.md §4`).

### 4. Install & run

```bash
bun install        # or npm install
bun run dev        # http://localhost:3000
```

Sign in at `/` with the administrator username and password, then enter the
8-character code from the email.

### 5. Deploy (Vercel)

1. Import the repository.
2. Add every variable from `.env.example` in **Project → Settings → Environment
   Variables** (Production + Preview).
3. `APP_URL` must be the final canonical origin (e.g. `https://admin.example.com`).
4. Deploy. `npm run build` produces the standalone output; no other configuration
   is required.

## Testing

```bash
npx tsx scripts/test-unit.ts    # cryptography & validation (no database)
npx tsx scripts/test-auth.ts    # full 13-scenario matrix against PostgreSQL
```

The integration suite needs a database. Point it at a **staging** Supabase project
(or the bundled local harness — see `docs/TESTING.md`), enable
`SMTP_DEV_CAPTURE=true`, then run. It covers every scenario in the Phase 1 test
matrix, including lockout activation/expiry, single-use OTPs, resend cooldowns,
session revocation and unauthorized route access.

## Documentation

- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, security controls, the
  global-lockout trade-offs, operational procedures.
- [`docs/TESTING.md`](docs/TESTING.md) — test matrix, local harness, manual checks.
- [`.env.example`](.env.example) — annotated environment reference.
