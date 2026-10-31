/**
 * INTEGRATION TESTS — the complete Phase 1 authentication flow, run against a
 * REAL PostgreSQL + PostgREST stack (the same migration SQL and the same
 * service layer the application uses).
 *
 * Prerequisites:
 *   1. The verification harness is running    -> node verify-harness/start.mjs
 *   2. .env points at it and has SMTP_DEV_CAPTURE=true
 *
 * Run: npx tsx scripts/test-auth.ts
 *
 * Covers the required Phase 1 test matrix:
 *   1. correct credentials      7. OTP resend (+ cooldown + invalidation)
 *   2. incorrect credentials    8. four consecutive failures -> lockout
 *   3. correct OTP              9. lockout across "devices"
 *   4. incorrect OTP           10. automatic lockout expiry
 *   5. expired OTP             11. session persistence
 *   6. reused OTP              12. logout invalidation
 *                             13. unauthorized access to protected routes
 * plus bootstrap idempotency, audit trail, rate limiting, RLS blocking and
 * "no OTP secrets in logs" guarantees.
 */
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { loadDotEnv } from "./load-env";
import { check, checkEqual, rejects, section, finish } from "./test-harness";

loadDotEnv(".env");

import { createClient } from "@supabase/supabase-js";
import {
  submitCredentials,
  verifyOtp,
  resendOtp,
  resetGlobalAuthStateForTests,
} from "../src/lib/auth/service";
import { ensureAdminBootstrapped } from "../src/lib/auth/server/bootstrap";
import { createSession, validateSessionToken, revokeSessionByToken } from "../src/lib/auth/server/session";
import { getLockoutState } from "../src/lib/auth/server/lockout";
import { PublicAuthError } from "../src/lib/auth/errors";
import { getServerEnv } from "../src/lib/config/env";

const env = getServerEnv();
const OUTBOX = path.resolve(process.cwd(), env.SMTP_DEV_OUTBOX);

/** Fresh service-role client (independent of the app's cached singleton). */
function opsClient() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Fresh ANON client — proves anonymous access stays blocked. */
function anonClient() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const META = { ipAddress: "127.0.0.1", userAgent: "niyojan-test-suite/1.0" };

/** Extract the OTP code from the newest .eml in the dev outbox. */
function readLatestOtpCode(): string | null {
  let files: string[] = [];
  try {
    files = readdirSync(OUTBOX).filter((f) => f.endsWith(".eml")).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const raw = readFileSync(path.join(OUTBOX, files[files.length - 1]), "utf8");
  const match = raw.match(/letter-spacing:6px[^>]*>([A-HJ-NP-Z2-9]{8})</);
  return match ? match[1] : null;
}

/** Console capture: prove OTP codes and passwords never reach the logs. */
function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const original = { log: console.log, info: console.info, error: console.error, warn: console.warn };
  let output = "";
  const intercept = (...args: unknown[]) => {
    output += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
  };
  console.log = intercept as typeof console.log;
  console.info = intercept as typeof console.info;
  console.warn = intercept as typeof console.warn;
  console.error = intercept as typeof console.error;
  return fn().then(
    (value) => {
      Object.assign(console, original);
      return { value, output };
    },
    (err) => {
      Object.assign(console, original);
      throw err;
    },
  );
}

