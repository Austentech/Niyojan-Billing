import { readSessionCookie } from "@/lib/auth/server/cookies";
import { validateSessionToken } from "@/lib/auth/server/session";
import type { SessionContext } from "@/lib/auth/types";

/**
 * Server-side session resolution for pages and layouts.
 *
 * Called on EVERY protected server request: the cookie token is validated
 * against the database (revocation, absolute expiry, idle timeout, admin
 * active status). A missing/invalid session yields null — callers redirect
 * to the login page.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const token = await readSessionCookie();
  return validateSessionToken(token);
}
