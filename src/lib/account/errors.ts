/**
 * Centralized error taxonomy for account-settings flows (mirrors the Phase 1
 * authentication and Phase 2 firm-management taxonomies).
 *
 * RULES
 *   1. PublicAccountError messages are safe to show to any client.
 *   2. Everything else is logged server-side with sanitized detail (never
 *      containing passwords, verification codes, hashes or internal paths)
 *      and surfaced to clients only as a generic "temporarily unavailable"
 *      message.
 */

/** An error whose message is safe for public display. */
export class PublicAccountError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, code: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "PublicAccountError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Internal/system failure (database unreachable, storage failure...). */
export class SystemAccountError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super("Account settings are temporarily unavailable. Please try again shortly.");
    this.name = "SystemAccountError";
    this.detail = detail;
  }
}

/** A recognized, safe logging context — guarantees no secrets in logs. */
export interface SafeLogContext {
  [key: string]: string | number | boolean | null | undefined;
}

export function logAccountEvent(event: string, context: SafeLogContext = {}): void {
  const suffix = Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.info(`[account] ${event}${suffix ? ` ${suffix}` : ""}`);
}

export function logAccountError(event: string, error: unknown, context: SafeLogContext = {}): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${String(error.message).slice(0, 300)}`
      : "unknown error object";
  const suffix = Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.error(`[account] ${event}${suffix ? ` ${suffix}` : ""} detail="${detail}"`);
}
