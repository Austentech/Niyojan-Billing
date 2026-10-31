/** Shared types for the Phase 1 authentication system. */

export interface AdminAccountRow {
  id: string;
  username: string;
  email: string;
  display_name: string;
  password_hash: string;
  credentials_source: "env_bootstrap" | "database";
  password_updated_at: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LockoutState {
  isLocked: boolean;
  /** ISO timestamp (UTC) or null. */
  lockedUntil: string | null;
  /** Whole seconds until the lockout expires (0 when not locked). */
  secondsRemaining: number;
  consecutiveFailures: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export interface AuthAttemptMeta {
  /** Best-effort client IP (validated), or null. Never trusted for security decisions. */
  ipAddress: string | null;
  /** Truncated user agent, or null. */
  userAgent: string | null;
}

export interface SessionContext {
  sessionId: string;
  adminId: string;
  displayName: string;
  username: string;
  email: string;
  /** ISO timestamp (UTC). */
  createdAt: string;
  /** ISO timestamp (UTC). */
  expiresAt: string;
}

export interface IssuedOtp {
  challengeId: string;
  /** Owner admin id — used only to sign the pre-OTP cookie; never sent to the client. */
  adminId: string;
  /** ISO timestamp (UTC). */
  expiresAt: string;
  emailMasked: string;
  resendCooldownSeconds: number;
}

/** Consume result mirroring the auth_consume_otp() database function. */
export type OtpConsumeStatus =
  | "verified"
  | "invalid"
  | "expired"
  | "already_used"
  | "too_many_attempts"
  | "not_found";

/** Mask an email for display: "deepak@niyojan.com" -> "d•••••@niyojan.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••@•••";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const visible = local.slice(0, 1);
  return `${visible}${"•".repeat(Math.max(local.length - 1, 2))}${domain}`;
}
