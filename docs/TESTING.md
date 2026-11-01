# Testing Documentation — Phase 1 Authentication & Phase 2 Firm Management

## Automated suites

| Suite | Command | Needs database | Coverage |
| --- | --- | --- | --- |
| Unit | `npx tsx scripts/test-unit.ts` | No | OTP generation/hashing, normalization, Zod schemas, pre-auth cookie signing (tamper/expiry), Argon2id roundtrip, email masking, env validation hygiene |
| Integration (auth) | `npx tsx scripts/test-auth.ts` | Yes (staging or local harness) | The full 13-scenario Phase 1 matrix + extras |
| Integration (firms) | `npx tsx scripts/test-firms.ts` | Yes (staging or local harness) | The full 12-scenario Phase 2 matrix + extras |

Run the unit suite first (it also sanity-checks the `.env` contract), then the
integration suites.

## The 13 required scenarios → automated assertions

All 13 are asserted by `scripts/test-auth.ts` (90 checks total):

| # | Required scenario | Assertions in the suite |
| --- | --- | --- |
| 1 | Correct username and password | `submitCredentials` → `otp_required`; email written to outbox; code is 8 chars from the alphabet; challenge row stores only the HMAC hash; ~5-minute expiry |
| 2 | Incorrect username and password | Both rejected with `invalid_credentials`; **identical message** for wrong-username vs wrong-password; counter shows 2 remaining |
| 3 | Correct OTP | `verifyOtp` → `verified`; session created; token validates; DB holds only the token hash; challenge consumed; failure counter reset |
| 4 | Incorrect OTP | `invalid`; challenge `attempts` burned; failure counter incremented |
| 5 | Expired OTP | Challenge forced into the past (ops) → correct code returns `expired` |
| 6 | Reused OTP | First use `verified`; second use of the same code `already_used` |
| 7 | OTP resend | Immediate resend blocked by 60 s cooldown; after cooldown a new code is issued; previous code invalidated; new code verifies |
| 8 | Four consecutive failed attempts | Failures 1-3 rejected; **4th activates** the lockout (~24 h remaining, counter = 4) |
| 9 | Global lockout across browsers/devices | A **fresh, independent client** reads the lockout from the database; correct credentials also rejected; failed requests cannot change the timer |
| 10 | Automatic expiration after 24 h | Deadline rewound → unlocked; a failure right after expiry re-locks (counter persists); full correct sign-in resets the counter and restores the budget |
| 11 | Session persistence | Token validates repeatedly; same session row; 8-hour absolute expiry |
| 12 | Logout | Session revoked in the database; token no longer validates; revocation persisted; double logout is a no-op |
| 13 | Unauthorized access to protected routes | No cookie / forged token / unknown-hash token → no session; HTTP-level: `GET /dashboard` and `GET /settings` → 307 to `/`; `GET /` → 200 login |

**Extras** (also asserted): bootstrap idempotency and never-overwrite semantics,
atomic rate-limit windows (4th call denied with retry-after), audit trail content,
RLS blocking the anon key (tables *and* function execution), and log hygiene
(neither the OTP code nor the password ever appear in captured console output).

## The Phase 2 required scenarios → automated assertions

All 12 are asserted by `scripts/test-firms.ts` (91 checks total), which runs the
same service/storage layers the application uses against the real PostgreSQL +
PostgREST stack, plus HTTP-level checks against the dev server with a genuine
session cookie:

| # | Required scenario | Assertions in the suite |
| --- | --- | --- |
| 1 | Dashboard with zero firms | `listFirms` → empty; authenticated `GET /dashboard` renders the "No firms added yet." empty state with supporting text and the Add Your First Firm CTA |
| 2 | Dashboard with one firm | Create → list → 1 row with correct name/percentage; dashboard HTML includes the firm; empty state gone |
| 3 | Dashboard with multiple firms | 8 firms registered; registration order preserved; unique UUID per firm; all render on the dashboard |
| 4 | Responsive grid at all breakpoints | Served CSS grid is `grid-cols-1` / `md:grid-cols-2` / `xl:grid-cols-4`; additionally browser-verified at 375 px / 768 px / 1440 px (computed columns 1/2/4, zero horizontal overflow) |
| 5 | Add firm with valid data | `createFirm` → `created`; database row matches name/percentage/website; UUID id; NULLs for empty optionals |
| 6 | Add firm with invalid data | Empty/short name, empty/short address, over-length description each rejected with a field error; nothing written to the database |
| 7 | Add firm without a logo | Saves with `logo_url` NULL (initials fallback renders) |
| 8 | Add firm with a logo | Real PNG generated and uploaded; magic-byte sniffing recognized; file stored re-encoded with metadata stripped; firm row carries the URL; served with `image/png` + `nosniff`; spoofed `.png` text, oversized and truncated payloads all rejected; traversal/non-UUID/unrelated paths on `/uploads` refused |
| 9 | Invalid website URL | Plain text, `ftp://`, `javascript:` and scheme-less URLs rejected |
| 10 | Invalid holding percentage | `101`, `-5`, `12.345`, `abc`, empty rejected; boundary `0`/`100` and two-decimal values accepted |
| 11 | Dashboard refresh after adding | New firm immediately in `listFirms` and in a freshly-rendered authenticated `/dashboard` and `/settings/firms` response (server revalidation) |
| 12 | Unauthorized access to firm management | No cookie / forged cookie → `/dashboard`, `/settings/firms`, `/settings/account` all 307 to `/`; no/forged token → no session context; anon Supabase key cannot read or insert `firms`; write rate limiter denies past the window with retry-after |

