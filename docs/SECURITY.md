# Security Documentation — Phases 1–3 (Authentication, Firm Management, Account Settings)

This document explains every security control in the authentication system, the
firm-management surface and the Account Settings module, the reasoning behind
the global lockout design, and the operational procedures an administrator of
this system needs.

---

## Contents

- §1–§8 — Phase 1 authentication (unchanged, fully in force)
- §9 — Phase 2: firm management & file-upload security
- §10 — Storage adapters and what production must use (Phases 2 & 3)
- §11 — Phase 3: Account Settings security (profile separation, email-change
  verification, password change, logo protection)

## 1. Authentication architecture

```
Browser                    Next.js server (actions)            Supabase PostgreSQL
  │  username + password  ──▶  loginAction                        │
  │                           1. origin + CSRF check              │
  │                           2. rate limit (atomic counter)      │
  │                           3. GLOBAL lockout check             │
  │                           4. Argon2id verify (timing-equalized)│
  │                           5. OTP issue + SMTP email        ◀──│ auth_otp_challenges (hash only)
  │  ◀─ step 2 screen + signed HttpOnly pre-auth cookie            │
  │                                                                   │
  │  8-char code  ──────────▶  verifyOtpAction                       │
  │                           6. lockout check                      │
  │                           7. atomic single-use consume       ◀──│ auth_consume_otp()
  │                           8. failure counter reset             │
  │  ◀─ session cookie (HttpOnly) + redirect /dashboard             │ admin_sessions (hash only)
```

Properties:

- **Two-step verification.** Credentials alone never produce a session. The emailed
  code is the second factor and is single-use, valid 5 minutes.
- **Nothing sensitive in the browser.** No token, code, hash or key is ever written
  to `localStorage`/`sessionStorage`; the browser never contacts Supabase directly
  (`connect-src 'self'` in the CSP enforces this network-wide).
- **Fail-closed error handling.** Database/SMTP/environment failures surface as a
  generic "temporarily unavailable" message; authentication never proceeds on a
  degraded dependency.

## 2. Secret handling

| Secret | Where it lives | How it is used |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | server env only | Supabase client (bypasses RLS). Never sent to the client; no `NEXT_PUBLIC_` prefix. |
| `AUTH_SESSION_SECRET` | server env only | HMAC key for the signed pre-OTP cookie. |
| `OTP_SECRET` | server env only | HMAC pepper when hashing codes — a database leak cannot be brute-forced offline without it. |
| `SMTP_PASSWORD` | server env only | Nodemailer transport. |
| Administrator password | Argon2id hash in `admin_accounts.password_hash` | Plaintext exists only transiently in memory during verification. |
| OTP codes | HMAC-SHA256 hex in `auth_otp_challenges.code_hash` | Plaintext exists only in the outgoing email. |

Logs (`logAuthEvent` / `logAuthError`) are constrained to safe fields: identifiers,
outcomes, error codes and timestamps. The test suite asserts that neither OTP codes
nor passwords ever appear in captured log output. Server errors thrown to clients
carry only sanitized messages; internal details are logged server-side.

## 3. The GLOBAL login lockout

### Policy

- Both failed **credential verification** and failed **OTP verification** count as
  authentication failures.
- The **4th consecutive** failed attempt activates a **24-hour lockout**.
- While locked, the login form is replaced by a lockout screen that shows the
  remaining time; server actions reject every attempt before touching credentials.
- The lockout is **global**: one shared state row (`security_lockouts`, id
  `GLOBAL`) in PostgreSQL. It applies to every device, browser, IP address and
  process — cookies, `localStorage`, browser sessions and client-side IP logic are
  irrelevant by design, so clearing them changes nothing.
- It **survives restarts and redeploys** because the state lives in the database.
- **Only a complete successful authentication** (credentials + OTP) resets the
  consecutive-failure counter.

### Race-safety and tamper resistance

- The failure counter is incremented by a single atomic SQL UPSERT
  (`auth_register_failure`). Concurrent requests can never race past the threshold.
