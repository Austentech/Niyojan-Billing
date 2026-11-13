import { desc, eq, sql } from "drizzle-orm";

import { getDb, getSql, toIso } from "@/lib/db";
import { adminAccounts, authOtpChallenges } from "@/lib/db/schema";
import { getServerEnv } from "@/lib/config/env";
import { dbSystemError } from "@/lib/auth/server/db";
import { dummyVerify, verifyPassword } from "@/lib/auth/server/password";
import { generateOtpCode, hashOtpCode } from "@/lib/auth/server/otp";
import { getLockoutState, registerAuthFailure, registerAuthSuccess } from "@/lib/auth/server/lockout";
import { enforceRateLimit } from "@/lib/auth/server/rate-limit";
import { sendOtpEmail } from "@/lib/auth/server/email";
import { logAuthAttempt, logSecurityEvent } from "@/lib/auth/server/audit";
import { ensureAdminBootstrapped } from "@/lib/auth/server/bootstrap";
import { PublicAuthError, SystemAuthError, logAuthEvent } from "@/lib/auth/errors";
import { loginSchema, otpSchema } from "@/lib/auth/validation";
import { maskEmail, type AdminAccountRow, type AuthAttemptMeta, type IssuedOtp, type LockoutState, type OtpConsumeStatus } from "@/lib/auth/types";
import { LOCKOUT_FAILURE_THRESHOLD, OTP_ISSUE_HOURLY_LIMIT, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_SECONDS, OTP_TTL_SECONDS } from "@/lib/constants";

/**
 * Authentication flow engine (framework-independent — every function takes
 * explicit inputs, no request context, so the full flow is unit-testable).
 *
 * STEP 1  submitCredentials : username + password -> OTP issued & emailed.
 * STEP 2  verifyOtp         : 8-char code        -> session-eligible.
 *
 * SECURITY INVARIANTS
 *   * Credential failures and OTP failures BOTH count toward the global
 *     lockout (4 consecutive failures -> 24h, database-atomic).
 *   * Error responses never reveal whether the username or the password was
 *     wrong; response timing is equalized with a dummy Argon2id verification.
 *   * The OTP plaintext never leaves this module except into the email body.
 */

/* --- Internal helpers -------------------------------------------------------- */

type AdminRow = typeof adminAccounts.$inferSelect;

/** Convert a Drizzle row into the stable snake_case service row type. */
function toAdminRow(r: AdminRow): AdminAccountRow {
  return {
    id: r.id,
    username: r.username,
    email: r.email,
    display_name: r.displayName,
    password_hash: r.passwordHash,
    credentials_source: r.credentialsSource === "database" ? "database" : "env_bootstrap",
    password_updated_at: toIso(r.passwordUpdatedAt) ?? new Date().toISOString(),
    is_active: r.isActive,
    last_login_at: toIso(r.lastLoginAt),
    created_at: toIso(r.createdAt) ?? new Date().toISOString(),
    updated_at: toIso(r.updatedAt) ?? new Date().toISOString(),
  };
}

/** Fetch an administrator account by username (exact, lowercased). */
export async function getAdminByUsername(username: string): Promise<AdminAccountRow | null> {
  try {
    const rows = await getDb()
      .select()
      .from(adminAccounts)
      .where(eq(adminAccounts.username, username.trim().toLowerCase()))
      .limit(1);
    return rows[0] ? toAdminRow(rows[0]) : null;
  } catch (err) {
    throw dbSystemError("admin_accounts.select", err);
  }
}

/** Fetch an administrator account by id (used by flows and account settings). */
export async function getAdminById(adminId: string): Promise<AdminAccountRow | null> {
  try {
    const rows = await getDb().select().from(adminAccounts).where(eq(adminAccounts.id, adminId)).limit(1);
    return rows[0] ? toAdminRow(rows[0]) : null;
  } catch (err) {
    throw dbSystemError("admin_accounts.select", err);
  }
}

