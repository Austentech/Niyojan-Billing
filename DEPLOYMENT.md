# DEPLOYMENT GUIDE — Niyojan Corporation

**Centralized Financial & Billing Management System** · *Structural Growth. Trusted Control.*

This guide is written for someone who has deployed a website before but is not a database infrastructure expert. Every command is copy-pasteable, every credential shown is a **fake placeholder**, and every "gotcha" that has actually bitten this project is called out explicitly.

---

## 14.1 Project Overview

**What this is:** an internal, single-administrator web console that centrally manages the financial operations of multiple independent firms. Current scope: administrator authentication (username + password + email OTP), global security lockout, dashboard with a database-driven firm list, firm management, account settings, and production deployment. Billing, invoicing, GST, expenses, transactions and accounting are deliberately **not** implemented yet — the schema is future-ready for them.

**Technologies:**

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router) + React 19 + TypeScript (strict) |
| Styling | Tailwind CSS 4 + shadcn/ui + Lucide icons |
| Database | PostgreSQL (Neon or Databricks Lakebase — any standard PostgreSQL) |
| ORM | Drizzle ORM + drizzle-kit migrations (postgres.js driver) |
| Email | Nodemailer over SMTP |
| Validation | Zod (client + server) |
| Auth | Custom two-step administrator authentication (Argon2id) |
| Hosting | Vercel (Node.js runtime) |

**Architecture in one paragraph:** the browser never talks to the database or object storage. Every page is server-rendered; every mutation flows through a Server Action that (1) validates the session server-side, (2) checks Origin + CSRF token, (3) applies a PostgreSQL-backed rate limit, (4) validates input with Zod, and (5) writes through Drizzle parameterized queries. Authentication is two-step (credentials → 8-character email OTP), sessions are opaque HttpOnly cookies backed by a `admin_sessions` table, and the global 24-hour lockout counter lives in the database — so redeployments can never reset or lose security state.

**Authentication workflow:** login form → credentials verified server-side (Argon2id, timing-equalized) → OTP code emailed → code verified atomically in the database (single-use, 5-minute expiry) → session cookie issued. Four consecutive failed attempts (credential **or** OTP) trigger a 24-hour global lockout.

**Email workflow:** Nodemailer → your SMTP provider → the administrator's registered email. Every login sends a code; undeliverable code means failed login (never silently "successful").

**Database-provider compatibility:** the application uses one standard `postgres://` connection string. Anything that speaks PostgreSQL works; provider-specific guidance below covers **Neon** and **Lakebase**.

**Hosting requirements:** Vercel account + Node.js runtime (default) — no edge runtime, no Docker.

---

## 14.2 Prerequisites

| Requirement | Version / notes | Official docs |
|---|---|---|
| Node.js | 20+ (22 recommended) | https://nodejs.org |
| Bun (runtime used by the repo scripts) OR npm | Bun 1.x — `bun install`, `bun run` | https://bun.sh |
| Git | any recent | https://git-scm.com |
| GitHub repository | push access to `main` | https://github.com |
| Vercel account | free tier works | https://vercel.com/docs |
| PostgreSQL database | **Neon** or **Lakebase** | https://neon.tech/docs · https://docs.databricks.com/lakebase/ |
| SMTP provider | any authenticated SMTP (SES, Postmark, Resend, Gmail app-password, …) | — |
| Domain (optional) | for a custom origin + `APP_URL` | — |

---

## 14.3 Database Setup

### 14.3.1 Create the database

- **Neon:** sign in → *Create project* → pick a region near your users → the dashboard shows **connection strings**. You get a **pooled** string (host contains `-pooler`) and a **direct** string.
- **Lakebase:** create the PostgreSQL instance per its console; collect the connection string, username, password, and note its documented SSL/auth requirements. **Lakebase is not the same product as Neon** — use only the connection details its own console provides.

### 14.3.2 Understand pooled vs unpooled connections

| String | Use for | Why |
|---|---|---|
| **Pooled** (`DATABASE_URL`) — Neon's `-pooler` host | Application runtime | Survives serverless instance churn; the app disables prepared statements so transaction-mode poolers work. |
| **Direct / unpooled** (`DATABASE_URL_UNPOOLED`) — optional | Migrations | Migrations DDL on a direct connection avoids pooler quirks. If you don't set it, migrations reuse `DATABASE_URL` — on Neon, prefer setting it. |

