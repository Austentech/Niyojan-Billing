import { getSupabaseServiceClient, dbSystemError } from "@/lib/auth/server/db";
import { logAuthError, RequestBlockedError } from "@/lib/auth/errors";
import type { RateLimitResult } from "@/lib/auth/types";

/**
 * Server-side distributed rate limiting.
 *
 * Counters live in PostgreSQL (rate_limits) and are incremented with a single
 * atomic UPSERT (auth_check_rate_limit), so the limit is enforced across ALL
 * server instances and survives restarts — never in-memory-only.
 *
 * Applied to: credential submission, OTP verification and OTP issuance.
 * A rate-limited request throws RequestBlockedError with a safe message and
 * the retry-after delay; it never counts as an authentication failure.
 */

export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const { data, error } = await getSupabaseServiceClient().rpc("auth_check_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    // Fail CLOSED: if the limiter cannot run, the request is rejected.
    throw dbSystemError("auth_check_rate_limit", error);
  }
  const raw = (data ?? {}) as { allowed?: boolean; count?: number; retry_after_seconds?: number };
  return {
    allowed: Boolean(raw?.allowed),
    count: raw?.count ?? 0,
    retryAfterSeconds: raw?.retry_after_seconds ?? 0,
  };
}

/** Enforce a limit — throws RequestBlockedError when exceeded. */
export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const result = await checkRateLimit(key, limit, windowSeconds);
  if (!result.allowed) {
    const minutes = Math.max(1, Math.round(result.retryAfterSeconds / 60));
    throw new RequestBlockedError(
      `Too many requests. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} before trying again.`,
      "rate_limited",
      result.retryAfterSeconds,
    );
  }
}
