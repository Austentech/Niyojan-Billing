import { getServerEnv } from "@/lib/config/env";
import { getSupabaseServiceClient, dbSystemError } from "@/lib/auth/server/db";
import { hashPassword } from "@/lib/auth/server/password";
import { logAuthEvent, logAuthError } from "@/lib/auth/errors";

/**
 * Controlled, idempotent administrator bootstrap.
 *
 *   * Runs at most once per server process (result cached in a promise).
 *   * Creates the admin_accounts row ONLY when the table has no row yet:
 *     INSERT ... ON CONFLICT (username) DO NOTHING — race-safe.
 *   * NEVER overwrites an existing row. Once any password change has been
 *     made through the application (future Account Settings phase), the
 *     database credential is authoritative forever; the environment values
 *     are only ever used for the FIRST creation.
 *   * ADMIN_PASSWORD is hashed with Argon2id immediately and exists in
 *     process memory only transiently during this bootstrap.
 *
 * To change credentials after bootstrap, use the database (or the future
 * Account Settings screen). Changing .env values has no effect afterwards.
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
  const db = getSupabaseServiceClient();

  // Any existing administrator row -> database is authoritative, skip.
  const { data: existing, error: selectError } = await db.from("admin_accounts").select("id, credentials_source").limit(1);
  if (selectError) {
    throw dbSystemError("admin_accounts.select", selectError);
  }
  if (existing && existing.length > 0) {
    logAuthEvent("admin_bootstrap_skipped_existing", { credentials_source: existing[0].credentials_source });
    return;
  }

  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);

  const { error: insertError } = await db.from("admin_accounts").upsert(
    {
      username: env.ADMIN_USERNAME,
      email: env.ADMIN_EMAIL,
      display_name: env.ADMIN_NAME,
      password_hash: passwordHash,
      credentials_source: "env_bootstrap",
    },
    { onConflict: "username", ignoreDuplicates: true },
  );
  if (insertError) {
    throw dbSystemError("admin_accounts.upsert", insertError);
  }

  logAuthEvent("admin_bootstrap_created", { username: env.ADMIN_USERNAME });
}
