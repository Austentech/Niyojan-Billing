"use server";

import { redirect } from "next/navigation";

import { EnvConfigError } from "@/lib/config/env";
import { PublicAuthError, RequestBlockedError, SystemAuthError, logAuthError } from "@/lib/auth/errors";
import { submitCredentials, verifyOtp, resendOtp } from "@/lib/auth/service";
import { createSession, revokeSessionByToken, signPreauthPayload } from "@/lib/auth/server/session";
import {
  clearPreauthCookie,
  clearSessionCookie,
  readPreauthCookie,
  readSessionCookie,
  setPreauthCookie,
  setSessionCookie,
} from "@/lib/auth/server/cookies";
import { assertTrustedMutation, getClientMeta } from "@/lib/auth/server/request-guard";
import { enforceRateLimit } from "@/lib/auth/server/rate-limit";
import type { LockoutState } from "@/lib/auth/types";
import type { LoginActionState, OtpActionState } from "@/types/auth";
import { RATE_LIMITS } from "@/lib/constants";

/**
 * Server Actions — the ONLY state-changing authentication endpoints.
 *
 * Every action, in order:
 *   1. validates origin + CSRF double-submit token (assertTrustedMutation),
 *   2. applies server-side rate limiting (PostgreSQL atomic counters),
 *   3. delegates to the pure flow engine (src/lib/auth/service.ts),
 *   4. maps outcomes to safe client states (never usernames, codes, ids).
 *
 * All errors funnel through `mapActionError`: PublicAuthError and
 * SystemAuthError messages are safe by construction; anything unexpected is
 * logged server-side (with sanitized detail) and replaced by a generic
 * message before it can reach the client.
 */

function lockoutState(lockout: LockoutState) {
  return { lockedUntil: lockout.lockedUntil, secondsRemaining: lockout.secondsRemaining };
}

function mapLoginError(err: unknown): LoginActionState {
  if (err instanceof EnvConfigError) {
    return {
      status: "config_error",
      message:
        "Authentication is not configured on this server yet: required environment variables are missing or invalid. " +
        "An operator must complete the server configuration (see .env.example) before sign-in is possible.",
    };
  }
  if (err instanceof RequestBlockedError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof PublicAuthError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof SystemAuthError) {
    return { status: "unavailable", message: err.message };
  }
  logAuthError("login_action_unexpected_error", err);
  return {
    status: "unavailable",
    message: "Authentication service is temporarily unavailable. Please try again shortly.",
  };
}

