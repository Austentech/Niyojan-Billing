/** Central application constants. */

export const BRAND = {
  name: "Niyojan Corporation",
  shortName: "Niyojan",
  tagline: "Structural Growth. Trusted Control.",
  systemName: "Centralized Financial & Billing Management System",
} as const;

/* ============================================================================
 * AUTHENTICATION SECURITY POLICY (Phase 1)
 * All values are enforced SERVER-SIDE. Client copies exist only for UX
 * (countdowns, hints) and are never a source of truth.
 * ==========================================================================*/

/** OTP: length and charset (uppercase letters + digits, ambiguous glyphs removed). */
export const OTP_LENGTH = 8;
export const OTP_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** OTP validity window (seconds) — enforced by the database (expires_at). */
export const OTP_TTL_SECONDS = 5 * 60;

/** OTP verification attempts allowed per challenge before it is dead. */
export const OTP_MAX_ATTEMPTS = 5;

/** Minimum delay between OTP (re)issues — cooldown, database-enforced. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** Hard cap on OTP issuance per rolling hour (rate limit). */
export const OTP_ISSUE_HOURLY_LIMIT = 6;

/**
 * Global consecutive-failure lockout: the 4th consecutive failed
 * authentication attempt (credential OR OTP failure) activates a 24h
 * lockout. Server-side, database-atomic, device-independent.
 */
export const LOCKOUT_FAILURE_THRESHOLD = 4;
export const LOCKOUT_DURATION_HOURS = 24;

/** Rate limits (rolling windows, PostgreSQL atomic counters). */
export const RATE_LIMITS = {
  loginSubmit: { limit: 10, windowSeconds: 5 * 60 },
  otpVerify: { limit: 12, windowSeconds: 5 * 60 },
  otpIssue: { limit: OTP_ISSUE_HOURLY_LIMIT, windowSeconds: 60 * 60 },
} as const;

/** Session policy: absolute expiry + idle timeout (seconds). */
export const SESSION_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;
export const SESSION_IDLE_TIMEOUT_SECONDS = 60 * 60;
/** Update last_seen_at at most this often to limit write amplification. */
export const SESSION_TOUCH_INTERVAL_SECONDS = 120;

/** Signed pre-OTP cookie (Step 1 → Step 2 handoff) lifetime. */
export const PREAUTH_COOKIE_TTL_SECONDS = 10 * 60;

/** Cookie names. */
export const COOKIE_NAMES = {
  session: "niyojan_session",
  preauth: "niyojan_preauth",
  csrf: "niyojan_csrf",
} as const;

/** FIRM_STATUSES reserved for Phase 2 (firm management) — not used yet. */
export const FIRM_STATUSES = ["ACTIVE", "INACTIVE"] as const;
