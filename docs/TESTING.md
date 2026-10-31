# Testing Documentation — Phase 1 Authentication

## Automated suites

| Suite | Command | Needs database | Coverage |
| --- | --- | --- | --- |
| Unit | `npx tsx scripts/test-unit.ts` | No | OTP generation/hashing, normalization, Zod schemas, pre-auth cookie signing (tamper/expiry), Argon2id roundtrip, email masking, env validation hygiene |
| Integration | `npx tsx scripts/test-auth.ts` | Yes (staging or local harness) | The full 13-scenario Phase 1 matrix + extras |

Run the unit suite first (it also sanity-checks the `.env` contract), then the
integration suite.

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

## Running the integration suite

### Option A — staging Supabase project (recommended)

1. Create a **dedicated staging** Supabase project (never production — the suite
   resets lockout/rate-limit state and consumes OTP budget).
2. Apply `supabase/migrations/0001_auth_core.sql` in the SQL editor.
3. Point `.env` at it and set `SMTP_DEV_CAPTURE=true` so codes are written to
   `.dev-outbox/` instead of being emailed.
4. `npx tsx scripts/test-auth.ts`

### Option B — bundled local harness (no Supabase account)

The harness runs **real PostgreSQL and real PostgREST** binaries locally, mirroring
Supabase's architecture (same migration SQL, same roles — `authenticator`, `anon`,
`authenticated`, `service_role` — same JWT-authenticated REST shape), so the app
code and tests run unmodified:

```bash
node verify-harness/start.mjs     # Postgres :5433, PostgREST :5434, /rest/v1 proxy :5435
                                  # (writes freshly minted keys into .env)
npx tsx scripts/test-unit.ts      # 46 checks
npx tsx scripts/test-auth.ts      # 90 checks
node verify-harness/stop.mjs      # when finished
```

Requirements: Linux x64, `node` ≥ 20, network access on first run (downloads the
PostgREST static binary; PostgreSQL binaries install via npm into
`verify-harness/node_modules`).

## Manual browser verification (golden path)

The complete flow was additionally exercised in a real browser during development:

1. `GET /` shows the login interface (logo, tagline, username, password with
   show/hide, Continue).
2. Correct credentials → OTP screen with masked email, expiry countdown and a
   resend cooldown.
3. Enter the code from `.dev-outbox` (capture mode) → redirect to `/dashboard`
   showing "Welcome back, Deepak Khurana".
4. Sign out → back to the login page.
5. Wrong password → generic error with remaining-attempts warning.
6. Four real failures → the lockout screen replaces the form; countdown ticks
   from 24 h; reload keeps it (server-rendered); `/dashboard` still redirects.
7. Production-mode check: `next build` + standalone server verified the strict
   nonce CSP hydrates correctly and SMTP failure fails closed.

## Continuous verification

Both suites are idempotent (they reset auth state between scenarios and at exit),
so they can run repeatedly or in CI. The unit suite doubles as a fast pre-commit
gate: `npx tsc --noEmit && bun run lint && npx tsx scripts/test-unit.ts`.
