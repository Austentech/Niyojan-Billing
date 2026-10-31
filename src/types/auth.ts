/**
 * Client-visible server-action states (Phase 1 authentication).
 * Serialized across the server/client boundary — must stay free of any
 * server-only imports. Contains ONLY safe display information: no OTP codes,
 * no usernames, no challenge/admin ids.
 */

export interface OtpScreenData {
  emailMasked: string;
  /** ISO timestamp (UTC) of OTP expiry. */
  expiresAt: string;
  resendCooldownSeconds: number;
}

export type LoginActionState =
  | { status: "idle" }
  /** Credentials rejected — the message never says whether username or password failed. */
  | { status: "invalid_credentials"; message: string; failuresUntilLockout: number }
  /** Credentials accepted, OTP dispatched — advance to Step 2. */
  | { status: "otp_required" } & OtpScreenData
  /** GLOBAL lockout active — the login form is unavailable. */
  | { status: "locked"; lockedUntil: string | null; secondsRemaining: number }
  /** Origin/CSRF/rate-limit rejection. */
  | { status: "blocked"; message: string; retryAfterSeconds?: number }
  /** Transient system failure (database/SMTP unreachable). */
  | { status: "unavailable"; message: string }
  /** Server environment not yet configured. */
  | { status: "config_error"; message: string };

export type OtpErrorKind = "invalid" | "expired" | "already_used" | "too_many_attempts" | "not_found" | "generic";

export type OtpActionState =
  | { status: "idle" }
  | { status: "error"; message: string; kind: OtpErrorKind }
  /** A new code was issued (resend) — restart timers. */
  | { status: "otp_required" } & OtpScreenData & { message?: string }
  | { status: "locked"; lockedUntil: string | null; secondsRemaining: number }
  /** The signed Step 1 cookie expired — return to the login form. */
  | { status: "preauth_expired"; message: string }
  | { status: "blocked"; message: string; retryAfterSeconds?: number }
  | { status: "unavailable"; message: string }
  | { status: "config_error"; message: string };