- The OTP consumer takes a row lock (`SELECT … FOR UPDATE`) inside
  `auth_consume_otp`, so two parallel submissions of the same code cannot both
  succeed — the first consumes it, the second observes `already_used`.
- Failed requests **cannot extend, shorten or reset** an active lockout: the
  activation branch only runs when transitioning from unlocked → locked. This is
  verified by the integration test "failed requests neither extend nor reset the
  lockout timer".

### Security implications (documented trade-offs)

1. **Strictly consecutive semantics.** Because only a complete success resets the
   counter, a failure *after a lockout expires* immediately re-activates the
   lockout (the counter was never reset). A legitimate administrator returning
   after 24 hours who mistypes once is locked again. This is the deliberate strict
   reading of "more than three *consecutive* failures", and it denies an automated
   attacker the "3 free guesses per day" budget that an expiry-reset would grant.
   To recover, the administrator must sign in correctly (full budget restored) —
   or use the operator procedure below.
2. **Denial-of-service by design.** Anyone who knows the (single) username can
   trigger the global lockout by submitting wrong passwords 4 times. This is the
   accepted cost of a global lockout on a single-administrator system: availability
   yields to confidentiality. Mitigations already in place: the lockout screen
   never confirms whether the username exists, and all requests are rate-limited so
   hammering the endpoint gains nothing beyond what 4 failures achieve.
3. **No self-service unlock — on purpose.** There is no public reset endpoint and
   no CAPTCHA-based early unlock. The 24-hour window is the only automatic path.

### Operator procedure: clearing a lockout (emergency)

Use only with the service role key from a trusted shell (this is a database
operation, not an application endpoint):

```sql
-- Inspect
select * from security_lockouts where id = 'GLOBAL';
-- Reset the consecutive-failure counter and clear the lockout
update security_lockouts
   set consecutive_failures = 0, locked_until = null, locked_at = null
 where id = 'GLOBAL';
```

The bundled test suite performs the equivalent through the service client between
scenarios; `resetGlobalAuthStateForTests()` in `src/lib/auth/service.ts` shows the
programmatic form.

## 4. Password management foundation

- **Bootstrap:** on first use, the administrator row is created from
  `ADMIN_*` environment variables, hashed immediately with Argon2id
  (19 MiB / t=2 / p=1). The insert is an idempotent
  `INSERT … ON CONFLICT (username) DO NOTHING` — race-safe.
- **Never overwrite:** bootstrap only ever *creates*. Once
  `credentials_source` flips to `database` (the Phase 3 Account Settings
  password change), environment values are permanently ignored — startup can
  never roll a changed password back. The integration tests assert this by
  mutating the row and re-running bootstrap.
- **Change flow (Account Settings, Phase 3):** verify current password →
  validate the new one against the strong policy (12–128 characters with
  uppercase, lowercase, digit and symbol) → Argon2id-hash it → update
  `password_hash`, set `credentials_source = 'database'`,
  `password_updated_at = now()`, revoke every OTHER session (the session that
  completed the change survives so the administrator is not signed out
  mid-flow; the next sign-in uses the new credential). The environment
  bootstrap password must satisfy the same policy at creation time.
- Plaintext passwords are never stored, never logged, never returned to any
  client (`password_hash` is stripped from every DTO).

## 5. Sessions

- Cookie value: 256-bit random token (base64url), **HttpOnly**, **SameSite=Lax**,
  **Secure in production**, path `/`. No `localStorage` / `sessionStorage` use.
- Database stores only `sha256(token)`; a database leak cannot be replayed as
  valid cookies.
- **Fixation prevention:** every login mints a brand-new token; the pre-auth
  cookie is cleared on success.
- Expiry: absolute 8 hours + 60-minute idle timeout, both enforced server-side on
  every protected request (`validateSessionToken`) — the cookie's max-age is only
  browser housekeeping. Sliding `last_seen_at` updates are rate-limited.
- Logout revokes the row (`revoked_at`) and clears the cookie; a revoked token
  fails validation instantly and forever.
