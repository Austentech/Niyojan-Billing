# Testing Documentation — Phases 1–3 (Authentication, Firm Management, Account Settings)

## Automated suites

| Suite | Command | Needs database | Coverage |
| --- | --- | --- | --- |
| Unit | `npx tsx scripts/test-unit.ts` | No | OTP generation/hashing, normalization, Zod schemas (incl. the strong 12-char password policy), pre-auth cookie signing (tamper/expiry), Argon2id roundtrip, email masking, env validation hygiene |
| Integration (auth) | `npx tsx scripts/test-auth.ts` | Yes (staging or local harness) | The full 13-scenario Phase 1 matrix + extras |
| Integration (firms) | `npx tsx scripts/test-firms.ts` | Yes (staging or local harness) | The full 12-scenario Phase 2 matrix + extras |
| Integration (account) | `npx tsx scripts/test-account.ts` | Yes (staging or local harness) | The full 12-scenario Phase 3 matrix + extras |

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

## The Phase 3 required scenarios → automated assertions

All 12 are asserted by `scripts/test-account.ts` (139 checks total), which runs
the same account service/storage layers the application uses against the real
PostgreSQL + PostgREST stack, plus HTTP-level checks against the dev server
with a genuine session cookie:

| # | Required scenario | Assertions in the suite |
| --- | --- | --- |
| 1 | Displaying account information | `getAccountOverview` returns the administrator identity from the account configuration (name/email/username), the seeded corporation profile (name, NULL logo → official asset), credential source and the database `last_login_at`; authenticated `GET /settings/account` renders the overview card, corporation name, administrator name/email, last-login field and UTC-format timestamps (the local-timezone swap is client-side, browser-verified); unauthenticated request → 307 |
| 2 | Updating corporation name | `updateCorporationProfile` → database row updated and reflected in the overview + a freshly-rendered page; empty / 1-char / 121-char names rejected with field errors; nothing written on invalid input; the DB CHECK constraint rejects a bad name even when the app is bypassed |
| 3 | Updating administrator name | `updateDisplayName` → database + active session context + dashboard greeting all reflect the new name immediately; 1-char name rejected; unknown administrator reported, never created |
| 4 | Updating administrator email with verification | Request → code emailed to the NEW address only (.eml captured, To-header checked, 8-char charset); only the HMAC hash stored; current email stays active; wrong code rejected + burns one attempt; correct code → email activated atomically, request consumed, code single-use; reuse → `not_found`; same-address re-request is idempotent; cooldown blocks immediate re-requests; expired request → `expired`; five wrong codes → `too_many_attempts`; malformed/same-address requests rejected; RLS blocks anon on `corporation_profile`, `email_change_requests` and the consume RPC |
| 5 | Changing corporation logo | Real PNG stored through the hardened pipeline (magic bytes, sharp re-encode, 512 px cap, UUID filename in its own `corporation-logos` area); profile updated; page renders the custom URL; served with `image/png` + `nosniff`; text-spoofed / empty / >2 MB / truncated payloads rejected; `/uploads` traversal + unrelated areas → 404; removing the logo restores the official brand asset |
| 6 | Successful password update | `changeAdminPassword` with the correct current password → hash changed (Argon2id), `credentials_source='database'`, `password_updated_at` refreshed; new password verifies, old fails; every OTHER session revoked while the current one stays valid; bootstrap re-run never rolls the credential back |
| 7 | Incorrect current password | → `wrong_current`; the stored hash is untouched; re-using the same password is rejected |
| 8 | Password mismatch | The client+server shared schema rejects a confirmation that differs from the new password (error points at the confirmation field); matching values pass |
| 9 | Weak password rejection | 11 chars / no-uppercase / no-lowercase / no-digit / no-symbol each rejected by the strong policy; a compliant 12+ char password accepted |
| 10 | Login using the newly updated password | `submitCredentials` with the new password → OTP issued and delivered to the newly verified email; full OTP verification completes; login with the old password → `invalid_credentials` |
| 11 | Login using the old password | Explicit re-check: rejected, and the stored hash no longer verifies the old password |
| 12 | Accurate last-login timestamp | After a successful OTP-authenticated login `last_login_at` is set, differs from the previous value and matches the actual login moment (UTC, seconds-accurate); a credentials-correct but OTP-failed attempt does NOT touch it |

**Extras** (also asserted): the verification code never appears in captured
console output; pending email changes are surfaced masked for the UI; the
`corporation_profile` table is fully separate from authentication tables; and
the suite restores the pristine bootstrap state (name/email/password/credential
source) so all four suites are re-runnable in any order.

## Running the integration suites

### Option A — staging Supabase project (recommended)

1. Create a **dedicated staging** Supabase project (never production — the suites
   reset lockout/rate-limit state and consume OTP budget).
2. Apply every file in `supabase/migrations/` in the SQL editor, in filename
   order (0001, 0002, …).
3. Point `.env` at it and set `SMTP_DEV_CAPTURE=true` so codes are written to
   `.dev-outbox/` instead of being emailed.
4. `npx tsx scripts/test-auth.ts && npx tsx scripts/test-firms.ts && npx tsx scripts/test-account.ts`
   (the firms + account suites also need `LOGO_STORAGE_MODE=local` when running
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
npx tsx scripts/test-account.ts   # 139 checks (Phase 3)
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

**Phase 3 (browser-driven, after the Phase 3 changes):**

1. Two-step login with the environment bootstrap credentials → dashboard.
2. `/settings/account` — Account overview renders the corporation name, the
   official logo, the administrator identity from the account configuration
   and "Last successful login … (UTC)" in the reader's local timezone
   (client-side swap after hydration; verified at a UTC-locale browser).
3. Corporation profile: updating corporation name + administrator display
   name → success toast → the overview, header greeting and form all reflect
   the new values immediately (router refresh + server revalidation).
4. Corporation logo: real PNG upload → success toast → the custom logo
   renders and persists across a reload; the image loads (`naturalWidth > 0`).
5. Email change: enter a new address → "Send verification code" → masked
   confirmation box with expiry countdown and resend cooldown → enter the
   code from `.dev-outbox` → "…is now <new email>" and the active-email field
   updates immediately.
6. Password change: wrong current password → inline error; weak password →
   field error + live requirements checklist; compliant password → success
   message and the credential source flips to "Database — set through
   Account Settings".
7. Sign out → old password rejected ("Invalid credentials"), new password
   accepted → OTP email arrives at the newly verified address → verification
   completes → back on `/dashboard`.
8. Responsive layout verified by computed styles at 1440 px, 768 px and
   375 px — zero horizontal overflow at every width (the floating dev-tools
   button seen in dev screenshots is a Next.js dev-mode overlay, not part of
   the application).
9. No browser console errors or page errors at any point.

## Continuous verification

All suites are idempotent (they reset auth/firm/account state between
scenarios and at exit), so they can run repeatedly, in any order, or in CI.
The unit suite doubles as a fast pre-commit gate:
`npx tsc --noEmit && bun run lint && npx tsx scripts/test-unit.ts`.
