import { and, eq, isNull } from "drizzle-orm";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getDb } from "@/lib/db";
import { adminAccounts, adminSessions } from "@/lib/db/schema";
import { getServerEnv } from "@/lib/config/env";
import { SystemAuthError, logAuthError, logAuthEvent } from "@/lib/auth/errors";
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

/** Create a fresh session row and return the cookie token + row id. */
export async function createSession(
  adminId: string,
  meta: AuthAttemptMeta,
): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_TTL_SECONDS * 1000);

  try {
    const [row] = await getDb()
      .insert(adminSessions)
      .values({
        adminId,
        tokenHash: sha256Hex(token),
        expiresAt,
        lastSeenAt: new Date(),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
      .returning({ id: adminSessions.id });

    if (!row) {
      throw new Error("no row returned");
    }

    logAuthEvent("session_created", { admin_id: adminId });
    return { token, sessionId: row.id, expiresAt: expiresAt.toISOString() };
  } catch (err) {
    throw dbSessionError("admin_sessions.insert", err);
  }
}

/** Map a driver error to a sanitized SystemAuthError for the server log. */
function dbSessionError(operation: string, err: unknown): SystemAuthError {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  return new SystemAuthError(`postgres ${operation} failed${code ? ` (code ${code})` : ""}`);
}

/**
 * Validate a session token against the database. Returns null when the token
 * is unknown, revoked, past absolute expiry, idle-expired or the admin is
 * deactivated. Sliding idle timeout via last_seen_at touch.
 */
export async function validateSessionToken(token: string | null | undefined): Promise<SessionContext | null> {
  if (!token || token.length < 20 || token.length > 128) return null;

  let row:
    | {
        id: string;
        expiresAt: Date;
        lastSeenAt: Date;
        revokedAt: Date | null;
        admin: { id: string; displayName: string; username: string; email: string; isActive: boolean } | null;
      }
    | undefined;
  try {
    const rows = await getDb()
      .select({
        id: adminSessions.id,
        expiresAt: adminSessions.expiresAt,
        lastSeenAt: adminSessions.lastSeenAt,
        revokedAt: adminSessions.revokedAt,
        adminId: adminAccounts.id,
        displayName: adminAccounts.displayName,
        username: adminAccounts.username,
        email: adminAccounts.email,
        isActive: adminAccounts.isActive,
      })
      .from(adminSessions)
      .innerJoin(adminAccounts, eq(adminSessions.adminId, adminAccounts.id))
      .where(eq(adminSessions.tokenHash, sha256Hex(token)))
      .limit(1);
    const r = rows[0];
    row = r
      ? {
          id: r.id,
          expiresAt: r.expiresAt,
          lastSeenAt: r.lastSeenAt,
          revokedAt: r.revokedAt,
          admin: {
            id: r.adminId,
            displayName: r.displayName,
            username: r.username,
            email: r.email,
            isActive: r.isActive,
          },
        }
      : undefined;
  } catch (err) {
    logAuthError("session_lookup_failed", dbSessionError("admin_sessions.select", err));
    return null;
  }
  if (!row) return null;

  const now = Date.now();
  const admin = row.admin;
  if (row.revokedAt || !admin || !admin.isActive) return null;
  if (row.expiresAt.getTime() <= now) return null;
  if (now - row.lastSeenAt.getTime() > SESSION_IDLE_TIMEOUT_SECONDS * 1000) return null;

  // Sliding touch (rate-limited to avoid write amplification).
  if (now - row.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_SECONDS * 1000) {
    void getDb()
      .update(adminSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(adminSessions.id, row.id))
      .catch((touchError: unknown) => {
        logAuthError("session_touch_failed", dbSessionError("admin_sessions.update", touchError));
      });
  }

  return {
    sessionId: row.id,
    adminId: admin.id,
    displayName: admin.displayName,
    username: admin.username,
    email: admin.email,
    createdAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Revoke (logout) — single-use invalidation, survives until cleanup. */
export async function revokeSessionByToken(token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const rows = await getDb()
      .update(adminSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(adminSessions.tokenHash, sha256Hex(token)), isNull(adminSessions.revokedAt)))
      .returning({ id: adminSessions.id, adminId: adminSessions.adminId });

    const row = rows[0];
    if (row) logAuthEvent("session_revoked", { admin_id: row.adminId });
    return Boolean(row);
  } catch (err) {
    logAuthError("session_revoke_failed", dbSessionError("admin_sessions.update", err));
    return false;
  }
}

/* ============================================================================
 * Signed pre-OTP cookie (Step 1 -> Step 2 handoff)
 * ----------------------------------------------------------------------------
 * After credentials verify, an HttpOnly cookie carries ONLY
 * { challengeId, adminId } plus an HMAC-SHA256 signature keyed by
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
