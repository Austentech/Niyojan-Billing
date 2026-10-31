import { getSupabaseServiceClient, dbSystemError } from "@/lib/auth/server/db";
import { logAuthError } from "@/lib/auth/errors";
import type { LockoutState } from "@/lib/auth/types";

/**
 * GLOBAL login lockout — thin typed wrappers over the atomic SECURITY
 * DEFINER functions in supabase/migrations/0001_auth_core.sql.
 *
 * The state lives in PostgreSQL (single 'GLOBAL' row), so the lockout:
 *   * applies to every device, browser and IP address,
 *   * survives server restarts and redeploys,
 *   * cannot be raced past thanks to atomic UPSERT counting,
 *   * cannot be reset, shortened or extended by failed requests.
 *
 * Policy (enforced in SQL): the 4th consecutive failed authentication attempt
 * (credential OR OTP failure) activates a 24-hour lockout; only a COMPLETE
 * successful authentication resets the counter.
 */

interface RawLockoutJson {
  consecutive_failures?: number | null;
  locked_until?: string | null;
  is_locked?: boolean | null;
  lockout_activated?: boolean | null;
}

function secondsUntil(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso) - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

function toLockoutState(raw: RawLockoutJson | null): LockoutState {
  const lockedUntil = raw?.locked_until ?? null;
  const isLocked = Boolean(raw?.is_locked) && secondsUntil(lockedUntil) > 0;
  return {
    isLocked,
    lockedUntil: isLocked ? lockedUntil : null,
    secondsRemaining: isLocked ? secondsUntil(lockedUntil) : 0,
    consecutiveFailures: raw?.consecutive_failures ?? 0,
  };
}

/** Current GLOBAL lockout state. Throws SystemAuthError when the database is unreachable. */
export async function getLockoutState(): Promise<LockoutState> {
  const { data, error } = await getSupabaseServiceClient().rpc("auth_lockout_state");
  if (error) {
    const sysErr = dbSystemError("auth_lockout_state", error);
    logAuthError("lockout_state_unavailable", sysErr);
    throw sysErr;
  }
  return toLockoutState((data ?? {}) as RawLockoutJson);
}

/**
 * Best-effort lockout read used for RENDERING only (login page decides
 * between the login form and the lockout screen). Never used for auth
 * decisions: the authoritative check happens inside the server actions.
 */
export async function getLockoutStateForRender(): Promise<LockoutState> {
  try {
    return await getLockoutState();
  } catch {
    return { isLocked: false, lockedUntil: null, secondsRemaining: 0, consecutiveFailures: 0 };
  }
}

/** Count one failed authentication attempt (atomic). Returns the new state. */
export async function registerAuthFailure(): Promise<LockoutState & { lockoutActivated: boolean }> {
  const { data, error } = await getSupabaseServiceClient().rpc("auth_register_failure");
  if (error) {
    const sysErr = dbSystemError("auth_register_failure", error);
    logAuthError("register_failure_unavailable", sysErr);
    throw sysErr;
  }
  const raw = (data ?? {}) as RawLockoutJson;
  return { ...toLockoutState(raw), lockoutActivated: Boolean(raw?.lockout_activated) };
}

/** A complete successful authentication — resets the consecutive-failure counter. */
export async function registerAuthSuccess(): Promise<void> {
  const { error } = await getSupabaseServiceClient().rpc("auth_register_success");
  if (error) {
    // Non-fatal: the login itself already succeeded; log for operations.
    logAuthError("register_success_unavailable", dbSystemError("auth_register_success", error));
  }
}
