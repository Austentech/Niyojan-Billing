# Niyojan Corporation — Centralized Financial & Billing Management System

**Structural Growth. Trusted Control.**

Internal administrator console for centrally managing the independent firms registered under the Niyojan Corporation structure.

> **Stack:** Next.js 16 (App Router) · TypeScript (strict) · Tailwind CSS 4 + shadcn/ui · **PostgreSQL (Neon / Lakebase) + Drizzle ORM** · Nodemailer SMTP · Zod · Argon2id · Vercel.
> Supabase has been fully removed — see `PROJECT_AUDIT.md` for the migration report and the root-cause analysis of the previous deployment failure.

---

## Implemented scope (Phases 1–3, all verified)

**Phase 1 — Secure Admin Authentication**

- Two-step administrator sign-in (username + password → emailed 8-character code)
- Global 24-hour login lockout after 4 consecutive failed attempts (database-atomic, device-independent, redeploy-proof)
- Opaque database-backed sessions (SHA-256-hashed tokens, HttpOnly cookies, idle + absolute expiry, server-side validation on every request)
- PostgreSQL schema via **Drizzle migrations** with SECURITY DEFINER atomic functions (lockout counting, OTP consumption, rate limiting)
- Argon2id password hashing with a controlled, idempotent environment bootstrap (`npm run db:bootstrap`)
- Hardened request pipeline: CSP with per-request nonces, CSRF double-submit tokens, origin validation, distributed rate limiting, security headers

**Phase 2 — Dashboard & Firm Management**

- `/dashboard` — corporate console header, greeting, profile menu, settings navigation, logout
- **My Firms** — every firm rendered from the database in a responsive grid (1/2/4 per row), holding badge, safe external links, initials fallback, professional empty state
- `/settings/firms` — Manage Firms list + Add New Firm modal (name, logo, website, holding %, address, details) with client AND server validation
- Logo storage: **S3-compatible object storage** (AWS SigV4, unit-verified against AWS reference vectors) or validated logo URLs when storage is unconfigured — never a dead button; uploads are magic-byte sniffed and sharp re-encoded

**Phase 3 — Account Settings (`/settings/account`)**

- Account overview (corporation identity, administrator fields, last successful login in the reader's timezone)
- Corporation profile (name, logo, display name — stored separately from authentication) with verification-gated email changes
- Password change: current-password proof, Argon2id re-hash, other sessions revoked, env bootstrap permanently retired

**Deliberately not implemented yet:** billing, invoicing, GST, expenses, transactions, accounting, reports. The schema is future-ready for all of them (`firms(id)` is the anchor).

---

## Documentation

| Document | Contents |
|---|---|
| `DEPLOYMENT.md` | Complete deployment guide — prerequisites, Neon/Lakebase setup, SMTP, every environment variable, Vercel step-by-step, troubleshooting matrix, security checklist, backup/recovery |
| `ARCHITECTURE.md` | Project structure, request lifecycle, authentication flow, database design, security architecture, expansion strategy |
| `DATABASE.md` | Schema, relationships, the atomic security engine, migration commands, backup/restore |
| `SECURITY.md` | Security implementation, rate limits, CSRF/XSS/SQLi protection, secret management, recovery procedures, dependency health |
| `PROJECT_AUDIT.md` | Full audit, root-cause analysis of the previous deployment failure, everything that changed in the Supabase → PostgreSQL/Drizzle migration |
| `docs/TESTING.md` | Test matrices and how to run them |

## Quick start (local)

```bash
bun install
cp .env.example .env          # fill in your DATABASE_URL, SMTP, secrets, ADMIN_*
bun run db:migrate            # apply drizzle/ migrations
bun run db:bootstrap          # optional — first sign-in also bootstraps
bun run dev                   # http://localhost:3000
```

Offline development (no external database needed): `bun run harness:start` runs an embedded local PostgreSQL on 127.0.0.1:5433, applies the migrations and writes the harness `.env` values.

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` / `build` / `start` | development / production build / standalone server |
| `bun run lint` | ESLint |
| `bun run db:generate` / `db:migrate` / `db:check` / `db:bootstrap` / `db:studio` | Drizzle migration workflow |
| `bun run harness:start` / `harness:stop` | local verification PostgreSQL (embedded binaries) |
| `bun run test:unit` / `test:auth` / `test:firms` / `test:account` / `test:sigv4` | the test suites |

## Verification (current state)

- Production build: ✅ strict TypeScript, all routes emitted
- Test suites: **unit 46/46 · SigV4 4/4 (AWS vectors) · auth 90/90 · firms 91/91 · account 139/139 — 370 checks passing** against a real PostgreSQL
- Runtime: `/api` liveness probe reports `{"status":"ok","database":"reachable"}`; full golden path (login → OTP → dashboard → settings → firms → account) browser-verified
- Dependency health: `npm audit --omit=dev` → **0 vulnerabilities** (Next.js 16.4.6)
