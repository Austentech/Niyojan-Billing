import { getSupabaseServiceClient } from "@/lib/auth/server/db";
import { logAuthError } from "@/lib/auth/errors";
import type { AuthAttemptMeta } from "@/lib/auth/types";

/**
 * Append-only audit trail (auth_attempts).
 *
 * Records ONLY: attempt type, outcome, admin id, attempted username,
 * validated IP, truncated user agent and the timestamp. Passwords, OTP codes
 * and hashes are NEVER written here. Logging is best-effort: an audit
 * failure must never block (or silently allow) an authentication decision.
 */

export async function logAuthAttempt(input: {
  attemptType: "credential" | "otp";
  outcome: "failure" | "success";
  adminId?: string | null;
  usernameAttempted?: string | null;
  meta: AuthAttemptMeta;
}): Promise<void> {
  try {
    const username = input.usernameAttempted?.trim().toLowerCase().slice(0, 64) || null;
    const { error } = await getSupabaseServiceClient().from("auth_attempts").insert({
      attempt_type: input.attemptType,
      outcome: input.outcome,
      admin_id: input.adminId ?? null,
      username_attempted: username,
      ip_address: input.meta.ipAddress,
      user_agent: input.meta.userAgent,
    });
    if (error) {
      logAuthError("audit_insert_failed", { message: error.message, code: error.code ?? "" });
    }
  } catch (err) {
    logAuthError("audit_insert_failed", err);
  }
}
