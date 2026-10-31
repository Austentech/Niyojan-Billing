import { z } from "zod";

import { getServerEnv } from "@/lib/config/env";
import { getSupabaseServiceClient } from "@/lib/auth/server/db";
import { dummyVerify, verifyPassword } from "@/lib/auth/server/password";
import { generateOtpCode, hashOtpCode } from "@/lib/auth/server/otp";
import { getLockoutState, registerAuthFailure, registerAuthSuccess } from "@/lib/auth/server/lockout";
import { enforceRateLimit } from "@/lib/auth/server/rate-limit";
import { sendOtpEmail } from "@/lib/auth/server/email";
import { logAuthAttempt } from "@/lib/auth/server/audit";
import { ensureAdminBootstrapped } from "@/lib/auth/server/bootstrap";
import { PublicAuthError, SystemAuthError, logAuthEvent } from "@/lib/auth/errors";
import { loginSchema, otpSchema } from "@/lib/auth/validation";
import { maskEmail, type AdminAccountRow, type AuthAttemptMeta, type IssuedOtp, type LockoutState, type OtpConsumeStatus } from "@/lib/auth/types";
import { LOCKOUT_FAILURE_THRESHOLD, OTP_ISSUE_HOURLY_LIMIT, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_SECONDS, OTP_TTL_SECONDS, RATE_LIMITS } from "@/lib/constants";

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

async function getAdminByUsername(username: string): Promise<AdminAccountRow | null> {
  const { data, error } = await getSupabaseServiceClient()
    .from("admin_accounts")
    .select("*")
    .eq("username", username.trim().toLowerCase())
    .maybeSingle<AdminAccountRow>();
  if (error) {
    throw new SystemAuthError(`admin lookup failed (${error.code ?? ""})`);
  }
  return data ?? null;
}

async function getAdminById(adminId: string): Promise<AdminAccountRow | null> {
  const { data, error } = await getSupabaseServiceClient()
    .from("admin_accounts")
    .select("*")
    .eq("id", adminId)
    .maybeSingle<AdminAccountRow>();
  if (error) {
    throw new SystemAuthError(`admin lookup failed (${error.code ?? ""})`);
  }
  return data ?? null;
}

/** Issue a fresh OTP challenge for an administrator (invalidates previous ones). */
async function issueOtpForAdmin(admin: AdminAccountRow): Promise<IssuedOtp> {
  const db = getSupabaseServiceClient();

  // Rate limit: hard cap of OTP emails per rolling hour.
  await enforceRateLimit("auth:otp-issue", OTP_ISSUE_HOURLY_LIMIT, 60 * 60);

  // Controlled cooldown between consecutive OTP issues (resend protection).
  const { data: lastChallenge, error: lastError } = await db
    .from("auth_otp_challenges")
    .select("id, created_at")
    .eq("admin_id", admin.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; created_at: string }>();
  if (lastError) {
    throw new SystemAuthError(`otp cooldown lookup failed (${lastError.code ?? ""})`);
  }
  if (lastChallenge) {
    const elapsed = (Date.now() - Date.parse(lastChallenge.created_at)) / 1000;
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
  await db.rpc("auth_invalidate_pending_otps", { p_admin_id: admin.id });

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000).toISOString();

  const { data: challenge, error: insertError } = await db
    .from("auth_otp_challenges")
    .insert({
      admin_id: admin.id,
      code_hash: hashOtpCode(code),
      expires_at: expiresAt,
      max_attempts: OTP_MAX_ATTEMPTS,
    })
    .select("id, expires_at")
    .single<{ id: string; expires_at: string }>();
  if (insertError || !challenge) {
    throw new SystemAuthError("otp challenge insert failed");
  }

  try {
    await sendOtpEmail(admin.email, code);
  } catch (err) {
    // Fail CLOSED: an undeliverable code must not remain active.
    await db.from("auth_otp_challenges").delete().eq("id", challenge.id);
    throw err;
  }

  return {
    challengeId: challenge.id,
    adminId: admin.id,
    expiresAt: challenge.expires_at,
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

  const { data, error } = await getSupabaseServiceClient().rpc("auth_consume_otp", {
    p_challenge_id: input.challengeId,
    p_admin_id: input.adminId,
    p_code_hash: hashOtpCode(code.data),
  });
  if (error) {
    throw new SystemAuthError(`otp consume failed (${error.code ?? ""})`);
  }
  const consumeStatus = ((data ?? {}) as { status?: string }).status as OtpConsumeStatus;

  if (consumeStatus !== "verified") {
    const failureState = await registerAuthFailure();
    await logAuthAttempt({
      attemptType: "otp",
      outcome: "failure",
      adminId: input.adminId,
      meta: input.meta,
    });
    if (failureState.isLocked) return { status: "locked", lockout: failureState };
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

  // Best-effort bookkeeping.
  void getSupabaseServiceClient()
    .from("admin_accounts")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", admin.id)
    .then(({ error: err }) => {
      if (err) logAuthEvent("last_login_update_failed", { code: err.code ?? "" });
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
 * staging test suite and operator disaster recovery (run via the service key
 * from a trusted shell). There is deliberately NO public endpoint that calls
 * this — a lockout can never be reset from the browser.
 */
export async function resetGlobalAuthStateForTests(): Promise<void> {
  const db = getSupabaseServiceClient();
  await db.from("security_lockouts").delete().eq("id", "GLOBAL");
  await db.from("rate_limits").delete().like("key", "auth:%");
}