/** Issue a fresh OTP challenge for an administrator (invalidates previous ones). */
async function issueOtpForAdmin(admin: AdminAccountRow): Promise<IssuedOtp> {
  const db = getDb();

  // Rate limit: hard cap of OTP emails per rolling hour.
  await enforceRateLimit("auth:otp-issue", OTP_ISSUE_HOURLY_LIMIT, 60 * 60);

  // Controlled cooldown between consecutive OTP issues (resend protection).
  let lastChallenge: { createdAt: Date } | undefined;
  try {
    const rows = await db
      .select({ createdAt: authOtpChallenges.createdAt })
      .from(authOtpChallenges)
      .where(eq(authOtpChallenges.adminId, admin.id))
      .orderBy(desc(authOtpChallenges.createdAt))
      .limit(1);
    lastChallenge = rows[0];
  } catch (err) {
    throw dbSystemError("auth_otp_challenges.select", err);
  }
  if (lastChallenge) {
    const elapsed = (Date.now() - lastChallenge.createdAt.getTime()) / 1000;
    const wait = Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsed);
    if (wait > 0) {
      throw new PublicAuthError(
        `Please wait ${wait} second${wait === 1 ? "" : "s"} before requesting a new code.`,
        "otp_cooldown",
        wait,
      );
    }
  }

  // Issuing a new code invalidates every previous unconsumed challenge.
  try {
    await getSql()`select auth_invalidate_pending_otps(${admin.id}::uuid)`;
  } catch (err) {
    throw dbSystemError("auth_invalidate_pending_otps", err);
  }

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

  let challenge: { id: string; expiresAt: Date } | undefined;
  try {
    const rows = await db
      .insert(authOtpChallenges)
      .values({
        adminId: admin.id,
        codeHash: hashOtpCode(code),
        expiresAt,
        maxAttempts: OTP_MAX_ATTEMPTS,
      })
      .returning({ id: authOtpChallenges.id, expiresAt: authOtpChallenges.expiresAt });
    challenge = rows[0];
  } catch (err) {
    throw dbSystemError("auth_otp_challenges.insert", err);
  }
  if (!challenge) {
    throw new SystemAuthError("otp challenge insert failed");
  }

  try {
    await sendOtpEmail(admin.email, code);
  } catch (err) {
    // Fail CLOSED: an undeliverable code must not remain active.
    await db.delete(authOtpChallenges).where(eq(authOtpChallenges.id, challenge.id)).catch(() => undefined);
    throw err;
  }

  return {
    challengeId: challenge.id,
    adminId: admin.id,
    expiresAt: challenge.expiresAt.toISOString(),
    emailMasked: maskEmail(admin.email),
    resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

/* --- STEP 1: credential verification + OTP issuance ---------------------------- */

export type SubmitCredentialsResult =
  | { status: "otp_required"; issuedOtp: IssuedOtp }
  | { status: "invalid_credentials"; failuresUntilLockout: number }
  | { status: "locked"; lockout: LockoutState };

export async function submitCredentials(input: {
  username: string;
  password: string;
  meta: AuthAttemptMeta;
}): Promise<SubmitCredentialsResult> {
  // Environment must be complete before anything touches credentials.
  getServerEnv();

  // Fail CLOSED on the authoritative lockout check (throws SystemAuthError
  // when the database is unreachable — no credential verification proceeds).
  const lockout = await getLockoutState();
  if (lockout.isLocked) {
    return { status: "locked", lockout };
  }

  const parsed = loginSchema.safeParse({ username: input.username, password: input.password });
  if (!parsed.success) {
    // Malformed input is not an authentication attempt: rejected without
    // touching the failure counter (rate limiting still applies upstream).
    return { status: "invalid_credentials", failuresUntilLockout: LOCKOUT_FAILURE_THRESHOLD };
  }
  const username = parsed.data.username.trim().toLowerCase();

  // Bootstrap is idempotent and never overwrites an existing account.
  await ensureAdminBootstrapped();

  const admin = await getAdminByUsername(username);
  const passwordOk = admin
    ? await verifyPassword(parsed.data.password, admin.password_hash)
    : await dummyVerify(parsed.data.password);

  if (!admin || !passwordOk || !admin.is_active) {
    // Generic outcome: never reveals whether the username or the password
    // was wrong (timing equalized above).
    const failureState = await registerAuthFailure();
    await logAuthAttempt({
      attemptType: "credential",
      outcome: "failure",
      adminId: admin?.id ?? null,
      usernameAttempted: username,
      meta: input.meta,
    });
    if (failureState.isLocked) {
      await logSecurityEvent("lockout_activated", {
        adminId: admin?.id ?? null,
        meta: input.meta,
        detail: { failures: failureState.consecutiveFailures },
      });
      return { status: "locked", lockout: failureState };
    }
    return {
      status: "invalid_credentials",
      failuresUntilLockout: Math.max(LOCKOUT_FAILURE_THRESHOLD - failureState.consecutiveFailures, 0),
    };
  }

  // Credentials verified — issue the OTP (Step 2 gate).
  const issuedOtp = await issueOtpForAdmin(admin);
  await logAuthAttempt({
    attemptType: "credential",
    outcome: "success",
    adminId: admin.id,
    usernameAttempted: username,
    meta: input.meta,
  });
  return { status: "otp_required", issuedOtp };
}

/* --- STEP 2: OTP verification --------------------------------------------------- */

export type VerifyOtpResult =
  | { status: "verified"; admin: AdminAccountRow }
  | { status: "locked"; lockout: LockoutState }
  | { status: Exclude<OtpConsumeStatus, "verified"> };

export async function verifyOtp(input: {
  challengeId: string;
  adminId: string;
  code: string;
  meta: AuthAttemptMeta;
}): Promise<VerifyOtpResult> {
  // Fail CLOSED on the authoritative lockout check.
  const lockout = await getLockoutState();
  if (lockout.isLocked) {
    return { status: "locked", lockout };
  }

  const code = otpSchema.safeParse(input.code);
  if (!code.success) {
    // Malformed input — same treatment as a wrong code, but without burning
    // an attempt slot of the challenge (the database never sees it).
    const failureState = await registerAuthFailure();
    await logAuthAttempt({
      attemptType: "otp",
      outcome: "failure",
      adminId: input.adminId,
      meta: input.meta,
    });
    if (failureState.isLocked) return { status: "locked", lockout: failureState };
    return { status: "invalid" };
  }

  let consumeStatus: OtpConsumeStatus;
  try {
    const sql = getSql();
    const rows = await sql<{ result: { status?: string } }[]>`
      select auth_consume_otp(${input.challengeId}::uuid, ${input.adminId}::uuid, ${hashOtpCode(code.data)}::text) as result
    `;
    consumeStatus = (rows[0]?.result?.status ?? "not_found") as OtpConsumeStatus;
  } catch (err) {
    throw dbSystemError("auth_consume_otp", err);
  }

  if (consumeStatus !== "verified") {
    const failureState = await registerAuthFailure();
    await logAuthAttempt({
      attemptType: "otp",
      outcome: "failure",
      adminId: input.adminId,
      meta: input.meta,
    });
    if (failureState.isLocked) {
      await logSecurityEvent("lockout_activated", {
        adminId: input.adminId,
        meta: input.meta,
        detail: { failures: failureState.consecutiveFailures },
      });
      return { status: "locked", lockout: failureState };
    }
    return { status: consumeStatus };
  }

  // COMPLETE authentication — reset the consecutive-failure counter.
  await registerAuthSuccess();
  await logAuthAttempt({
    attemptType: "otp",
    outcome: "success",
    adminId: input.adminId,
    meta: input.meta,
  });

  const admin = await getAdminById(input.adminId);
  if (!admin || !admin.is_active) {
    throw new SystemAuthError("admin account disappeared during verification");
  }

  // last_login_at: ONLY a complete (OTP-verified) login updates it.
  void getDb()
    .update(adminAccounts)
    .set({ lastLoginAt: new Date() })
    .where(eq(adminAccounts.id, admin.id))
    .catch((err: unknown) => {
      logAuthEvent("last_login_update_failed", { code: (err as { code?: string })?.code ?? "" });
    });
  await logSecurityEvent("login_success", {
    adminId: admin.id,
    meta: input.meta,
    detail: { username: admin.username },
  });

  return { status: "verified", admin };
}

/* --- OTP resend ---------------------------------------------------------------- */

export type ResendOtpResult =
  | { status: "otp_required"; issuedOtp: IssuedOtp }
  | { status: "locked"; lockout: LockoutState };

export async function resendOtp(input: {
  adminId: string;
  meta: AuthAttemptMeta;
}): Promise<ResendOtpResult> {
  const lockout = await getLockoutState();
  if (lockout.isLocked) {
    return { status: "locked", lockout };
  }

  const admin = await getAdminById(input.adminId);
  if (!admin || !admin.is_active) {
    // Admin vanished mid-flow: force the user back to Step 1.
    throw new PublicAuthError("Your verification session is no longer valid. Please sign in again.", "preauth_invalid");
  }

  const issuedOtp = await issueOtpForAdmin(admin);
  return { status: "otp_required", issuedOtp };
}

/* --- Test/operations hooks (NEVER exposed through any HTTP route) --------------- */

/**
 * Destructive reset of global authentication state. Exists ONLY for the
 * staging test suite and operator disaster recovery (run from a trusted
 * shell with database access). There is deliberately NO public endpoint that
 * calls this — a lockout can never be reset from the browser.
 */
export async function resetGlobalAuthStateForTests(): Promise<void> {
  const db = getDb();
  await db.execute(sql`delete from public.security_lockouts where id = 'GLOBAL'`);
  await db.execute(sql`delete from public.rate_limits where key like 'auth:%'`);
}

/** Exposed for the account layer and tests: same reset under a scoped name. */
export const resetRateLimitsForTests = resetGlobalAuthStateForTests;
