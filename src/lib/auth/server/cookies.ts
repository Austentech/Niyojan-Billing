import { cookies } from "next/headers";

import { verifyPreauthPayload, type PreauthPayload } from "@/lib/auth/server/session";
import { COOKIE_NAMES, PREAUTH_COOKIE_TTL_SECONDS, SESSION_ABSOLUTE_TTL_SECONDS } from "@/lib/constants";

/**
 * Cookie access for server actions and server components.
 *
 * ALL authentication cookies are HttpOnly (no JavaScript access), marked
 * SameSite=Lax, and Secure in production. Nothing authentication-related is
 * ever written to localStorage or sessionStorage.
 */

const isProduction = process.env.NODE_ENV === "production";

function baseCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/* --- Session cookie -------------------------------------------------------- */

export async function readSessionCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE_NAMES.session)?.value ?? null;
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAMES.session, token, baseCookieOptions(SESSION_ABSOLUTE_TTL_SECONDS));
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAMES.session, "", { ...baseCookieOptions(0), maxAge: 0 });
}

/* --- Signed pre-OTP cookie (Step 1 -> Step 2 handoff) ----------------------- */

export async function readPreauthCookie(): Promise<PreauthPayload | null> {
  const jar = await cookies();
  return verifyPreauthPayload(jar.get(COOKIE_NAMES.preauth)?.value);
}

export async function setPreauthCookie(value: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAMES.preauth, value, baseCookieOptions(PREAUTH_COOKIE_TTL_SECONDS));
}

export async function clearPreauthCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAMES.preauth, "", { ...baseCookieOptions(0), maxAge: 0 });
}

/* --- CSRF double-submit cookie ---------------------------------------------- */

export async function readCsrfCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE_NAMES.csrf)?.value ?? null;
}
