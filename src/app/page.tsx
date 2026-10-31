import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AuthScreen } from "@/components/auth/auth-screen";
import { LockoutScreen } from "@/components/auth/lockout-screen";
import { getSessionContext } from "@/lib/auth/server/context";
import { getLockoutStateForRender } from "@/lib/auth/server/lockout";
import { isServerEnvConfigured } from "@/lib/config/env";
import { COOKIE_NAMES } from "@/lib/constants";
import type { SessionContext } from "@/lib/auth/types";

/**
 * ROOT ROUTE — the administrator login interface.
 *
 *   * Authenticated administrators are redirected to /dashboard.
 *   * While the GLOBAL lockout is active, the login form is unavailable and
 *     a dedicated security-lockout screen is shown instead.
 *   * The CSRF double-submit token is read from the cookie seeded by the
 *     edge proxy and embedded into every form as a hidden field.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  let session: SessionContext | null = null;
  try {
    session = await getSessionContext();
  } catch {
    // Misconfigured environment or unreachable database: treat as
    // unauthenticated — the login actions fail closed on their own.
    session = null;
  }
  if (session) {
    redirect("/dashboard");
  }

  // Rendering-time lockout probe (fail-open for RENDERING only; the
  // authoritative, fail-closed check lives inside every server action).
  const lockout = await getLockoutStateForRender();
  if (lockout.isLocked) {
    return <LockoutScreen lockedUntil={lockout.lockedUntil} secondsRemaining={lockout.secondsRemaining} />;
  }

  const jar = await cookies();
  const csrfToken = jar.get(COOKIE_NAMES.csrf)?.value ?? "";

  return <AuthScreen csrfToken={csrfToken} envReady={isServerEnvConfigured()} />;
}
