"use server";

import { EnvConfigError } from "@/lib/config/env";
import { PublicAuthError, RequestBlockedError, SystemAuthError, logAuthError, logAuthEvent } from "@/lib/auth/errors";
import { getSupabaseServiceClient, dbSystemError } from "@/lib/auth/server/db";
import { assertTrustedMutation } from "@/lib/auth/server/request-guard";
import { enforceRateLimit } from "@/lib/auth/server/rate-limit";
import { getSessionContext } from "@/lib/auth/server/context";
import { hashPassword, verifyPassword } from "@/lib/auth/server/password";
import { getAdminById } from "@/lib/auth/service";
import { passwordChangeSchema } from "@/lib/auth/validation";
import { RATE_LIMITS } from "@/lib/constants";
import type { PasswordActionState } from "@/types/firms";

/**
 * Server Action — Account Settings password change.
 *
 *   * Authorization: only the currently authenticated administrator.
 *   * Guard: origin + CSRF double-submit, distributed rate limiting.
 *   * The CURRENT password is verified against the stored Argon2id hash
 *     before anything is written.
 *   * The new password is hashed with Argon2id; plaintext never touches the
 *     database, logs or responses.
 *   * On success the credential source flips from 'env_bootstrap' to
 *     'database' — from then on the environment can never overwrite it.
 *   * All OTHER sessions are revoked server-side; the current session stays
 *     valid so the administrator is not signed out mid-flow.
 */

function mapPasswordError(err: unknown): PasswordActionState {
  if (err instanceof EnvConfigError) {
    return { status: "config_error", message: "Server configuration is incomplete. Please contact your operator." };
  }
  if (err instanceof RequestBlockedError || err instanceof PublicAuthError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof SystemAuthError) {
    return { status: "unavailable", message: err.message };
  }
  logAuthError("password_change_unexpected_error", err);
  return {
    status: "unavailable",
    message: "Account settings are temporarily unavailable. Please try again shortly.",
  };
}

export async function changePasswordAction(
  _prev: PasswordActionState,
  formData: FormData,
): Promise<PasswordActionState> {
  try {
    /* --- Authorization ------------------------------------------------------ */
    const session = await getSessionContext();
    if (!session) {
      return { status: "unauthorized", message: "Your session has expired. Please sign in again." };
    }

    /* --- Origin + CSRF -------------------------------------------------------- */
    await assertTrustedMutation(formData);

    /* --- Rate limit ------------------------------------------------------------- */
    await enforceRateLimit(
      "account:password-change",
      RATE_LIMITS.passwordChange.limit,
      RATE_LIMITS.passwordChange.windowSeconds,
    );

    /* --- Validation ---------------------------------------------------------------- */
    const input = {
      currentPassword: String(formData.get("currentPassword") ?? ""),
      newPassword: String(formData.get("newPassword") ?? ""),
    };
    const confirmPassword = String(formData.get("confirmPassword") ?? "");
    const parsed = passwordChangeSchema.safeParse(input);
    if (!parsed.success) {
      return { status: "error", message: parsed.error.issues[0]?.message ?? "Enter a valid new password." };
    }
    if (confirmPassword !== parsed.data.newPassword) {
      return { status: "error", message: "The new password and the confirmation do not match." };
    }
    if (parsed.data.newPassword === parsed.data.currentPassword) {
      return { status: "error", message: "The new password must be different from your current password." };
    }

    /* --- Verify the current credential ----------------------------------------------- */
    const admin = await getAdminById(session.adminId);
    if (!admin || !admin.is_active) {
      return { status: "unavailable", message: "Account settings are temporarily unavailable. Please try again shortly." };
    }
    const currentOk = await verifyPassword(parsed.data.currentPassword, admin.password_hash);
    if (!currentOk) {
      logAuthEvent("password_change_rejected_wrong_current", { admin_id: session.adminId });
      return { status: "error", message: "Your current password is incorrect." };
    }

    /* --- Persist the new Argon2id hash ----------------------------------------------- */
    const passwordHash = await hashPassword(parsed.data.newPassword);
    const db = getSupabaseServiceClient();
    const { error: updateError } = await db
      .from("admin_accounts")
      .update({
        password_hash: passwordHash,
        credentials_source: "database",
        password_updated_at: new Date().toISOString(),
      })
      .eq("id", session.adminId);
    if (updateError) {
      throw dbSystemError("admin_accounts.update", updateError);
    }

    /* --- Revoke every OTHER session ---------------------------------------------------- */
    const { error: revokeError } = await db
      .from("admin_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("admin_id", session.adminId)
      .neq("id", session.sessionId)
      .is("revoked_at", null);
    if (revokeError) {
      // Non-fatal: the password is already updated. Log and continue.
      logAuthError("password_change_session_revoke_failed", dbSystemError("admin_sessions.update", revokeError));
    }

    logAuthEvent("password_changed", { admin_id: session.adminId });
    return {
      status: "success",
      message: "Password updated. All other sessions have been signed out.",
    };
  } catch (err) {
    return mapPasswordError(err);
  }
}
