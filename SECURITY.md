# SECURITY — Niyojan Corporation

**Centralized Financial & Billing Management System** · *Structural Growth. Trusted Control.*

Security in this application is a primary requirement, not an enhancement. This document reflects the **actually implemented** controls (every claim below is enforced by code and verified by the automated test suites — see `docs/TESTING.md`).

---

## 1. Authentication protection

| Control | Implementation |
|---|---|
| Password hashing | **Argon2id** (`@node-rs/argon2`) — hashes only; plaintext never stored, logged or returned |
| Timing equalization | Unknown usernames run a **dummy Argon2id verification** so wrong-username and wrong-password responses take the same time (no user enumeration; messages identical — verified by tests) |
| Two-step authentication | Credentials → 8-character email OTP (unambiguous charset, `crypto.randomInt`); only complete OTP verification creates a session |
| OTP storage | Only `HMAC-SHA256(code, OTP_SECRET)` is persisted — a database leak cannot be brute-forced offline; the plaintext exists only in the outgoing email and volatile memory |
| OTP lifecycle | 5-minute expiry, single-use (row-locked atomic consumption), ≤5 wrong attempts, resend invalidates all previous codes, 60 s cooldown, 6/hour cap |
| Global lockout | 4th consecutive failure (credential **or** OTP) → **24-hour GLOBAL lockout**: database-atomic (single UPSERT), device/browser/IP/cookie-independent, survives redeploys; failures can neither extend nor reset an active timer; only a complete success resets the counter; **no public reset endpoint exists — ever** |
| Sessions | 256-bit random opaque tokens; only SHA-256(token) stored (leak-safe); HttpOnly + SameSite=Lax + Secure-in-production cookies; new token minted per login (fixation-safe); 8 h absolute + 60 min idle timeout enforced server-side on EVERY protected request; rotation-free revocation on logout; every other session revoked on password change |
| `last_login_at` | Written only after complete OTP-verified login |
| Bootstrap | Idempotent; never overwrites a database-sourced credential (verified incl. redeploy scenarios) |

## 2. Rate limiting

Distributed and persistent — **PostgreSQL atomic counters** (`rate_limits` + `auth_check_rate_limit()`), never in-memory-only, shared across every serverless instance, redeploy-proof. Fails **closed** (limiter unreachable → request rejected).

| Scope | Limit |
|---|---|
| Login submissions | 10 / 5 min |
| OTP verification | 12 / 5 min |
| OTP issuance | 6 / hour |
| Firm creation | 12 / hour |
| Profile updates | 10 / hour |
| Password changes | 5 / hour |
| Email-change codes / verification | 6 / hour · 12 / 10 min |

## 3. CSRF / XSS / SQL-injection protection

- **CSRF:** every state-changing server action validates (1) Next.js's built-in cross-origin POST rejection, (2) the `Origin` header against `Host` and the canonical `APP_URL`, and (3) a **double-submit CSRF token** (HttpOnly cookie seeded by the edge proxy = hidden form field). SameSite=Lax session cookies mean cross-site POSTs carry no session anyway.
- **XSS:** React safe rendering only (no `dangerouslySetInnerHTML` anywhere); strict **Content-Security-Policy** with a per-request nonce and `strict-dynamic` in production (script execution allow-list), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`; nosniff; `X-Frame-Options: DENY`; no-referrer policy; external URLs validated as http(s) before storage; uploaded images fully re-encoded (a polyglot payload cannot survive).
- **SQL injection:** every statement is a Drizzle parameterized query or a bound-parameter call to the SECURITY DEFINER functions; identifiers are structure-level constants; there is no string concatenation of untrusted input; CHECK constraints reject anything that slips past validation (belt and braces — verified by tests).

## 4. Upload security (logos)

Size cap on the real buffer (2 MB) → **magic-byte** content detection (extensions and client Content-Type are never trusted) → full **sharp re-encode** (proves decodability, strips EXIF, caps at 512 px, truncates trailing junk) → server-generated UUID filenames (no user-controlled path characters) → in production, storage ONLY to the configured **S3-compatible object store** (never the ephemeral serverless filesystem). When object storage is not configured the UI offers validated logo URLs instead — no dead buttons, nothing pretending to work. The local-filesystem adapter is development-only and rejected by env validation in production.

## 5. Secret management

- All secrets live in the environment (Vercel Environment Variables / `.env` in dev); `.env` is gitignored; `.env.example` carries placeholders only.
- `src/lib/config/env.ts` is the **only** consumer: Zod-validated lazily (build never needs credentials), errors list **variable names only** — values never appear in logs, responses or the client bundle.
- Two distinct HMAC keys (`AUTH_SESSION_SECRET`, `OTP_SECRET`) — enforced unequal.
- **Never logged:** passwords, OTP values, session identifiers, SMTP passwords, database connection strings, authentication secrets (test suite captures console output during the full login flow and asserts the code and password never appear).

## 6. Transport & headers

Production responses carry: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, the CSP described above, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` with camera/microphone/geolocation/payment disabled, and `upgrade-insecure-requests`. Development relaxes exactly what React Fast Refresh and the sandbox preview need (`unsafe-eval`, `frame-ancestors 'self'`) and nothing more.

## 7. Audit logging

Two append-only trails, both best-effort (an audit failure never blocks an auth decision):

- `auth_attempts` — every credential/OTP attempt (type, outcome, admin, attempted username, validated IP, truncated UA).
- `security_audit_logs` — significant events (login success, lockout activation, password change, email change, firm/profile writes) with sanitized scalar detail only.

## 8. Recovery procedures (operator shell only — no public endpoints)

| Scenario | Action |
|---|---|
| Accidental 24 h lockout | `delete from security_lockouts where id = 'GLOBAL'; delete from rate_limits where key like 'auth:%';` (owner/unpooled connection) |
| Lost password | `update admin_accounts set is_active = true where username = '…';` then sign in with a reset hash and change it in Account Settings |
| Revoke every session | `delete from admin_sessions;` (or: any password change in Account Settings) |
| Rotate secrets | set new `AUTH_SESSION_SECRET`/`OTP_SECRET` in Vercel → redeploy (sessions and pending codes invalidate naturally) |
| Data recovery | see DATABASE.md §5 |

## 9. Dependency health

- Runtime dependency tree: **`npm audit --omit=dev` → 0 vulnerabilities.**
- Upgrades performed during this hardening pass: Next.js **16.1.3 → 16.4.6** (fixes a critical GHSA advisory affecting self-hosted image optimization and request smuggling classes), `sharp` (inherited libvips CVEs), `uuid`, and `source-map-js` pinned via `overrides`.
- Removed 20 entirely-unused packages (next-auth, recharts, mdxeditor, dnd-kit, tanstack, …) — shrinking the attack surface.
- Remaining advisories are **dev-only lint/build tooling** (ReDoS-class ReDoS in `minimatch`/`picomatch`/`brace-expansion` chains inside eslint plugins, `@babel/core` source-map read during builds). None of these packages ship into or execute in the deployed runtime; each awaits its upstream release and is tracked here deliberately rather than silently.
- Lockfiles are committed (`bun.lock`); installs are reproducible.

## 10. Known, accepted limitations

- The lockout is GLOBAL by design (single-administrator system): a hostile actor who knows the credentials can deliberately lock the console (availability trade-off for integrity). Operator recovery is documented above.
- Logo URLs in `url` mode are images loaded from arbitrary https hosts — images cannot execute scripts under the CSP, and the CSP's `img-src` allows exactly `https:`; the risk is accepted for brand flexibility.
- SMTP delivery failures are reported to the user as a failed sign-in (fail closed) — no silent degradation.