function mapOtpError(err: unknown): OtpActionState {
  if (err instanceof EnvConfigError) {
    return { status: "config_error", message: "Server configuration is incomplete. Please contact your operator." };
  }
  if (err instanceof RequestBlockedError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof PublicAuthError) {
    // otp_cooldown -> transient block; preauth_invalid -> back to Step 1.
    const status = err.code === "preauth_invalid" ? "preauth_expired" : "blocked";
    return { status, message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof SystemAuthError) {
    return { status: "unavailable", message: err.message };
  }
  logAuthError("otp_action_unexpected_error", err);
  return {
    status: "unavailable",
    message: "Authentication service is temporarily unavailable. Please try again shortly.",
  };
}

/* ============================================================================
 * STEP 1 — credential verification (username + password -> OTP dispatched)
 * ==========================================================================*/

export async function loginAction(_prev: LoginActionState, formData: FormData): Promise<LoginActionState> {
  try {
    // First env-touching call (enforceRateLimit -> service client) throws
    // EnvConfigError when configuration is incomplete -> mapped to a
    // fail-closed config_error state below.
    await assertTrustedMutation(formData);
    await enforceRateLimit("auth:login-submit", RATE_LIMITS.loginSubmit.limit, RATE_LIMITS.loginSubmit.windowSeconds);

    const meta = await getClientMeta();
    const result = await submitCredentials({
      username: String(formData.get("username") ?? ""),
      password: String(formData.get("password") ?? ""),
      meta,
    });

    switch (result.status) {
      case "otp_required": {
        // Bind Step 2 to this verified credential check: HttpOnly, HMAC-signed,
        // short-lived. Carries only {challengeId, adminId, exp}.
        await setPreauthCookie(
          signPreauthPayload({ cid: result.issuedOtp.challengeId, aid: result.issuedOtp.adminId }),
        );
        return {
          status: "otp_required",
          emailMasked: result.issuedOtp.emailMasked,
          expiresAt: result.issuedOtp.expiresAt,
          resendCooldownSeconds: result.issuedOtp.resendCooldownSeconds,
        };
      }
      case "invalid_credentials": {
        const remaining = result.failuresUntilLockout;
        return {
          status: "invalid_credentials",
          message: "Invalid credentials.",
          failuresUntilLockout: remaining,
        };
      }
      case "locked":
        return { status: "locked", ...lockoutState(result.lockout) };
    }
  } catch (err) {
    return mapLoginError(err);
  }
}

/* ============================================================================
 * STEP 2 — OTP verification (8-char code -> authenticated session)
 * ==========================================================================*/

export async function verifyOtpAction(_prev: OtpActionState, formData: FormData): Promise<OtpActionState> {
  let redirectToDashboard = false;

  try {
    await assertTrustedMutation(formData);
    await enforceRateLimit("auth:otp-verify", RATE_LIMITS.otpVerify.limit, RATE_LIMITS.otpVerify.windowSeconds);

    const preauth = await readPreauthCookie();
    if (!preauth) {
      return {
        status: "preauth_expired",
        message: "Your verification session has expired. Please sign in again.",
      };
    }

    const meta = await getClientMeta();
    const result = await verifyOtp({
      challengeId: preauth.cid,
      adminId: preauth.aid,
      code: String(formData.get("code") ?? ""),
      meta,
    });

    switch (result.status) {
      case "verified": {
        // Fresh 256-bit token per login (session-fixation prevention).
        const session = await createSession(result.admin.id, meta);
        await setSessionCookie(session.token);
        await clearPreauthCookie();
        redirectToDashboard = true;
        return { status: "idle" };
      }
      case "locked":
        return { status: "locked", ...lockoutState(result.lockout) };
      case "expired":
        return {
          status: "error",
          kind: "expired",
          message: "That code has expired. Request a new one and try again.",
        };
      case "already_used":
        return {
          status: "error",
          kind: "already_used",
          message: "That code has already been used. Request a new one to continue.",
        };
      case "too_many_attempts":
        return {
          status: "error",
          kind: "too_many_attempts",
          message: "Too many incorrect attempts for this code. Request a new one to continue.",
        };
      case "not_found":
        return {
          status: "preauth_expired",
          message: "Your verification session is no longer valid. Please sign in again.",
        };
      case "invalid":
      default:
        return {
          status: "error",
          kind: "invalid",
          message: "Incorrect verification code. Check the email and try again.",
        };
    }
  } catch (err) {
    return mapOtpError(err);
  } finally {
    if (redirectToDashboard) {
      // Executed after the state is returned: navigation is deferred so the
      // thrown redirect can never be swallowed by the error mapping above.
      redirect("/dashboard");
    }
  }
}

/* ============================================================================
 * OTP resend — cooldown + hourly cap enforced in the service layer
 * ==========================================================================*/

export async function resendOtpAction(_prev: OtpActionState, formData: FormData): Promise<OtpActionState> {
  try {
    await assertTrustedMutation(formData);

    const preauth = await readPreauthCookie();
    if (!preauth) {
      return {
        status: "preauth_expired",
        message: "Your verification session has expired. Please sign in again.",
      };
    }

    const meta = await getClientMeta();
    const result = await resendOtp({ adminId: preauth.aid, meta });

    switch (result.status) {
      case "otp_required": {
        await setPreauthCookie(signPreauthPayload({ cid: result.issuedOtp.challengeId, aid: preauth.aid }));
        return {
          status: "otp_required",
          emailMasked: result.issuedOtp.emailMasked,
          expiresAt: result.issuedOtp.expiresAt,
          resendCooldownSeconds: result.issuedOtp.resendCooldownSeconds,
          message: "A new verification code has been sent.",
        };
      }
      case "locked":
        return { status: "locked", ...lockoutState(result.lockout) };
    }
  } catch (err) {
    return mapOtpError(err);
  }
}

/* ============================================================================
 * Logout — revoke the session server-side, then clear the cookie
 * ==========================================================================*/

export async function logoutAction(formData: FormData): Promise<void> {
  try {
    await assertTrustedMutation(formData);
    const token = await readSessionCookie();
    if (token) {
      await revokeSessionByToken(token);
    }
  } catch (err) {
    // Even a blocked guard must not strand an invalid session cookie.
    logAuthError("logout_guard_rejected", err, { fallback: "cookie-cleared" });
  } finally {
    await clearSessionCookie();
    redirect("/");
  }
}