### 14.3.3 Example connection strings (ALL FAKE)

```
DATABASE_URL=postgresql://niyojan_app:p%40ssw0rd%21@ep-cool-name-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
DATABASE_URL_UNPOOLED=postgresql://niyojan_app:p%40ssw0rd%21@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

### 14.3.4 URL-encode special characters in the password (IMPORTANT)

Everything in the password that is not `[A-Za-z0-9]` **must be percent-encoded** inside the URL:

| Character | Encode as |
|---|---|
| `@` | `%40` |
| `#` | `%23` |
| `:` | `%3A` |
| `/` | `%2F` |
| `!` | `%21` |
| `%` | `%25` |

`p@ss:w0rd!` → `p%40ss%3Aw0rd%21`. A wrong encoding produces "authentication failed" errors that look like a wrong password.

**Never confuse the connection string with the dashboard URL.** `https://console.neon.tech/project/...` is a web page — it is NOT the database connection string. The connection string always starts with `postgres://` or `postgresql://`.

### 14.3.5 SSL

- Neon **requires TLS**: its connection strings already include `?sslmode=require` — keep it. The application additionally enables TLS automatically for every non-localhost host, so nothing to configure.
- Lakebase: use the SSL mode its documentation specifies (typically `sslmode=require`).
- Local PostgreSQL: no SSL — the app auto-detects `localhost`/`127.0.0.1` (or `?sslmode=disable`).

### 14.3.6 Database user & permissions

