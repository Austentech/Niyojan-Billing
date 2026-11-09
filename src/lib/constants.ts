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
  /** Firm creation (write operation) — per rolling hour. */
  firmCreate: { limit: 12, windowSeconds: 60 * 60 },
  /** Account password changes — per rolling hour. */
  passwordChange: { limit: 5, windowSeconds: 60 * 60 },
  /** Corporation profile updates — per rolling hour. */
  profileUpdate: { limit: 10, windowSeconds: 60 * 60 },
  /** Email-change verification codes issued — per rolling hour. */
  emailChangeRequest: { limit: 6, windowSeconds: 60 * 60 },
  /** Email-change code verification attempts — per 10 minutes. */
  emailChangeVerify: { limit: 12, windowSeconds: 10 * 60 },
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

/** FIRM_STATUSES reserved for future firm lifecycle features — not used yet. */
export const FIRM_STATUSES = ["ACTIVE", "INACTIVE"] as const;

/* ============================================================================
 * FIRM MANAGEMENT POLICY (Phase 2)
 * All values are enforced SERVER-SIDE (Zod + database CHECK constraints);
 * client copies exist only for immediate UX feedback.
 * ==========================================================================*/

/** Validation limits for firm records (mirrored by 0002_firms.sql checks). */
export const FIRM_POLICY = {
  nameMinLength: 2,
  nameMaxLength: 120,
  addressMinLength: 5,
  addressMaxLength: 200,
  descriptionMaxLength: 1000,
  websiteUrlMaxLength: 2048,
  holdingMin: 0,
  holdingMax: 100,
  /** Decimal places allowed for the holding percentage. */
  holdingMaxDecimals: 2,
} as const;

/** Firm logo upload policy — enforced on the client AND re-verified from the
 *  actual bytes on the server (magic-byte sniffing, sharp re-encode). */
export const FIRM_LOGO_POLICY = {
  maxBytes: 2 * 1024 * 1024,
  mimeTypes: ["image/png", "image/jpeg", "image/webp"] as const,
  extensions: ["png", "jpg", "jpeg", "webp"] as const,
  /** Logos are normalized to at most this square box (no upscaling). */
  maxDimension: 512,
} as const;

/* ============================================================================
 * ACCOUNT SETTINGS POLICY (Phase 3)
 * All values are enforced SERVER-SIDE (Zod + database CHECK constraints);
 * client copies exist only for immediate UX feedback.
 * ==========================================================================*/

/**
 * Strong password policy for NEW passwords set through Account Settings:
 * minimum 12 characters including uppercase, lowercase, number and special
 * character. (The environment bootstrap password must satisfy the same
 * policy; login itself accepts whatever the stored Argon2id hash verifies.)
 */
export const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 128,
} as const;

/** Corporation profile field limits (mirrored by 0003_account_settings.sql). */
export const CORPORATION_POLICY = {
  nameMinLength: 2,
  nameMaxLength: 120,
  displayNameMinLength: 2,
  displayNameMaxLength: 120,
  emailMaxLength: 254,
} as const;

/** Corporation logo upload policy — same hardening pipeline as firm logos. */
export const CORPORATION_LOGO_POLICY = {
  maxBytes: 2 * 1024 * 1024,
  mimeTypes: ["image/png", "image/jpeg", "image/webp"] as const,
  extensions: ["png", "jpg", "jpeg", "webp"] as const,
  maxDimension: 512,
} as const;

/** Email-change verification code policy (reuses the OTP crypto pipeline). */
export const EMAIL_CHANGE_POLICY = {
  /** Code validity window (seconds). */
  ttlSeconds: 10 * 60,
  /** Wrong-code attempts allowed per request before it is dead. */
  maxAttempts: 5,
  /** Minimum delay between consecutive code issues (resend protection). */
  resendCooldownSeconds: 60,
} as const;

/**
 * Local (development) logo directories for LOGO_STORAGE_MODE=local.
 * Served ONLY through the sanitized /uploads/[...path] route handler.
 */
export const FIRM_LOGO_LOCAL_DIR = ".data/firm-logos";
export const CORPORATION_LOGO_LOCAL_DIR = ".data/corporation-logos";

/** URL prefixes under which logos are served in local storage mode. */
export const FIRM_LOGO_PUBLIC_PREFIX = "/uploads/firm-logos";
export const CORPORATION_LOGO_PUBLIC_PREFIX = "/uploads/corporation-logos";

/** Supabase Storage buckets dedicated to logos (production mode). */
export const FIRM_LOGO_BUCKET = "firm-logos";
export const CORPORATION_LOGO_BUCKET = "corporation-logos";