async function resetAuthState(): Promise<void> {
  await resetGlobalAuthStateForTests();
  const ops = opsClient();
  await ops.from("auth_otp_challenges").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await ops.from("admin_sessions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

/** Age every OTP challenge past the resend cooldown (ops manipulation). */
async function ageChallengesPastCooldown(): Promise<void> {
  const ops = opsClient();
  await ops
    .from("auth_otp_challenges")
    .update({ created_at: new Date(Date.now() - 75_000).toISOString() })
    .neq("id", "00000000-0000-0000-0000-000000000000");
}

async function main(): Promise<void> {
  const ops = opsClient();

  /* ==========================================================================
   * 0. BOOTSTRAP — idempotent, never overwrites database-updated credentials
   * ========================================================================*/
  section("0. Administrator bootstrap (env -> database, idempotent)");

  await resetAuthState();
  await ensureAdminBootstrapped();
  let adminRows = await ops.from("admin_accounts").select("id, username, display_name, credentials_source, password_hash");
  checkEqual(adminRows.data?.length, 1, "exactly one administrator exists after bootstrap");
  const admin = adminRows.data![0];
  checkEqual(admin.username, env.ADMIN_USERNAME, "username matches the environment variable");
  checkEqual(admin.display_name, "Deepak Khurana", "display name matches the environment variable");
  checkEqual(admin.credentials_source, "env_bootstrap", "credentials source is env_bootstrap");
  check(admin.password_hash.startsWith("$argon2id$"), "password stored as an Argon2id hash");
  check(!admin.password_hash.includes(env.ADMIN_PASSWORD), "plaintext password never stored");

  const hashBefore = admin.password_hash;
  await ensureAdminBootstrapped(); // second call must be a no-op
  adminRows = await ops.from("admin_accounts").select("password_hash");
  checkEqual(adminRows.data?.length, 1, "second bootstrap adds no row");
  checkEqual(adminRows.data![0].password_hash, hashBefore, "second bootstrap does not re-hash or overwrite");

  // Simulate a future Account-Settings password change; bootstrap must NEVER
  // roll it back to the environment value.
  await ops.from("admin_accounts").update({ credentials_source: "database" }).eq("id", admin.id);
  await ensureAdminBootstrapped();
  adminRows = await ops.from("admin_accounts").select("password_hash, credentials_source");
  checkEqual(adminRows.data![0].password_hash, hashBefore, "database-sourced credential is never overwritten by env");

  // Restore the pristine bootstrap marker so repeat runs start clean.
  await ops.from("admin_accounts").update({ credentials_source: "env_bootstrap" }).eq("id", admin.id);

  /* ==========================================================================
   * 1. CORRECT USERNAME AND PASSWORD  ->  OTP issued + emailed
   * ========================================================================*/
  section("1. Correct username and password -> OTP issued");

  await resetAuthState();
  let logProbe = "";
  const step1 = await captureConsole(() =>
    submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META }),
  );
  logProbe = step1.output;
  checkEqual(step1.value.status, "otp_required", "credential verification succeeds");
  const issued = step1.value.status === "otp_required" ? step1.value.issuedOtp : null;
  check(issued !== null, "an OTP challenge is issued");
  const code = readLatestOtpCode();
  check(code !== null, "verification email written to the dev outbox (.eml)");
  check(/^[A-HJ-NP-Z2-9]{8}$/.test(code ?? ""), "emailed code is 8 uppercase-letters+digits characters");
  check(issued!.emailMasked.includes("@"), "masked email returned for the OTP screen");
  check(!logProbe.includes(code ?? "___NOCODE___"), "OTP code never appears in application logs");
  check(!logProbe.includes(env.ADMIN_PASSWORD), "password never appears in application logs");

  const challengeRow = await ops.from("auth_otp_challenges").select("code_hash, expires_at, attempts, consumed_at").eq("id", issued!.challengeId).maybeSingle();
  check(challengeRow.data !== null, "challenge row persisted in the database");
  check(/^[0-9a-f]{64}$/.test(challengeRow.data?.code_hash ?? ""), "only the HMAC hash of the code is stored");
  check((challengeRow.data?.code_hash ?? "") !== code, "stored hash is not the plaintext code");
  check(challengeRow.data?.consumed_at === null, "challenge is unconsumed at issue time");
  const expiryDelta = Math.abs(Date.parse(challengeRow.data?.expires_at ?? "") - (Date.now() + 5 * 60_000));
  check(expiryDelta < 5_000, "challenge expires ~5 minutes after issue");

  /* ==========================================================================
   * 2. INCORRECT USERNAME AND PASSWORD  ->  generic failure, counter moves
   * ========================================================================*/
  section("2. Incorrect username and password");

  await resetAuthState();
  const wrongUser = await submitCredentials({ username: "nonexistent.admin", password: "wrong-password", meta: META });
  checkEqual(wrongUser.status, "invalid_credentials", "unknown username is rejected");
  const wrongUserMsg = wrongUser.status === "invalid_credentials" ? wrongUser.message : "";

  const wrongPassword = await submitCredentials({ username: env.ADMIN_USERNAME, password: "wrong-password", meta: META });
  checkEqual(wrongPassword.status, "invalid_credentials", "wrong password is rejected");
  const wrongPasswordMsg = wrongPassword.status === "invalid_credentials" ? wrongPassword.message : "";

  checkEqual(wrongUserMsg, wrongPasswordMsg, "error message identical for wrong username vs wrong password (no enumeration)");
  check(
    (wrongPassword.status === "invalid_credentials" && wrongPassword.failuresUntilLockout === 2),
    "failure counter increments (2 remaining after two failures)",
  );

  // Reset counter so later scenarios start clean.
  await resetAuthState();

  /* ==========================================================================
   * 3. CORRECT OTP  ->  verified + session created
   * ========================================================================*/
  section("3. Correct OTP -> authenticated session");

  const step1b = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  const issuedB = step1b.status === "otp_required" ? step1b.issuedOtp : null;
  const codeB = readLatestOtpCode();
  check(issuedB !== null && codeB !== null, "fresh OTP issued for the golden path");

  const verified = await verifyOtp({ challengeId: issuedB!.challengeId, adminId: issuedB!.adminId, code: codeB!, meta: META });
  checkEqual(verified.status, "verified", "correct code verifies");
  check(verified.status === "verified" && verified.admin.display_name === "Deepak Khurana", "verification returns the administrator");

  const session = await createSession(issuedB!.adminId, META);
  check(typeof session?.token === "string" && session.token.length >= 40, "session token created (256-bit random)");
  const context = await validateSessionToken(session.token);
  check(context !== null, "session token validates against the database");
  checkEqual(context?.displayName, "Deepak Khurana", "session context carries the administrator identity");

  const sessionRow = await ops.from("admin_sessions").select("token_hash, expires_at, revoked_at").eq("admin_id", issuedB!.adminId).maybeSingle();
  check(/^[0-9a-f]{64}$/.test(sessionRow.data?.token_hash ?? ""), "only the SHA-256 hash of the session token is stored");
  check((sessionRow.data?.token_hash ?? "") !== session.token, "database never stores the raw cookie token");

  // Consumed challenge after successful use:
  const consumed = await ops.from("auth_otp_challenges").select("consumed_at").eq("id", issuedB!.challengeId).maybeSingle();
  check(consumed.data?.consumed_at !== null, "OTP challenge marked consumed (single-use)");

  // Success resets the failure counter:
  const stateAfterSuccess = await getLockoutState();
  checkEqual(stateAfterSuccess.consecutiveFailures, 0, "complete successful authentication resets the failure counter");

  /* ==========================================================================
   * 4. INCORRECT OTP  ->  failure counted, attempt burned
   * ========================================================================*/
  section("4. Incorrect OTP");

  await resetAuthState();
  await ageChallengesPastCooldown();
  const step4 = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  const issued4 = step4.status === "otp_required" ? step4.issuedOtp : null;
  check(issued4 !== null, "OTP issued for the wrong-code scenario");

  const wrongOtp = await verifyOtp({ challengeId: issued4!.challengeId, adminId: issued4!.adminId, code: "ZZZZZZZZ", meta: META });
  checkEqual(wrongOtp.status, "invalid", "wrong code is rejected");

  const challenge4 = await ops.from("auth_otp_challenges").select("attempts").eq("id", issued4!.challengeId).maybeSingle();
  checkEqual(challenge4.data?.attempts, 1, "wrong attempt burned one of the challenge's attempt slots");

  const state4 = await getLockoutState();
  checkEqual(state4.consecutiveFailures, 1, "failed OTP verification counts as an authentication failure");

  /* ==========================================================================
   * 5. EXPIRED OTP  ->  rejected even with the correct code
   * ========================================================================*/
  section("5. Expired OTP");

  await resetAuthState();
  await ageChallengesPastCooldown();
  const step5 = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  const issued5 = step5.status === "otp_required" ? step5.issuedOtp : null;
  const code5 = readLatestOtpCode();

  // Ops manipulation: force the challenge into the past.
  await ops
    .from("auth_otp_challenges")
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", issued5!.challengeId);

  const expiredOtp = await verifyOtp({ challengeId: issued5!.challengeId, adminId: issued5!.adminId, code: code5!, meta: META });
  checkEqual(expiredOtp.status, "expired", "correct code past the 5-minute window is rejected");

  /* ==========================================================================
   * 6. REUSED OTP  ->  second use rejected
   * ========================================================================*/
  section("6. Reused (single-use) OTP");

  await resetAuthState();
  await ageChallengesPastCooldown();
  const step6 = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  const issued6 = step6.status === "otp_required" ? step6.issuedOtp : null;
  const code6 = readLatestOtpCode();

  const firstUse = await verifyOtp({ challengeId: issued6!.challengeId, adminId: issued6!.adminId, code: code6!, meta: META });
  checkEqual(firstUse.status, "verified", "first use of the code succeeds");

  const secondUse = await verifyOtp({ challengeId: issued6!.challengeId, adminId: issued6!.adminId, code: code6!, meta: META });
  checkEqual(secondUse.status, "already_used", "the same code cannot be used twice (single-use, atomically)");

  /* ==========================================================================
   * 7. OTP RESEND  ->  cooldown, invalidation of previous codes
   * ========================================================================*/
  section("7. OTP resend (cooldown + previous-code invalidation)");

  await resetAuthState();
  await ageChallengesPastCooldown();
  const step7 = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  const issued7 = step7.status === "otp_required" ? step7.issuedOtp : null;
  const code7first = readLatestOtpCode();

  // Immediate resend is blocked by the controlled cooldown:
  const cooldownErr = await rejects(
    resendOtp({ adminId: issued7!.adminId, meta: META }),
    "immediate resend is blocked by the 60s cooldown",
  );
  check(cooldownErr instanceof PublicAuthError && cooldownErr.code === "otp_cooldown", "cooldown error is a public, safe error with retry delay");

  // After the cooldown elapses (simulated), resend works:
  await ageChallengesPastCooldown();
  const resend = await resendOtp({ adminId: issued7!.adminId, meta: META });
  checkEqual(resend.status, "otp_required", "resend after the cooldown issues a new code");

  const code7second = readLatestOtpCode();
  check(code7second !== null && code7second !== code7first, "the new code differs from the previous one");

  // Issuing a new OTP invalidates all previous ones:
  const oldChallenge = await verifyOtp({ challengeId: issued7!.challengeId, adminId: issued7!.adminId, code: code7first!, meta: META });
  check(
    oldChallenge.status === "already_used" || oldChallenge.status === "not_found",
    "the previous code is invalidated when a new OTP is issued",
  );

  // And the new one works:
  const newChallengeRow = await ops
    .from("auth_otp_challenges")
    .select("id")
    .eq("admin_id", issued7!.adminId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const verifyNew = await verifyOtp({ challengeId: newChallengeRow.data!.id, adminId: issued7!.adminId, code: code7second!, meta: META });
  checkEqual(verifyNew.status, "verified", "the freshly resent code verifies");

  /* ==========================================================================
   * 8. FOUR CONSECUTIVE FAILED ATTEMPTS  ->  24h GLOBAL LOCKOUT
   * ========================================================================*/
  section("8. Four consecutive failed authentication attempts -> 24h lockout");

  await resetAuthState();
  const fail = () => submitCredentials({ username: env.ADMIN_USERNAME, password: "definitely-wrong", meta: META });

  const f1 = await fail();
  const f2 = await fail();
  const f3 = await fail();
  checkEqual(f1.status, "invalid_credentials", "failure 1 rejected");
  checkEqual(f2.status, "invalid_credentials", "failure 2 rejected");
  checkEqual(f3.status, "invalid_credentials", "failure 3 rejected");
  check(f3.status === "invalid_credentials" && f3.failuresUntilLockout === 1, "one failure remaining before lockout");

  const f4 = await fail();
  checkEqual(f4.status, "locked", "the FOURTH failed attempt activates the lockout");
  const lockout8 = f4.status === "locked" ? f4.lockout : null;
  check(lockout8 !== null && lockout8.secondsRemaining > 23 * 3600, "lockout lasts ~24 hours");
  const lockedUntil8 = lockout8?.lockedUntil ?? null;

  const state8 = await getLockoutState();
  check(state8.isLocked, "lockout state readable via the service");
  checkEqual(state8.consecutiveFailures, 4, "counter shows 4 consecutive failures");

  /* ==========================================================================
   * 9. GLOBAL LOCKOUT ACROSS DEVICES / BROWSERS
   * ========================================================================*/
  section("9. Lockout is global (database-backed, device-independent)");

  // A completely fresh client ("another device") sees the same lockout:
  const freshDevice = opsClient();
  const { data: rawState } = await freshDevice.rpc("auth_lockout_state");
  check(Boolean((rawState as { is_locked?: boolean })?.is_locked), "a fresh client sees the lockout (no cookie/IP/localStorage involvement)");

  // Further attempts are rejected outright:
  const blocked = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  checkEqual(blocked.status, "locked", "even CORRECT credentials are rejected while locked");

  // ...and failed requests cannot manipulate the timer:
  const before = (await ops.from("security_lockouts").select("locked_until").eq("id", "GLOBAL").maybeSingle()).data?.locked_until;
  await submitCredentials({ username: env.ADMIN_USERNAME, password: "another-wrong", meta: META }).catch(() => undefined);
  const after = (await ops.from("security_lockouts").select("locked_until").eq("id", "GLOBAL").maybeSingle()).data?.locked_until;
  checkEqual(after, before, "failed requests neither extend nor reset the lockout timer");

  // The login flow is unavailable: rendering also reports the lockout.
  const renderState = await getLockoutState();
  check(renderState.isLocked && (renderState.lockedUntil === lockedUntil8), "the lockout deadline is stable across reads");

  /* ==========================================================================
   * 10. AUTOMATIC LOCKOUT EXPIRATION
   * ========================================================================*/
  section("10. Automatic lockout expiration (24h)");

  // Ops manipulation: rewind the deadline.
  await ops
    .from("security_lockouts")
    .update({ locked_until: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", "GLOBAL");

  const expiredState = await getLockoutState();
  check(!expiredState.isLocked, "lockout lifts automatically once the 24h window passes");

  // The consecutive-failure counter was never reset (only a COMPLETE success
  // resets it), so the very next failed attempt re-activates the lockout:
  const afterExpiry = await submitCredentials({ username: env.ADMIN_USERNAME, password: "still-wrong", meta: META });
  checkEqual(afterExpiry.status, "locked", "a failed attempt right after expiry re-activates the lockout (counter persists)");

  // Expire again, then recover COMPLETELY: correct credentials + correct OTP.
  await ops
    .from("security_lockouts")
    .update({ locked_until: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", "GLOBAL");
  await ageChallengesPastCooldown();

  const recovery1 = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  checkEqual(recovery1.status, "otp_required", "correct credentials are accepted again after expiry");
  const recoveryIssued = recovery1.status === "otp_required" ? recovery1.issuedOtp : null;
  const recoveryCode = readLatestOtpCode();
  const recovery2 = await verifyOtp({
    challengeId: recoveryIssued!.challengeId,
    adminId: recoveryIssued!.adminId,
    code: recoveryCode!,
    meta: META,
  });
  checkEqual(recovery2.status, "verified", "the full two-step flow completes after expiry");
  checkEqual((await getLockoutState()).consecutiveFailures, 0, "complete success resets the consecutive-failure counter");

  // With the counter at zero, the administrator has the full budget again:
  const freshBudget = await submitCredentials({ username: env.ADMIN_USERNAME, password: "wrong-again", meta: META });
  check(
    freshBudget.status === "invalid_credentials" && freshBudget.failuresUntilLockout === 3,
    "after a successful sign-in the failure budget is fully restored",
  );

  await resetAuthState();

  /* ==========================================================================
   * 11. SESSION PERSISTENCE
   * ========================================================================*/
  section("11. Session persistence");

  await resetAuthState();
  await ageChallengesPastCooldown();
  const step11 = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  const issued11 = step11.status === "otp_required" ? step11.issuedOtp : null;
  const code11 = readLatestOtpCode();
  const verified11 = await verifyOtp({ challengeId: issued11!.challengeId, adminId: issued11!.adminId, code: code11!, meta: META });
  checkEqual(verified11.status, "verified", "credentials + OTP verified for the session scenario");

  const session11 = await createSession(issued11!.adminId, META);
  const first = await validateSessionToken(session11.token);
  const second = await validateSessionToken(session11.token);
  check(first !== null && second !== null, "the session validates repeatedly (persistence)");
  checkEqual(second?.sessionId, first?.sessionId, "repeated validation resolves the same session row");

  const lifetime = Date.parse(first!.expiresAt) - Date.now();
  check(lifetime > 7.9 * 3600_000 && lifetime < 8.1 * 3600_000, "session applies the 8-hour absolute expiry");

  /* ==========================================================================
   * 12. LOGOUT  ->  session invalidated server-side
   * ========================================================================*/
  section("12. Logout");

  const revoked = await revokeSessionByToken(session11.token);
  checkEqual(revoked, true, "logout revokes the session row");

  const afterLogout = await validateSessionToken(session11.token);
  checkEqual(afterLogout, null, "a logged-out token no longer validates");

  const revokedRow = await ops.from("admin_sessions").select("revoked_at").eq("token_hash", (await import("node:crypto")).createHash("sha256").update(session11.token).digest("hex")).maybeSingle();
  check(revokedRow.data?.revoked_at !== null, "revocation is persisted in the database (survives restarts)");

  const revokeAgain = await revokeSessionByToken(session11.token);
  checkEqual(revokeAgain, false, "double logout is a safe no-op");

  /* ==========================================================================
   * 13. UNAUTHORIZED ACCESS TO PROTECTED ROUTES
   * ========================================================================*/
  section("13. Unauthorized access to protected routes");

  checkEqual(await validateSessionToken(null), null, "no cookie -> no session");
  checkEqual(await validateSessionToken("forged-token-attempt-aaaaaaaaaaaaaaaa"), null, "forged token value -> no session");

  // Insert a fake session row with a random token we DO know to prove only
  // DB-backed tokens validate:
  const forged = "forged".repeat(10);
  await ops.from("admin_sessions").insert({
    admin_id: issued11!.adminId,
    token_hash: (await import("node:crypto")).createHash("sha256").update("different-value").digest("hex"),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  checkEqual(await validateSessionToken(forged), null, "a token whose hash is not in the database fails validation");
  await ops.from("admin_sessions").delete().eq("token_hash", (await import("node:crypto")).createHash("sha256").update("different-value").digest("hex"));

  // HTTP level (against the running dev server):
  const http = (url: string) => {
    try {
      const out = execFileSync(
        "curl",
        ["-s", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", url],
        { encoding: "utf8", timeout: 15_000 },
      ).trim();
      return out;
    } catch (err) {
      return `curl-failed: ${String(err).slice(0, 80)}`;
    }
  };

  const dash = http("http://127.0.0.1:3000/dashboard");
  check(dash.startsWith("307") && dash.includes("/"), `GET /dashboard unauthenticated -> 307 redirect to login (${dash})`);
  const settings = http("http://127.0.0.1:3000/settings");
  check(settings.startsWith("307"), `GET /settings unauthenticated -> 307 redirect to login (${settings})`);
  const root = http("http://127.0.0.1:3000/");
  check(root.startsWith("200"), `GET / -> login page renders (${root})`);

  /* ==========================================================================
   * EXTRA: rate limiting, audit trail, RLS, log hygiene
   * ========================================================================*/
  section("Extras: rate limiting, audit trail, RLS");

  // Atomic fixed-window rate limiter (distinct test key):
  const rlKey = "test:rate-limit-probe";
  await ops.from("rate_limits").delete().eq("key", rlKey);
  const rl1 = await ops.rpc("auth_check_rate_limit", { p_key: rlKey, p_limit: 3, p_window_seconds: 60 });
  const rl2 = await ops.rpc("auth_check_rate_limit", { p_key: rlKey, p_limit: 3, p_window_seconds: 60 });
  const rl3 = await ops.rpc("auth_check_rate_limit", { p_key: rlKey, p_limit: 3, p_window_seconds: 60 });
  const rl4 = await ops.rpc("auth_check_rate_limit", { p_key: rlKey, p_limit: 3, p_window_seconds: 60 });
  check((rl1.data as { allowed: boolean })?.allowed, "rate limit call 1 allowed");
  check((rl2.data as { allowed: boolean })?.allowed, "rate limit call 2 allowed");
  check((rl3.data as { allowed: boolean })?.allowed, "rate limit call 3 allowed");
  check(!(rl4.data as { allowed: boolean })?.allowed, "rate limit call 4 denied");
  check((rl4.data as { retry_after_seconds: number })?.retry_after_seconds > 0, "denial includes a retry-after delay");
  await ops.from("rate_limits").delete().eq("key", rlKey);

  // Audit trail exists and never contains secrets:
  const attempts = await ops.from("auth_attempts").select("attempt_type, outcome, username_attempted, created_at").order("created_at", { ascending: false }).limit(50);
  check((attempts.data?.length ?? 0) > 10, "authentication attempts are recorded in the audit log");
  const hasCredentialFailure = attempts.data?.some((a) => a.attempt_type === "credential" && a.outcome === "failure");
  const hasOtpSuccess = attempts.data?.some((a) => a.attempt_type === "otp" && a.outcome === "success");
  check(Boolean(hasCredentialFailure), "audit log contains credential failures");
  check(Boolean(hasOtpSuccess), "audit log contains OTP successes");

  // RLS: the anon key cannot touch authentication tables:
  const anon = anonClient();
  const anonSelect = await anon.from("admin_accounts").select("id");
  check(Boolean(anonSelect.error) || (anonSelect.data?.length ?? 0) === 0, "anonymous Supabase key cannot read admin_accounts");
  const anonRpc = await anon.rpc("auth_register_failure");
  check(anonRpc.error !== null, "anonymous key cannot invoke security functions");

  // Final state hygiene for repeat runs:
  await resetAuthState();

  finish("INTEGRATION TESTS (13 required scenarios + extras)");
}

main().catch((err) => {
  console.error("Integration test runner crashed:", err);
  process.exit(1);
});
