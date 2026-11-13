import { getDb } from "@/lib/db";
import { authAttempts, securityAuditLogs } from "@/lib/db/schema";
import { logAuthError } from "@/lib/auth/errors";
import type { AuthAttemptMeta } from "@/lib/auth/types";

/**
 * Append-only audit trail (auth_attempts) + security event log
 * (security_audit_logs).
 *
 * auth_attempts records ONLY: attempt type, outcome, admin id, attempted
 * username, validated IP, truncated user agent and the timestamp. Passwords,
 * OTP codes and hashes are NEVER written here. Logging is best-effort: an
 * audit failure must never block (or silently allow) an authentication
 * decision.
 *
 * security_audit_logs records sanitized significant EVENTS (logins,
 * lockouts, credential and profile changes) for the security review trail.
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
    await getDb().insert(authAttempts).values({
      attemptType: input.attemptType,
      outcome: input.outcome,
      adminId: input.adminId ?? null,
      usernameAttempted: username,
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
    });
  } catch (err) {
    logAuthError("audit_insert_failed", err);
  }
}

/** Best-effort sanitized security EVENT for the review trail. */
export async function logSecurityEvent(
  event: string,
  input: {
    adminId?: string | null;
    meta?: AuthAttemptMeta | null;
    /** Sanitized scalar metadata only — never secrets, codes or hashes. */
    detail?: Record<string, string | number | boolean | null>;
  } = {},
): Promise<void> {
  try {
    await getDb().insert(securityAuditLogs).values({
      event,
      actorAdminId: input.adminId ?? null,
      ipAddress: input.meta?.ipAddress ?? null,
      userAgent: input.meta?.userAgent ?? null,
      detail: input.detail ?? null,
    });
  } catch (err) {
    logAuthError("security_event_insert_failed", err);
  }
}