**Extras** (also asserted): database CHECK constraints reject out-of-range
holding even when the app layer is bypassed; XSS payloads in firm names render
escaped (no raw HTML); the Account-Settings password change produces a valid
Argon2id hash, invalidates the old credential, flips `credentials_source` to
`database`, and survives bootstrap re-runs without being rolled back.

## Running the integration suites

### Option A — staging Supabase project (recommended)

1. Create a **dedicated staging** Supabase project (never production — the suites
   reset lockout/rate-limit state and consume OTP budget).
2. Apply every file in `supabase/migrations/` in the SQL editor, in filename
   order (0001, 0002, …).
3. Point `.env` at it and set `SMTP_DEV_CAPTURE=true` so codes are written to
   `.dev-outbox/` instead of being emailed.
4. `npx tsx scripts/test-auth.ts && npx tsx scripts/test-firms.ts`
   (the firms suite also needs `FIRM_LOGO_STORAGE_MODE=local` when running
   against the harness — against a real Supabase project keep `supabase`.)

### Option B — bundled local harness (no Supabase account)

The harness runs **real PostgreSQL and real PostgREST** binaries locally, mirroring
Supabase's architecture (same migration SQL, same roles — `authenticator`, `anon`,
`authenticated`, `service_role` — same JWT-authenticated REST shape), so the app
code and tests run unmodified:

```bash
node verify-harness/start.mjs     # Postgres :5433, PostgREST :5434, /rest/v1 proxy :5435
                                  # (writes freshly minted keys into .env; also
                                  #  auto-started with `bun run dev` in this repo)
npx tsx scripts/test-unit.ts      # 46 checks
npx tsx scripts/test-auth.ts      # 90 checks (Phase 1)
npx tsx scripts/test-firms.ts     # 91 checks (Phase 2)
node verify-harness/stop.mjs      # when finished
```

Requirements: Linux x64, `node` ≥ 20, network access on first run (downloads the
PostgREST static binary; PostgreSQL binaries install via npm into
`verify-harness/node_modules`).

## Manual browser verification (golden path)

The complete flow was additionally exercised in a real (headless Chromium)
browser during development, driving the actual UI:

**Phase 1 (re-verified after the Phase 2 changes):**

1. `GET /` shows the login interface (logo, tagline, username, password with
   show/hide, Continue).
2. Correct credentials → OTP screen with masked email, expiry countdown and a
   resend cooldown.
3. Enter the code from `.dev-outbox` (capture mode) → redirect to `/dashboard`
   showing "Welcome back, Deepak Khurana".
4. Sign out → back to the login page; `/dashboard` then redirects to `/`.
5. Wrong password → generic error with remaining-attempts warning.
6. Four real failures → the lockout screen replaces the form; countdown ticks
   from 24 h; reload keeps it (server-rendered); `/dashboard` still redirects.
7. Production-mode check: `next build` + standalone server verified the strict
   nonce CSP hydrates correctly and SMTP failure fails closed.

**Phase 2 (browser-driven):**

1. Empty-state dashboard after login — "No firms added yet." with the
   supporting text and the Add Your First Firm CTA.
2. CTA opens the Add New Firm modal on `/settings/firms`.
3. Submitting the empty form shows all field-level validation errors.
4. Filling valid data (name, website, holding 51.25, address, details) plus a
   real PNG upload → Save Firm → success toast → modal closes → the firm
   appears immediately in the management list and on the dashboard.
5. Responsive grid verified by computed styles at 1440 px (4 columns, 2 rows
   for 6 firms), 768 px (2 columns) and 375 px (1 column) — zero horizontal
   overflow at every width; uploaded logos load, firms without logos render
   the initials fallback.
6. Website links open in a new tab with `rel="noopener noreferrer"`.
7. `/settings/account`: profile card renders from the account configuration;
   wrong current password is rejected; a correct password change flips the
   credential source to "Database", reports success and revokes other
   sessions.
8. Profile menu: greeting identity, Account settings / Firm management
   navigation, Sign out (server-side revocation).
9. Firm-card click surfaces the "dedicated firm dashboards arrive in an
   upcoming phase" notice (no fake navigation).
10. No browser console errors or page errors at any point (only the expected
    dev-tool informational notices).

## Continuous verification

All suites are idempotent (they reset auth/firm state between scenarios and at
exit), so they can run repeatedly or in CI. The unit suite doubles as a fast
pre-commit gate: `npx tsc --noEmit && bun run lint && npx tsx scripts/test-unit.ts`.