- Route protection: the edge proxy gives unauthenticated visitors a fast 307 to
  `/`, and every protected page/action independently re-validates against the
  database (the proxy check is UX only — a forged cookie dies there).

## 6. Request hardening

| Control | Implementation |
| --- | --- |
| SQL injection | Every query goes through the Supabase query builder / typed RPC calls (PostgREST parameter binding). No string-concatenated SQL anywhere. |
| XSS | React escaping only; no `dangerouslySetInnerHTML`. CSP: `default-src 'self'`, `script-src 'self' nonce-… 'strict-dynamic'` (production), `object-src 'none'`, `frame-ancestors 'none'` (production). |
| CSRF | SameSite=Lax cookies + Server-Action origin checks + explicit Origin/Host validation + HttpOnly double-submit CSRF token verified on every mutating action. |
| Rate limiting | PostgreSQL atomic fixed-window counters shared by all instances: login 10/5 min, OTP verify 12/5 min, OTP issue 6/hour, resend cooldown 60 s; account writes: password change 5/hour, profile update 10/hour, email-change codes 6/hour + 60 s cooldown, email-change verification 12/10 min. Fails closed. |
| Brute force | Global lockout (§3) + per-challenge OTP attempt cap (5) + Argon2id cost. |
| Session fixation | Fresh random token per authentication (§5). |
| Enumeration | Identical error message and near-identical timing for wrong-username vs wrong-password (dummy Argon2id verification equalizes the timing). |
| Secrets in URLs | None — all flows are POST server actions; OTP never appears in any response, redirect, log or cookie. |
| Headers | `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options`/`frame-ancestors`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `X-Robots-Tag: noindex`, HSTS (production), CSP nonce per request. |
| Dependency risk | Audited: 0 known vulnerabilities in the security-relevant dependency set (`@supabase/supabase-js`, `@node-rs/argon2`, `nodemailer`, `zod`, `tsx`). Zod was upgraded to ≥4.6.6 to clear GHSA-mrhx-c7xc-m3w5. |

### CSP note

Development needs `'unsafe-eval'`/`'unsafe-inline'` for React Fast Refresh, so the
strict policy (nonce + `strict-dynamic`, `frame-ancestors 'none'`, HSTS,
`X-Frame-Options: DENY`, Secure cookies) activates only when
`NODE_ENV=production`. Both modes were verified in a real browser during
development (hydration works under the nonce policy; zero CSP violations).

## 7. OTP specifics

- Generation: 8 characters from a 32-symbol alphabet (uppercase + digits minus
  ambiguous `I O 0 1`) drawn with `crypto.randomInt`.
- Storage: `HMAC-SHA256(code, OTP_SECRET)` hex — peppered, deterministic,
  verifiable server-side only.
- Lifecycle: 5-minute expiry, single-use atomic consumption, max 5 attempts per
  challenge, issuing a new code invalidates all previous ones, resend blocked for
  60 seconds and capped at 6 per hour.
- Transport: professional HTML+text email; the code never appears in API
  responses or logs; failures to deliver roll back the challenge (fail closed).
- Development convenience: `SMTP_DEV_CAPTURE=true` (non-production only) writes
  the message to `.dev-outbox/*.eml` instead of sending — see `docs/TESTING.md`.

## 8. Operational monitoring

- `auth_attempts` is an append-only audit trail (type, outcome, admin id,
  attempted username, IP, user agent, timestamp — never codes or passwords).
  Query recent failures:

  ```sql
  select created_at, attempt_type, outcome, username_attempted, ip_address
    from auth_attempts order by created_at desc limit 50;
  ```

- `/api` reports liveness + database reachability (no data).
- Housekeeping: `select auth_cleanup_auth_data(168, 720, 48);` purges old
  sessions/attempts/challenges — safe to schedule with pg_cron.

---

## 9. Phase 2 — Firm management & file-upload security

### Authorization model

