import { getDb, getSql, toIso } from "@/lib/db";
import { SystemAuthError } from "@/lib/auth/errors";

/**
 * Auth-layer database access — every query flows through the SINGLE reusable
 * connection module (src/lib/db/index.ts): Drizzle ORM over postgres.js.
 *
 *   * All statement generation is parameterized (no string concatenation of
 *     untrusted input anywhere).
 *   * The atomic SECURITY DEFINER functions are invoked through the raw
 *     client with bound parameters only.
 *   * Database credentials are never logged, returned or serialized.
 */

export { getDb, getSql, toIso };

/**
 * Map a driver error to a SystemAuthError without leaking detail: only the
 * operation name and the PostgreSQL error code (a safe, well-known taxonomy)
 * reach the server log; clients only ever see the generic message.
 */
export function dbSystemError(operation: string, error: unknown): SystemAuthError {
  let code = "";
  if (error && typeof error === "object" && "code" in error) {
    const raw = (error as { code?: unknown }).code;
    if (typeof raw === "string" || typeof raw === "number") code = String(raw).slice(0, 20);
  }
  return new SystemAuthError(`postgres ${operation} failed${code ? ` (code ${code})` : ""}`);
}
