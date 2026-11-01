/**
 * Opaque server-side session management.
 *
 * - The cookie carries a random 256-bit token (base64url).
 * - Only its SHA-256 hash is persisted, so a database leak cannot be replayed.
 * - Cookies are httpOnly + SameSite=Lax + Secure (on HTTPS), fixed 8h lifetime.
 */
import "server-only";
import { cookies, headers } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { SESSION_TTL_MS } from "@/lib/constants";

const COOKIE_NAME = "niyojan_session";
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export interface SessionUser {
  sessionId: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    mustChangePassword: boolean;
    lastLoginAt: Date | null;
    createdAt: Date;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clientIp(h: Headers): string | null {
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim().slice(0, 60) || null;
  return h.get("x-real-ip")?.slice(0, 60) ?? null;
}

async function isSecureRequest(): Promise<boolean> {
  const h = await headers();
  return h.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

/** Create a new session for `userId` and set the session cookie. */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const h = await headers();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.adminSession.create({
    data: {
      tokenHash: sha256(token),
      userId,
      expiresAt,
      ipAddress: clientIp(h),
      userAgent: h.get("user-agent")?.slice(0, 250) || null,
    },
  });

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await isSecureRequest(),
    path: "/",
    expires: expiresAt,
  });
}

/** Resolve the current session, or null when unauthenticated/expired. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const record = await db.adminSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });

  if (!record) return null;
  if (record.revokedAt !== null || record.expiresAt.getTime() <= Date.now()) return null;
  if (!record.user.isActive) return null;

  // Throttled activity marker for the sessions table.
  if (Date.now() - record.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await db.adminSession
      .update({ where: { id: record.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return {
    sessionId: record.id,
    user: {
      id: record.user.id,
      name: record.user.name,
      email: record.user.email,
      role: record.user.role,
      mustChangePassword: record.user.mustChangePassword,
      lastLoginAt: record.user.lastLoginAt,
      createdAt: record.user.createdAt,
    },
  };
}

/** Revoke one session owned by `userId` (never the current one). */
export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  const result = await db.adminSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

/** Revoke every session for `userId` except `keepSessionId` (if provided). */
export async function revokeAllSessions(userId: string, keepSessionId?: string): Promise<number> {
  const result = await db.adminSession.updateMany({
    where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Revoke the current session and clear the cookie (logout). */
export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) {
    await db.adminSession
      .updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }
  store.delete(COOKIE_NAME);
}

/** Housekeeping: drop long-expired rows so the table stays small. */
export async function purgeExpiredSessions(): Promise<void> {
  await db.adminSession.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
}