- **Every** firm-management route (`/dashboard`, `/settings/*`) is protected by
  server-side session validation on every request: the edge proxy fast-path
  redirects cookie-less requests, the settings layout re-validates, and each
  page re-validates independently (defense in depth — a forged cookie dies in
  the database lookup).
- The **only** state-changing firm endpoint is the `createFirmAction` Server
  Action. It refuses to run without a valid session, a matching CSRF
  double-submit token, a same-origin request, and rate-limit budget
  (`firms:create`, 12/hour, PostgreSQL atomic counter shared across
  instances).
- Firm data is read and written **exclusively** through the service role from
  server code. `firms` has RLS enabled with **zero policies**: anonymous and
  authenticated Supabase keys can neither read nor write it (asserted by the
  test suite). The browser never talks to Supabase (`connect-src 'self'`).
- All queries go through the Supabase query builder (PostgREST parameter
  binding) — no string-concatenated SQL anywhere. Database CHECK constraints
  (name/address lengths, holding 0–100, URL scheme) mirror the Zod validation
  as the last line of defense.

### Input validation

- One Zod schema (`src/lib/firms/validation.ts`) is shared by the client form
  (UX only) and the server action (authoritative): required name 2–120 chars,
  required address 5–200 chars, optional description ≤ 1000 chars, optional
  website that must be a genuine `http(s)://` URL (`javascript:`, `ftp://`,
  scheme-less strings rejected), and a required holding percentage matching
  `^\d{1,3}(\.\d{1,2})?$` bounded to 0–100 (max two decimals).
- Every field is re-validated server-side even when the client is bypassed
  (curl / forged requests) — the tests submit invalid payloads directly
  against the service layer.

### Upload hardening (firm logos)

The client's filename and Content-Type are **never trusted**. In
  `src/lib/firms/storage.ts`, before a single byte is persisted:

1. **Size limit** checked on the actual buffer (2 MB).
2. **Magic-byte sniffing** determines the real type — a text file named
   `.png` is rejected. Only PNG / JPEG / WebP signatures pass.
3. **Full re-encode with sharp** proves the payload decodes as a real image,
   strips EXIF and all metadata, caps the logo to a 512×512 box (no
   upscaling) and discards any trailing bytes after the image payload —
   neutralizing polyglot files (e.g. image/HTML or image/SVG-XSS combos,
   which are rejected outright since SVG is not an accepted type).
4. The stored filename is a **server-generated UUID + whitelisted
   extension** — no user-controlled characters ever reach a path or object
   key.

Serving: production serves logos from the public `firm-logos` Supabase
Storage bucket (public read is appropriate for brand assets; writes are
service-role only). The CSP allows images from exactly `'self'`, `data:`,
`blob:` and the project's own Supabase origin — no arbitrary hosts. In the
development adapter, logos are served through a route handler that accepts
**only** `/uploads/firm-logos/<uuid>.<png|jpg|webp>` (path traversal and
non-UUID names refused, content type from the whitelist, `nosniff` always on).

### XSS

All firm data (names, addresses, descriptions, URLs) renders through React's
escaping — no `dangerouslySetInnerHTML` exists in the codebase. The test
suite stores a `<script>`-styled firm name and asserts the rendered page
contains it only as escaped text. Website links are additionally constrained
to `http(s)://` at validation time and rendered with
`target="_blank" rel="noopener noreferrer"`.

### CSRF on write operations

`createFirmAction` and every Phase 3 account action
(`updateCorporationProfileAction`, `requestEmailChangeAction`,
`confirmEmailChangeAction`, `resendEmailChangeCodeAction`,
`changePasswordAction`) run the same guard chain as the authentication
actions: Server-Action origin enforcement, explicit Origin/Host validation
against `APP_URL`, the HttpOnly double-submit CSRF token, and SameSite=Lax
session cookies.

## 10. Phase 2 — storage adapters

