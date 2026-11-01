# Niyojan Corporation — Centralized Financial & Billing Management System

**Structural Growth. Trusted Control.**

Internal administrator console for centrally managing the independent firms registered
under the Niyojan Corporation structure.

---

## Current phase — Phase 2: Dashboard & Firm Management ✅ (on top of Phase 1 ✅)

The repository now contains the **complete, tested authentication system** AND the
**dashboard / firm-management experience**:

**Phase 1 — Secure Admin Authentication**

- Two-step administrator sign-in (username + password → emailed 8-character code)
- Global 24-hour login lockout after 4 consecutive failed attempts (server-side,
  database-atomic, device-independent)
- Opaque database-backed sessions with HttpOnly cookies and server-side validation
- Supabase PostgreSQL schema with Row Level Security and SECURITY DEFINER functions
- Argon2id password hashing with a controlled environment bootstrap
- Hardened request pipeline: CSP with per-request nonces, CSRF double-submit tokens,
  origin validation, distributed rate limiting, security headers

**Phase 2 — Dashboard & Firm Management**

- `/dashboard` — premium corporate console: logo + name header, administrator
  greeting from the account configuration, notification placeholder, profile menu,
  settings navigation, logout
- **My Firms** — every firm rendered from the database as a professional business
  card in a responsive grid (mobile 1 / tablet 2 / desktop 4 per row, rows continue
  automatically), holding-percentage badge, website links opening in a new tab with
  `noopener noreferrer`, initials fallback for firms without a logo, and a
  professional empty state ("No firms added yet.") with an Add Your First Firm CTA
- `/settings/firms` — **Manage Firms**: the existing-firm list plus the Add New Firm
  modal (name, optional logo upload, optional website, holding percentage with two
  decimals, address, optional details) with client AND server validation
- Firm logos: stored in a dedicated Supabase Storage bucket in production (public
  URLs, bucket-level type/size limits) with full upload hardening — magic-byte
  sniffing, sharp re-encode (metadata stripped, 512 px cap), server-generated UUID
  filenames; a local adapter serves the identical pipeline for the dev harness
- `/settings/account` — Account Settings: administrator profile from the database
  and the Argon2id password change (flips the credential source to the database,
  revokes all other sessions)
- Write operations are session-guarded, CSRF-protected and rate-limited;
  `firms` is RLS-locked with zero policies for anon/authenticated
- Future-ready: every firm carries a stable UUID so billing / GST / accounting /
  transaction / reporting modules can attach per firm in their own phases

**Deliberately out of scope until their own phases** (per the project specification):
per-firm dashboards, billing, invoices, GST, accounting, transactions, expenses and
reporting modules. Firm cards are structured for future navigation and inform the
administrator accordingly — nothing is faked.

---

## Technology stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack, Server Actions) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS 4 + shadcn/ui primitives, brand tokens from the design system |
| Database | Supabase PostgreSQL (server-side service role only — the browser never talks to Supabase) |
| Logo storage | Supabase Storage bucket `firm-logos` (public read, service-role writes) |
| Auth | Custom two-step authentication (no third-party auth provider) |
| Password hashing | Argon2id (`@node-rs/argon2`, OWASP-aligned parameters) |
| Email | Nodemailer over SMTP |
| Validation | Zod (client mirrors, server authoritative) |

## Project structure

```
src/
  app/
    page.tsx                        # "/" — login interface (or lockout screen while locked)
    dashboard/page.tsx              # the main dashboard (My Firms grid)
    settings/layout.tsx             # protected settings shell + navigation
    settings/account/page.tsx       # Account Settings (profile + password change)
    settings/firms/page.tsx         # Firm Management (list + Add New Firm)
    uploads/[...path]/route.ts      # local-mode logo serving (dev harness only)
    api/route.ts                    # liveness probe (no data exposure)
  proxy.ts                          # edge proxy: CSP nonce, security headers, CSRF seed,
                                    # fast-path route protection
  instrumentation.ts                # dev-only: auto-starts the verification harness
  components/
    auth/                           # login form, OTP form, lockout screen
    brand/                          # official logo lockups
    dashboard/                      # console header, profile menu
    firms/                          # firm card, grid, list, logo tile, Add-Firm dialog
    settings/                       # settings navigation, password change form
    common/                         # page header, empty state, field rows
  lib/
    config/env.ts                   # lazy, fail-fast environment contract (Zod)
    constants.ts                    # brand + security + firm policy constants
    auth/                           # Phase 1 flow engine + server modules
    firms/                          # Phase 2: types, validation, errors, storage,
                                    # service (database-driven firm data)
  server/actions/
    auth-actions.ts                 # the ONLY state-changing auth endpoints
    firm-actions.ts                 # the ONLY state-changing firm endpoint
    account-actions.ts              # Account Settings password change
  types/                            # client-visible action states (safe shapes)
supabase/migrations/
  0001_auth_core.sql               # auth tables + RLS + atomic functions
  0002_firms.sql                   # firms table + RLS + firm-logos bucket
scripts/                            # test suites (unit + 13-scenario auth +
                                    # 12-scenario firm management)
verify-harness/                     # local PostgreSQL + PostgREST stack
                                    # (mirrors Supabase; auto-starts with dev)
docs/                               # SECURITY.md, TESTING.md
```

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run, in order, the entire contents of every file in
   `supabase/migrations/` (`0001_auth_core.sql`, `0002_firms.sql`) — both are
   idempotent and safe to re-run. `0002` also creates the public `firm-logos`
   Storage bucket with type/size limits.
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

> On Linux x64 the dev server also auto-starts the bundled verification
> harness (real PostgreSQL + PostgREST on 127.0.0.1) when `.env` points at
> it — see `docs/TESTING.md`. On other platforms, or when `.env` points at a
> real Supabase project, nothing extra happens.

Sign in at `/` with the administrator username and password, then enter the
8-character code from the email. After the two-step verification you land on
`/dashboard` (My Firms); add firms through **Firm Management** in Settings.

### 5. Deploy (Vercel)

1. Import the repository.
2. Add every variable from `.env.example` in **Project → Settings → Environment
   Variables** (Production + Preview) — keep `FIRM_LOGO_STORAGE_MODE=supabase`.
3. `APP_URL` must be the final canonical origin (e.g. `https://admin.example.com`).
4. Deploy. `npm run build` produces the standalone output; no other configuration
   is required.

## Testing

```bash
npx tsx scripts/test-unit.ts    # cryptography & validation (no database)
npx tsx scripts/test-auth.ts    # full 13-scenario Phase 1 matrix (90 checks)
npx tsx scripts/test-firms.ts   # full 12-scenario Phase 2 matrix (91 checks)
```

The integration suites need a database. Point them at a **staging** Supabase
project (or the bundled local harness — see `docs/TESTING.md`), enable
`SMTP_DEV_CAPTURE=true`, then run. They cover every scenario in the Phase 1 and
Phase 2 test matrices, including lockout activation/expiry, single-use OTPs,
resend cooldowns, session revocation, unauthorized route access, upload
hardening and RLS blocking.

## Documentation

- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, security controls, the
  global-lockout trade-offs, Phase 2 upload hardening, operational procedures.
- [`docs/TESTING.md`](docs/TESTING.md) — test matrices, local harness, manual checks.
- [`.env.example`](.env.example) — annotated environment reference (including the
  `FIRM_LOGO_STORAGE_MODE` storage adapter switch).
