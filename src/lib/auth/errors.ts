/**
 * Centralized error taxonomy for authentication flows.
 *
 * RULES
 *   1. PublicAuthError messages are safe to show to any client.
 *   2. Everything else is logged server-side with detail (never containing
 *      passwords, OTP codes, hashes or secrets) and surfaced to clients only
 *      as a generic "temporarily unavailable" message.
 */

/** An error whose message is safe for public display. */
export class PublicAuthError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, code: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "PublicAuthError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Request blocked by origin/CSRF validation or rate limiting. */
export class RequestBlockedError extends PublicAuthError {
  constructor(message: string, code: string, retryAfterSeconds?: number) {
    super(message, code, retryAfterSeconds);
  }
}

/**
 * Internal/system failure (database unreachable, SMTP failure, env invalid...).
 * Carries a sanitized `detail` for the server log.
 */
export class SystemAuthError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super("Authentication service is temporarily unavailable. Please try again shortly.");
    this.name = "SystemAuthError";
    this.detail = detail;
  }
}

/** A recognized, safe logging context — used to guarantee no secrets in logs. */
export interface SafeLogContext {
  [key: string]: string | number | boolean | null | undefined;
}

export function logAuthEvent(event: string, context: SafeLogContext = {}): void {
  // Structured single-line log; values are interpolated server-side only.
  const suffix = Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.info(`[auth] ${event}${suffix ? ` ${suffix}` : ""}`);
}

export function logAuthError(event: string, error: unknown, context: SafeLogContext = {}): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${String(error.message).slice(0, 300)}`
      : "unknown error object";
  const suffix = Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.error(`[auth] ${event}${suffix ? ` ${suffix}` : ""} detail="${detail}"`);
}
