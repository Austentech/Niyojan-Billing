import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/config/env";
import { getSupabaseServiceClient, dbSystemError } from "@/lib/auth/server/db";
import { logAuthError, logAuthEvent } from "@/lib/auth/errors";
import type { AuthAttemptMeta, SessionContext } from "@/lib/auth/types";
import {
  PREAUTH_COOKIE_TTL_SECONDS,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TIMEOUT_SECONDS,
  SESSION_TOUCH_INTERVAL_SECONDS,
} from "@/lib/constants";

/**
 * Opaque server-side sessions.
 *
 *   * Cookie value  : 256-bit random token (base64url) — no personal data,
 *                     no JWT claims, nothing decryptable client-side.
 *   * Database      : only SHA-256(token) is stored; a database leak cannot
 *                     be replayed as valid cookies.
 *   * Cookies       : HttpOnly, SameSite=Lax, Secure in production — set by
 *                     src/lib/auth/server/cookies.ts (never localStorage).
 *   * Fixation      : every login mints a brand-new random token, so a token
 *                     fixed before login is discarded on authentication.
 *   * Expiry        : absolute (8h) + idle timeout (60 min) enforced server-side.
 */

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

interface SessionRow {
  id: string;
  admin_id: string;
  token_hash: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

interface SessionAdminJoin {
  id: string;
  admin_id: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  admin_accounts: { id: string; display_name: string; username: string; email: string; is_active: boolean } | null;
}

/** Create a fresh session row and return the cookie token. */
export async function createSession(
  adminId: string,
  meta: AuthAttemptMeta,
): Promise<{ token: string; expiresAt: string }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TTL_SECONDS * 1000).toISOString();

  const { error } = await getSupabaseServiceClient().from("admin_sessions").insert({
    admin_id: adminId,
    token_hash: sha256Hex(token),
    expires_at: expiresAt,
    last_seen_at: new Date().toISOString(),
    ip_address: meta.ipAddress,
    user_agent: meta.userAgent,
  });
  if (error) {
    throw dbSystemError("admin_sessions.insert", error);
  }

  logAuthEvent("session_created", { admin_id: adminId });
  return { token, expiresAt };
}

function toContext(row: SessionAdminJoin): SessionContext {
  const admin = row.admin_accounts!;
  return {
    sessionId: row.id,
    adminId: admin.id,
    displayName: admin.display_name,
    username: admin.username,
    email: admin.email,
    createdAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Validate a session token against the database. Returns null when the token
 * is unknown, revoked, past absolute expiry, idle-expired or the admin is
 * deactivated. Sliding idle timeout via last_seen_at touch.
 */
export async function validateSessionToken(token: string | null | undefined): Promise<SessionContext | null> {
  if (!token || token.length < 20 || token.length > 128) return null;

  const db = getSupabaseServiceClient();
  const { data, error } = await db
    .from("admin_sessions")
    .select(
      "id, admin_id, expires_at, last_seen_at, revoked_at, admin_accounts(id, display_name, username, email, is_active)",
    )
    .eq("token_hash", sha256Hex(token))
    .maybeSingle<SessionAdminJoin>();

  if (error) {
    logAuthError("session_lookup_failed", dbSystemError("admin_sessions.select", error));
    return null;
  }
  if (!data) return null;

  const now = Date.now();
  const admin = data.admin_accounts;
  if (data.revoked_at || !admin || !admin.is_active) return null;
  if (Date.parse(data.expires_at) <= now) return null;
  if (now - Date.parse(data.last_seen_at) > SESSION_IDLE_TIMEOUT_SECONDS * 1000) return null;

  // Sliding touch (rate-limited to avoid write amplification).
  if (now - Date.parse(data.last_seen_at) > SESSION_TOUCH_INTERVAL_SECONDS * 1000) {
    void db
      .from("admin_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", data.id)
      .then(({ error: touchError }) => {
        if (touchError) logAuthError("session_touch_failed", dbSystemError("admin_sessions.update", touchError));
      });
  }

  return toContext(data);
}

/** Revoke (logout) — single-use invalidation, survives until cleanup. */
export async function revokeSessionByToken(token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  const { data, error } = await getSupabaseServiceClient()
    .from("admin_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", sha256Hex(token))
    .is("revoked_at", null)
    .select("id, admin_id")
    .maybeSingle<SessionRow>();
  if (error) {
    logAuthError("session_revoke_failed", dbSystemError("admin_sessions.update", error));
    return false;
  }
  if (data) logAuthEvent("session_revoked", { admin_id: data.admin_id });
  return Boolean(data);
}

/* ============================================================================
 * Signed pre-OTP cookie (Step 1 -> Step 2 handoff)
 * ----------------------------------------------------------------------------
 * After credentials verify, an HttpOnly cookie carries ONLY
 * { challengeId, adminId, exp } plus an HMAC-SHA256 signature keyed by
 * AUTH_SESSION_SECRET. It is unreadable and unforgeable client-side, expires
 * with the OTP, and never contains the code itself. The OTP screen cannot
 * proceed without it, binding Step 2 to the server-verified Step 1.
 * ==========================================================================*/

export interface PreauthPayload {
  /** OTP challenge id. */
  cid: string;
  /** Admin account id. */
  aid: string;
}

export function signPreauthPayload(payload: PreauthPayload, ttlSeconds = PREAUTH_COOKIE_TTL_SECONDS): string {
  const env = getServerEnv();
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const exp = Date.now() + ttlSeconds * 1000;
  const signature = createHmac("sha256", env.AUTH_SESSION_SECRET).update(`${body}.${exp}`).digest("base64url");
  return `${body}.${exp}.${signature}`;
}

export function verifyPreauthPayload(cookieValue: string | null | undefined): PreauthPayload | null {
  if (!cookieValue) return null;
  const env = getServerEnv();
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [body, expRaw, signature] = parts;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp)) return null;

  const expected = createHmac("sha256", env.AUTH_SESSION_SECRET).update(`${body}.${exp}`).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() > exp) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<PreauthPayload>;
    if (typeof parsed.cid !== "string" || typeof parsed.aid !== "string") return null;
    return { cid: parsed.cid, aid: parsed.aid };
  } catch {
    return null;
  }
}