| Mode | Use | Behaviour |
| --- | --- | --- |
| `supabase` (default) | Production & any real Supabase project | Uploads to the `firm-logos` / `corporation-logos` buckets with the service role; public URLs from Supabase Storage. Bucket-level MIME + size limits (set in migrations 0002/0003) act as a second enforcement layer. |
| `local` | Bundled verification harness / offline staging only | Writes the *same hardened, re-encoded* bytes to `.data/firm-logos` / `.data/corporation-logos` and serves them via the sanitized `/uploads` route. |

Both adapters run the identical validation pipeline (`LOGO_STORAGE_MODE`;
`FIRM_LOGO_STORAGE_MODE` remains a legacy Phase 2 alias) — the only difference
is the persistence target. The `local` adapter is a development convenience
for the harness (which has no Storage API); setting it in production is a
configuration error (it is documented as such in `.env.example`).

Operational note: if an insert fails *after* a logo was stored, the logo
file/bucket object is orphaned (harmless, logged); housekeeping can remove
objects not referenced by `firms.logo_url` / `corporation_profile.logo_url`.

---

## 11. Phase 3 — Account Settings security

### Separation of concerns

The corporation profile (name, logo) lives in `corporation_profile` — its own
RLS-locked table, **completely separate** from the authentication
configuration in `admin_accounts`. Only the sign-in identity (username,
password, email) and the display name remain on the administrator row; brand
data never mixes with credentials.

### Authorization model

- `/settings/account` is protected exactly like every authenticated route
  (edge-proxy fast path + layout + page re-validation, all database-backed).
- The **only** state-changing account endpoints are the five Server Actions
  listed in §9 (CSRF guard chain). Each refuses to run without a valid
  administrator session; there is deliberately no unauthenticated account
  surface.
- `corporation_profile` and `email_change_requests` carry RLS with **zero**
  policies; all access flows through the service role from server code only
  (asserted by the test suite, including the RPC execute revokes — an anon
  key cannot invoke `account_consume_email_change`).

### Email change — verification-gated activation

Changing the administrator email (the delivery target for sign-in codes) is a
**two-step, verified** flow:

1. **Request:** the new address is validated (format, differs from the current
   one, not claimed by any administrator — case-insensitive) and an 8-character
   code is emailed **to the new address only**. Only
   `HMAC-SHA256(code, OTP_SECRET)` is stored; the request expires after 10
   minutes, allows max 5 wrong attempts, is single-use, and issuing a new
   request retires every previous one. Code issuance is capped at 6/hour with
   a 60-second cooldown; re-requesting the same pending address is idempotent
   (no duplicate code, no cooldown burn). The **current email stays active**
   the whole time.
2. **Confirmation:** the atomic SECURITY DEFINER function
   `account_consume_email_change(p_admin_id, p_code_hash)` verifies the code
   AND swaps `admin_accounts.email` in a single transaction (row-locked,
   race-free). An expired, exhausted or already-consumed request can never
   flip the address. The code never appears in responses or logs.

### Password change

See §4. The current password is verified against the stored Argon2id hash
before anything is written; weak candidates are rejected by the shared strong
policy; every other session is revoked on success.

### Logo upload protection

The corporation logo runs through the **same hardened pipeline** as firm
logos (§9) via the shared image codec (`src/lib/storage/image-codec.ts`):
magic-byte sniffing, sharp re-encode (EXIF stripped, 512 px cap), 2 MB limit,
server-generated UUID filenames, dedicated `corporation-logos` bucket
(bucket-level MIME/size limits) or the sanitized `/uploads/corporation-logos`
route in the dev adapter (traversal impossible). Serving carries
`nosniff` and a whitelist content type.

### Information exposure

- The stored password hash is never displayed or returned by any endpoint.
- Pending email changes are surfaced **masked** (first letter + dots).
- Verification codes appear only inside the outgoing emails.
- Errors follow the established taxonomy: public-safe messages for validation
  outcomes, generic "temporarily unavailable" for system failures (detail
  only in server logs).
- Timestamps render in the reader's local timezone client-side; the database
  stores UTC (`last_login_at` is written only on fully successful OTP login).
