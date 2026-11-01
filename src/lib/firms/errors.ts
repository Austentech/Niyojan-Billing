/**
 * Centralized error taxonomy for firm-management flows (mirrors the Phase 1
 * authentication taxonomy).
 *
 * RULES
 *   1. PublicFirmError messages are safe to show to any client.
 *   2. Everything else is logged server-side with sanitized detail (never
 *      containing file contents, URLs with keys, or internal paths) and
 *      surfaced to clients only as a generic "temporarily unavailable"
 *      message.
 */

/** An error whose message is safe for public display. */
export class PublicFirmError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PublicFirmError";
    this.code = code;
  }
}

/** Internal/system failure (database unreachable, storage failure...). */
export class SystemFirmError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super("Firm management is temporarily unavailable. Please try again shortly.");
    this.name = "SystemFirmError";
    this.detail = detail;
  }
}

/** A recognized, safe logging context — guarantees no secrets in logs. */
export interface SafeLogContext {
  [key: string]: string | number | boolean | null | undefined;
}

export function logFirmEvent(event: string, context: SafeLogContext = {}): void {
  const suffix = Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.info(`[firms] ${event}${suffix ? ` ${suffix}` : ""}`);
}

export function logFirmError(event: string, error: unknown, context: SafeLogContext = {}): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${String(error.message).slice(0, 300)}`
      : "unknown error object";
  const suffix = Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.error(`[firms] ${event}${suffix ? ` ${suffix}` : ""} detail="${detail}"`);
}
