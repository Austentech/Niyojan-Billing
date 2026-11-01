import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge proxy (Next.js 16 successor of middleware) — security perimeter.
 *
 * Responsibilities
 *   1. FAST-PATH route protection: /dashboard and /settings are redirected to
 *      the login page when no session cookie exists. This is UX only — the
 *      AUTHORITATIVE validation happens server-side on every protected
 *      request (src/lib/auth/server/session.ts), so a forged cookie value
 *      still fails there.
 *   2. CSRF double-submit cookie: seeds an HttpOnly random token that
 *      server-rendered forms embed as a hidden field and server actions
 *      verify (src/lib/auth/server/request-guard.ts).
 *   3. Security headers incl. Content-Security-Policy with a per-request
 *      nonce (Next.js propagates the nonce to its bootstrap scripts via the
 *      x-nonce request header, per the official CSP pattern).
 *
 * Environment awareness
 *   * Development: relaxed CSP (unsafe-eval for React Fast Refresh) and
 *     frame-ancestors 'self' so the platform preview iframe works.
 *   * Production: strict CSP (nonce + strict-dynamic) and DENY framing.
 */

const SESSION_COOKIE = "niyojan_session";
const CSRF_COOKIE = "niyojan_csrf";

const PROTECTED_PREFIXES = ["/dashboard", "/settings"];

const isProduction = process.env.NODE_ENV === "production";

function generateCsrfToken(): string {
  // 128 bits of entropy from the Edge Web Crypto API.
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * The project's Supabase origin — the only cross-origin image source allowed
 * (firm logos are served from public Supabase Storage URLs in production).
 * Read from NEXT_PUBLIC_SUPABASE_URL, which is safe to reference here.
 */
function supabaseImageOrigin(): string {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

function buildContentSecurityPolicy(nonce: string): string {
  const scriptSrc = isProduction
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : `'self' 'unsafe-eval' 'unsafe-inline'`;
  const supabaseOrigin = supabaseImageOrigin();
  const imgSrc = ["'self'", "data:", "blob:", ...(supabaseOrigin ? [supabaseOrigin] : [])].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Tailwind + Next.js inject critical inline styles.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc}`,
    "font-src 'self' data:",
    // The browser never talks to Supabase — every query is server-side.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${isProduction ? "'none'" : "'self'"}`,
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function applySecurityHeaders(response: NextResponse, nonce: string): NextResponse {
  response.headers.set("Content-Security-Policy", buildContentSecurityPolicy(nonce));
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", isProduction ? "DENY" : "SAMEORIGIN");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (isProduction) {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  /* --- 1. Fast-path protection of authenticated routes ------------------- */
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (isProtected && !request.cookies.get(SESSION_COOKIE)?.value) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/";
    loginUrl.search = "";
    return applySecurityHeaders(NextResponse.redirect(loginUrl), crypto.randomUUID().replace(/-/g, ""));
  }

  /* --- 2. CSRF double-submit cookie ---------------------------------------- */
  let csrfToken = request.cookies.get(CSRF_COOKIE)?.value;
  if (!csrfToken || csrfToken.length < 32 || csrfToken.length > 128) {
    csrfToken = generateCsrfToken();
    // Forward to THIS request so the server component can embed it immediately.
    request.cookies.set(CSRF_COOKIE, csrfToken);
  }

  /* --- 3. Security headers + CSP nonce -------------------------------------- */
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", buildContentSecurityPolicy(nonce));

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  if (request.cookies.get(CSRF_COOKIE)?.value === csrfToken) {
    response.cookies.set(CSRF_COOKIE, csrfToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
      maxAge: 60 * 60 * 12,
    });
  }

  return applySecurityHeaders(response, nonce);
}

export const config = {
  // All documents and API routes; static assets are excluded.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/).*)"],
};
