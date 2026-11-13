import { eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { adminAccounts } from "@/lib/db/schema";
import { getServerEnv } from "@/lib/config/env";
import { dbSystemError } from "@/lib/auth/server/db";
import { hashPassword } from "@/lib/auth/server/password";
import { logAuthEvent, logAuthError } from "@/lib/auth/errors";

/**
 * Controlled, idempotent administrator bootstrap.
 *
 *   * Creates the admin_accounts row ONLY when the table has no row yet:
 *     INSERT ... ON CONFLICT (username) DO NOTHING — race-safe.
 *   * NEVER overwrites an existing row. Once any password change has been
 *     made through Account Settings, the database credential is authoritative
 *     forever; the environment values are only ever used for the FIRST
 *     creation. Redeployment can therefore never reset the password.
 *   * ADMIN_PASSWORD is hashed with Argon2id immediately and exists in
 *     process memory only transiently during this bootstrap.
 *
 * This lazy bootstrap (first sign-in attempt / account read) keeps account
 * initialization separate from normal login requests. The documented operator
 * command `npm run db:bootstrap` performs the same step explicitly.
 */

let bootstrapPromise: Promise<void> | null = null;

export function ensureAdminBootstrapped(): Promise<void> {
  bootstrapPromise ??= runBootstrap().catch((err) => {
    // Allow a later request to retry after a transient database failure.
    bootstrapPromise = null;
    throw err;
  });
  return bootstrapPromise;
}

async function runBootstrap(): Promise<void> {
  const env = getServerEnv();
  const db = getDb();

  // Any existing administrator row -> database is authoritative, skip.
  try {
    const existing = await db
      .select({ id: adminAccounts.id, credentialsSource: adminAccounts.credentialsSource })
      .from(adminAccounts)
      .limit(1);
    if (existing.length > 0) {
      logAuthEvent("admin_bootstrap_skipped_existing", { credentials_source: existing[0].credentialsSource });
      return;
    }
  } catch (err) {
    throw dbSystemError("admin_accounts.select", err);
  }

  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);

  try {
    await db
      .insert(adminAccounts)
      .values({
        username: env.ADMIN_USERNAME,
        email: env.ADMIN_EMAIL,
        displayName: env.ADMIN_NAME,
        passwordHash,
        credentialsSource: "env_bootstrap",
      })
      .onConflictDoNothing({ target: adminAccounts.username });
  } catch (err) {
    throw dbSystemError("admin_accounts.insert", err);
  }

  logAuthEvent("admin_bootstrap_created", { username: env.ADMIN_USERNAME });
}

/* ============================================================================
 * OPERATIONS-ONLY HELPERS (no HTTP route ever calls these)
 * ==========================================================================*/

/** Destructive reset of global authentication state — operator recovery. */
export async function resetGlobalAuthStateForOperators(): Promise<void> {
  const db = getDb();
  await db.execute(sql`delete from public.security_lockouts where id = 'GLOBAL'`);
  await db.execute(sql`delete from public.rate_limits where key like 'auth:%'`);
  logAuthEvent("global_auth_state_reset_by_operator", {});
}

/** Re-activate a deactivated administrator (operator disaster recovery). */
export async function activateAdminForOperators(adminId: string): Promise<boolean> {
  try {
    const rows = await getDb()
      .update(adminAccounts)
      .set({ isActive: true })
      .where(eq(adminAccounts.id, adminId))
      .returning({ id: adminAccounts.id });
    return rows.length > 0;
  } catch (err) {
    logAuthError("admin_activation_failed", err);
    return false;
  }
}