Create a dedicated application user (least privilege — do not use the provider's superuser):

```sql
create role niyojan_app login password 'REPLACE_WITH_STRONG_PASSWORD';
grant usage on schema public to niyojan_app;
-- after migrations run (they create the objects as the migrating user):
grant select, insert, update, delete on all tables in schema public to niyojan_app;
grant usage, select on all sequences in schema public to niyojan_app;
alter default privileges in schema public grant select, insert, update, delete on tables to niyojan_app;
```

The application needs **no** superuser rights, **no** `pg_read_file`, nothing beyond normal table/function usage. Migrations and the operator recovery commands use the unpooled connection with a role that owns the schema (or the provider's owner role).

### 14.3.7 Test the connection

```bash
# From your machine, with psql installed:
psql "postgresql://niyojan_app:p%40ssw0rd%21@ep-cool-name-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require" -c "select version();"
```

A version banner = connectivity confirmed. (No psql? The application's own probe works too — see §14.7 step 12.)

### 14.3.8 Apply Drizzle migrations

```bash
bun install
bun run db:migrate        # applies drizzle/*.sql in order, exactly once
```

The command reads `DATABASE_URL_UNPOOLED` (falls back to `DATABASE_URL`) from your environment or `.env`.

### 14.3.9 Verify the tables

```bash
psql "$DATABASE_URL" -c "\dt"          # expect: admin_accounts, admin_sessions, auth_attempts,
                                       # auth_otp_challenges, corporation_profile, email_change_requests,
                                       # firms, rate_limits, security_audit_logs, security_lockouts
psql "$DATABASE_URL" -c "select auth_lockout_state();"   # expect {"is_locked":false,...}
```

---

## 14.4 SMTP Setup

Every login emails an 8-character code. Any authenticated SMTP mailbox works.

| Variable | Example (fake) | Notes |
|---|---|---|
| `SMTP_HOST` | `smtp.resend.com` / `email-smtp.us-east-1.amazonaws.com` | your provider's relay host |
| `SMTP_PORT` | `587` | 587 STARTTLS (typical) or `465` |
| `SMTP_SECURE` | `false` | `true` ONLY for port 465 (implicit TLS) |
| `SMTP_USER` | `resend` / SMTP username | may be empty for open relays (not recommended) |
| `SMTP_PASSWORD` | `re_9x2ReplaceMe` | SMTP key / app password |
| `SMTP_FROM` | `auth@yourdomain.com` | a **verified sender identity** on the provider |

**Complete example (Resend SMTP):**

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=resend
SMTP_PASSWORD=re_ReplaceWithYourSmtpKey
SMTP_FROM=Niyojan Corporation <auth@yourdomain.com>
```

`SMTP_FROM` accepts a plain address (`auth@yourdomain.com`) or the display-name form above.

**Test delivery:** after deploying, sign in once and confirm the code email arrives. In development set `SMTP_DEV_CAPTURE=true` — emails are written to `.dev-outbox/*.eml` instead of being sent (this never activates in production).

---

## 14.5 Environment Variables — complete reference

> ⚠️ **Three Vercel traps, read first:**
> 1. **Changing variables does NOT update a running deployment.** You must **Redeploy** after every change for it to take effect.
> 2. **Scope matters.** Variables saved with only *Preview* scope are invisible to your Production deployment. Add them with the **Production** (and Preview, if desired) boxes checked.
> 3. **A successful build does NOT mean a working database.** The build never connects to Postgres (by design); connectivity is only exercised at runtime and via the `/api` probe.

| Variable | Purpose | Required | Example format | Where to obtain it | Secret |
|---|---|---|---|---|---|
| `APP_URL` | Canonical origin for origin validation | ✅ | `https://niyojan.vercel.app` | your Vercel URL / custom domain | No |
| `ADMIN_NAME` | Bootstrap display name | ✅ | `Deepak Khurana` | you choose | No |
| `ADMIN_USERNAME` | Bootstrap sign-in name (3–64, `a-z0-9._-`) | ✅ | `deepak` | you choose | No |
| `ADMIN_PASSWORD` | Bootstrap password (12–128, upper+lower+digit+symbol) | ✅ | `"Change#Me7Today!"` | you choose | **YES** |
| `ADMIN_EMAIL` | Where OTP codes are emailed | ✅ | `admin@example.com` | your mailbox | No |
| `DATABASE_URL` | Pooled PostgreSQL connection string | ✅ | `postgresql://user:p%40ss@host/db?sslmode=require` | Neon (pooled) / Lakebase console | **YES** |
| `DATABASE_URL_UNPOOLED` | Direct connection for migrations | optional | same format, non-pooler host | Neon (direct) / Lakebase | **YES** |
| `SMTP_HOST` | SMTP relay host | ✅ | `smtp.resend.com` | SMTP provider | No |
| `SMTP_PORT` | SMTP port | ✅ | `587` | SMTP provider | No |
| `SMTP_SECURE` | `true` only for port 465 | optional (`false`) | `false` | SMTP provider | No |
| `SMTP_USER` | SMTP login | provider-dependent | `resend` | SMTP provider | No |
| `SMTP_PASSWORD` | SMTP password/key | provider-dependent | `re_ReplaceMe` | SMTP provider | **YES** |
| `SMTP_FROM` | Verified sender address | ✅ | `auth@yourdomain.com` | SMTP provider | No |
| `AUTH_SESSION_SECRET` | HMAC key for pre-OTP cookie (≥32 chars) | ✅ | `openssl rand -base64 48` | you generate | **YES** |
| `OTP_SECRET` | HMAC key for OTP codes (≥32 chars, **must differ**) | ✅ | `openssl rand -base64 48` | you generate | **YES** |
| `LOGO_STORAGE_MODE` | `url` (default) / `s3` / `local`(dev only) | optional | `s3` | you choose | No |
| `S3_ENDPOINT` | Custom S3 endpoint (R2/B2/MinIO) | s3 mode | `https://<acct>.r2.cloudflarestorage.com` | storage provider | No |
| `S3_REGION` | Bucket region | s3 mode | `ap-south-1` | storage provider | No |
| `S3_BUCKET` | Bucket name | s3 mode | `niyojan-logos` | storage provider | No |
| `S3_ACCESS_KEY_ID` | Storage access key | s3 mode | — | storage provider | **YES** |
| `S3_SECRET_ACCESS_KEY` | Storage secret key | s3 mode | — | storage provider | **YES** |
| `S3_PUBLIC_BASE_URL` | Public URL base for logos | optional | `https://cdn.yourdomain.com` | storage provider | No |

**Rules enforced by the application** (validation fails closed — sign-in is disabled with `Server configuration is incomplete` when anything is off): no `NEXT_PUBLIC_` prefix on secrets; `AUTH_SESSION_SECRET` ≠ `OTP_SECRET`; `LOGO_STORAGE_MODE=s3` requires the S3 group; `LOGO_STORAGE_MODE=local` is rejected in production; `DATABASE_URL` must start with `postgres://` or `postgresql://`.

**Generate the two secrets (they must differ):**

```bash
openssl rand -base64 48    # -> AUTH_SESSION_SECRET
openssl rand -base64 48    # -> OTP_SECRET
```

**Value-quoting warning:** values containing `#` are truncated silently (treated as comments) — wrap them in double quotes: `ADMIN_PASSWORD="Change#Me7Today!"`.

See `.env.example` in the repository for the annotated template.

---

## 14.6 Local Development

```bash
# 1. Clone
git clone https://github.com/Austentech/Niyojan-Billing.git
cd Niyojan-Billing

# 2. Install
bun install            # or: npm install

# 3. Configure
cp .env.example .env  # then fill in real values for YOUR database + SMTP

# 4. (schema-first) generate a migration if you changed src/lib/db/schema.ts
bun run db:generate    # creates drizzle/XXXX_*.sql — review it, commit it

# 5. Apply migrations
bun run db:migrate

# 6. Bootstrap the administrator (optional — the first sign-in also does it)
bun run db:bootstrap

# 7. Start the dev server
bun run dev            # http://localhost:3000

# 8. Run the tests (needs the local harness + SMTP_DEV_CAPTURE=true)
bun run harness:start  # local PostgreSQL on 127.0.0.1:5433 (embedded binaries)
bun run test:unit && bun run test:auth && bun run test:firms && bun run test:account
```

**Local troubleshooting:** `DATABASE_URL is not defined` → your `.env` line is missing or the value got truncated at a `#` (quote it). `authentication failed` → percent-encode the password (§14.3.4). `relation "admin_accounts" does not exist` → run `bun run db:migrate`. Tests `crashed: connect ECONNREFUSED 127.0.0.1:5433` → `bun run harness:start`.

---

## 14.7 Vercel Deployment — step by step

1. **Push** the project to GitHub (`main` branch, root of the repo — do not nest it in a subfolder).
2. In Vercel: **Add New → Project → Import** the GitHub repository.
3. **Framework preset:** *Next.js* (auto-detected). **Runtime:** Node.js (default — no change needed).
4. **Root Directory:** `./` (the repository root — where `package.json` lives).
5. **Build settings:** leave default (install → build). The repo's build command is `next build` (+ standalone asset copy); Vercel's Next.js preset handles it. Do not set custom output overrides.
6. **Environment Variables:** add every ✅ variable from §14.5 — paste RAW values, no quotes around the whole entry in the Vercel dialog (quote only within values when the value itself contains `#` or spaces). Check **Production** (and Preview if you want preview builds to work).
7. **Deploy** — the build must complete green.
8. **Apply database migrations** (from your own machine, once per release):
   ```bash
   DATABASE_URL_UNPOOLED="postgresql://...direct..." \
   DATABASE_URL="postgresql://...pooled..." \
   bun run db:migrate
   ```
   Do this BEFORE the first login. Migrations are versioned and safe to re-run (each applies exactly once).
9. **Bootstrap the administrator securely:**
   ```bash
   DATABASE_URL="postgresql://..." bun run db:bootstrap
   ```
   Or simply sign in once — the first sign-in attempt bootstraps idempotently from the `ADMIN_*` variables.
10. **Verify the production deployment:** open `https://<your-app>.vercel.app/api` — expect `{"status":"ok","database":"reachable"}`. Then sign in: credentials → code email → dashboard.
11. **Custom domain (optional):** Vercel → Settings → Domains → add domain → follow DNS instructions → update `APP_URL` to the final origin → **Redeploy** (see trap #1).
12. **Redeploying after env changes:** Deployments → latest → ⋯ menu → **Redeploy**. Without this, changed variables have no effect.

---

## 14.8 Database Migration Commands

Commands that actually exist in `package.json`:

| Command | What it does | Run where |
|---|---|---|
| `bun run db:generate` | Diffs `src/lib/db/schema.ts` → new SQL file in `drizzle/` | Local only (developer workflow) |
| `bun run db:migrate` | Applies pending `drizzle/*.sql` in order, exactly once | Local or release pipeline (against `DATABASE_URL_UNPOOLED`/`DATABASE_URL`) |
| `bun run db:check` | Validates migration consistency | Local |
| `bun run db:bootstrap` | Idempotent administrator creation from `ADMIN_*` | Anywhere with DB access |
| `bun run db:studio` | Drizzle Studio (read/browse your data) | Local |

**Never** run `drizzle-kit push` in production — schema changes only through the version-controlled `drizzle/` files. Migrations never auto-drop or auto-recreate production tables (no destructive statements exist in the committed migrations).

---

## 14.9 Initial Administrator Setup

- **How the account is created:** on the very first bootstrap (explicit `db:bootstrap`, or the first sign-in attempt), one row is inserted into `admin_accounts` from `ADMIN_NAME/USERNAME/PASSWORD/EMAIL`, the password is Argon2id-hashed immediately, and `credentials_source` is set to `env_bootstrap`.
- **How the variables are used:** only for that first creation. After that, the database row is authoritative — changing `ADMIN_*` later has **no effect**.
- **Bootstrap command:** `bun run db:bootstrap` (idempotent; safe to re-run; never overwrites an existing row).
- **Verify initial login:** sign in with the username + the bootstrap password; expect the OTP email at `ADMIN_EMAIL`; enter the code; dashboard loads.
- **Password changes persist:** change it in *Settings → Account → Change password*. `credentials_source` flips to `database`, every other session is revoked, and future redeploys/bootstraps cannot roll it back (verified by the test suite).
- **Redeployment effects:** none — the credential lives in PostgreSQL, not in the build or memory.

---

## 14.10 Troubleshooting Guide

Format: cause → identify → fix → verify.

| Problem | Possible cause | Identify | Fix | Verify |
|---|---|---|---|---|
| "Server configuration is incomplete" banner | Any env var missing/invalid | Vercel → Logs → search `env_config_invalid` (lists variable NAMES only) | Fix the named variables, **Redeploy** | Banner gone; `/api` returns `ok` |
| Env change had no effect | Deployment not rebuilt | Variable edited recently | Redeploy the deployment | New value in effect |
| Missing `DATABASE_URL` | Not added / wrong scope | Vercel → Settings → Env Vars | Add with Production scope; redeploy | `/api` = ok |
| Invalid connection string | Not `postgres://`, or dashboard URL pasted | String starts with `https://console…` | Copy the real connection string from the DB console | `psql … -c "select 1"` |
| Database authentication failed | Password not URL-encoded | Postgres error `28P01` in logs | Percent-encode special chars (§14.3.4) | Sign-in works |
| SSL error | TLS not negotiated / forced | `SSL connection required` errors | Keep `?sslmode=require` on remote hosts | `select 1` succeeds |
| Database timeout | Pooled string used for long migrations / network | `connection timed out` | Use `DATABASE_URL_UNPOOLED` for migrations | `db:migrate` completes |
| Too many connections | Unpooled string used at runtime | Neon dashboard spikes | Use the POOLED string for `DATABASE_URL` | Dashboard settles |
| Missing tables | Migrations never ran | `relation "firms" does not exist` | `bun run db:migrate` | `\dt` shows 10 tables |
| Migration failure | Network glitch mid-run | migrate exits non-zero | Re-run — each file applies atomically once | `db:migrate` → "applied successfully" |
| OTP email not received | SMTP wrong / not verified sender / spam | No `.eml`, provider bounce logs | Verify sender domain; check `SMTP_*`; check spam | Code email arrives |
| Incorrect OTP | Typo / earlier code | — | Use the newest email; resend waits 60 s | Code accepted |
| OTP expired | >5 minutes old | "code has expired" | Request a new code | Login completes |
| Login credentials rejected | CapsLock / changed password / pre-hash truncation | — | Type carefully; use the CURRENT password; quote `#` in `.env` | Credentials pass |
| Account globally locked | 4 consecutive failures | Dedicated lockout screen with countdown | Wait 24 h, or operator recovery (§14.12) | Lockout lifts automatically |
| Session invalid after deploy | Session expired/revoked (NOT a bug) | Redirect to login | Sign in again | Session persists 8 h |
| Vercel prod build error | Committed broken code | Build log | Fix locally (`bun run build`) before push | Green build |
| 500 Internal Server Error | DB unreachable / bug | Vercel logs `[auth]` / `[firm]` events | Fix DB connectivity; check logs | Page renders |
| Wrong application URL | `APP_URL` ≠ actual origin | Origin-blocked mutations | Set exact origin (no trailing slash); redeploy | Forms submit |
| Firm logo upload failure | Storage unconfigured or unreachable | UI shows URL field instead of upload (by design) | Set `LOGO_STORAGE_MODE=s3` + S3 group + public bucket; redeploy | Logo appears |

---

## 14.11 Security Checklist (production)

- [ ] All secrets live ONLY in Vercel Environment Variables (never in Git; `.env` is gitignored)
- [ ] `AUTH_SESSION_SECRET` ≠ `OTP_SECRET`, both ≥ 32 random chars
- [ ] `DATABASE_URL` uses a least-privilege application user (not the provider superuser)
- [ ] Database password percent-encoded; connection string not committed anywhere
- [ ] Migrations applied (`db:migrate`); `admin_accounts` has exactly one row
- [ ] `APP_URL` equals the real origin (no trailing slash)
- [ ] First login works end-to-end: credentials → OTP email → dashboard
- [ ] Custom domain behind HTTPS; HSTS header observed (`curl -I`)
- [ ] `/api` returns `{"status":"ok"}`
- [ ] Lockout verified (3 deliberate failures show the warning; never do the 4th in production)
- [ ] Object storage bucket (if used) is public-read for logos only; keys are server-side only
- [ ] Backups scheduled on the database provider

---

## 14.12 Backup and Recovery

- **Backup:** use the provider's tooling — Neon PITR / branch export; Lakebase per its docs; or `pg_dump "$DATABASE_URL" > backup.sql` on a schedule.
- **Restore:** `psql "$DATABASE_URL" < backup.sql` into a fresh database, then repoint `DATABASE_URL` and redeploy.
- **Migration rollback:** every migration is a plain SQL file in `drizzle/` — restore the pre-migration backup, or write a compensating forward migration (preferred). Nothing auto-drops production tables.
- **Administrator recovery (password lost):** operator shell only —
  ```sql
  -- with the OWNER/unpooled connection:
  update admin_accounts set is_active = true where username = '<username>';
  ```
  then use *Account Settings → Change password* after signing in with a reset hash — there is no public reset endpoint by design.
- **Lockout recovery (accidental 24h lock):** operator shell only —
  ```sql
  delete from security_lockouts where id = 'GLOBAL';
  delete from rate_limits where key like 'auth:%';
  ```
  (No public lockout-reset API exists, ever.)
- **Secret rotation:** set the new `AUTH_SESSION_SECRET`/`OTP_SECRET` in Vercel → redeploy → existing sessions/Otp hashes invalidate naturally (users just sign in again).
- **Session revocation (all devices):** `delete from admin_sessions;` or via a password change in Account Settings.

---

## 14.13 Production Verification (final checklist)

1. Deployed URL opens on the login page with the Niyojan brand.
2. `/api` → `{"status":"ok","database":"reachable"}`.
3. `db:migrate` output shows the current migrations applied.
4. Sign-in with the administrator credentials → OTP email arrives → code accepted → dashboard.
5. "My Firms" heading; responsive grid (4 / 2 / 1 columns) — empty state with *Add Your First Firm*.
6. Add a test firm → appears on dashboard and `/settings/firms`.
7. Account Settings shows the real last-login timestamp (local timezone).
8. Change the administrator password → success notice.
9. **Redeploy.**
10. New password still signs in; **old password fails**; the test firm and all settings persist; the lockout counter/audit history persist.
11. Remove the test firm (or keep it) — you are production-ready when step 10 passes.
