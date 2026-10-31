import { headers } from "next/headers";
import { isIP } from "node:net";

import { readCsrfCookie } from "@/lib/auth/server/cookies";
import { getServerEnv } from "@/lib/config/env";
import { logAuthEvent, RequestBlockedError } from "@/lib/auth/errors";
import type { AuthAttemptMeta } from "@/lib/auth/types";

/**
 * Request guard for every state-changing authentication endpoint.
 *
 * LAYERS
 *   1. Next.js Server Actions already reject cross-origin POSTs whose Origin
 *      does not match the Host (built-in protection).
 *   2. This guard additionally validates the Origin header (when present)
 *      against the request Host and the canonical APP_URL.
 *   3. Double-submit CSRF token: an HttpOnly cookie set by middleware is
 *      embedded as a hidden form field by the server-rendered form; the
 *      action refuses to run unless cookie value === field value. A
 *      cross-site attacker can neither read the cookie nor inject the field.
 *   4. Session cookies are SameSite=Lax, so cross-site POSTs never carry an
 *      authenticated session in the first place.
 */

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function originHost(origin: string): string | null {
  try {
    return normalizeHost(new URL(origin).host);
  } catch {
    return null;
  }
}

/** Extract a sanitized client meta for audit logging (never used for authz). */
export async function getClientMeta(): Promise<AuthAttemptMeta> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for");
  const rawIp = forwardedFor?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "";
  const ipAddress = rawIp && isIP(rawIp) !== 0 ? rawIp : null;
  const userAgent = (h.get("user-agent") ?? "").slice(0, 300) || null;
  return { ipAddress, userAgent };
}

/**
 * Validate that a mutating request originates from this application.
 * Throws RequestBlockedError (safe public message) on mismatch.
 */
export async function assertTrustedMutation(formData: FormData | null): Promise<void> {
  const h = await headers();

  // --- Origin / Host validation ------------------------------------------------
  const originHeader = h.get("origin");
  const hostHeader = h.get("host");
  if (originHeader && hostHeader) {
    const origin = originHost(originHeader);
    const host = normalizeHost(hostHeader);
    let appUrlHost: string | null = null;
    try {
      appUrlHost = normalizeHost(new URL(getServerEnv().APP_URL).host);
    } catch {
      appUrlHost = null;
    }
    const trusted = origin !== null && (origin === host || origin === appUrlHost);
    if (!trusted) {
      logAuthEvent("request_blocked_origin_mismatch");
      throw new RequestBlockedError("Request blocked: untrusted origin.", "origin_mismatch");
    }
  }

  // --- CSRF double-submit token -------------------------------------------------
  const cookieToken = await readCsrfCookie();
  const fieldToken = formData ? (formData.get("csrf") as string | null) : null;
  if (!cookieToken || cookieToken.length < 16 || cookieToken.length > 128 || !fieldToken || fieldToken !== cookieToken) {
    logAuthEvent("request_blocked_csrf");
    throw new RequestBlockedError("Request blocked: security token mismatch. Reload the page and try again.", "csrf_mismatch");
  }
}
