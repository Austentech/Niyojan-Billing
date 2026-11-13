import { loadDotEnv } from "./load-env";

loadDotEnv(".env", { override: true });

/**
 * Secure administrator bootstrap command (npm run db:bootstrap).
 *
 * Creates the initial administrator account from the ADMIN_* environment
 * variables using the SAME idempotent logic the login flow uses:
 *   * runs at most once — an existing admin_accounts row is never touched;
 *   * the initial password is Argon2id-hashed immediately and never logged;
 *   * after the first password change through Account Settings the database
 *     credential is authoritative and the environment values stop applying.
 *
 * Safe to re-run at any time (and across redeploys) — it reports and exits.
 */
async function main() {
  const { ensureAdminBootstrapped } = await import("../src/lib/auth/server/bootstrap");
  const { getAdminByUsername } = await import("../src/lib/auth/service");
  const { getServerEnv } = await import("../src/lib/config/env");

  const env = getServerEnv();
  console.log(`[bootstrap] target database: ${maskUrl(env.DATABASE_URL)}`);
  console.log(`[bootstrap] administrator username: ${env.ADMIN_USERNAME}`);

  await ensureAdminBootstrapped();

  const admin = await getAdminByUsername(env.ADMIN_USERNAME);
  if (!admin) {
    console.error("[bootstrap] FAILED — the account was not created. Check the database connection.");
    process.exit(1);
  }
  console.log(`[bootstrap] ok — administrator '${admin.display_name}' is present (credential source: ${admin.credentials_source}).`);
  console.log(
    admin.credentials_source === "env_bootstrap"
      ? "[bootstrap] the environment password is active until the first change from Account Settings."
      : "[bootstrap] the database password is authoritative; environment values no longer apply.",
  );
  process.exit(0);
}

/** Never print credentials: show only the database host. */
function maskUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparsed)";
  }
}

main().catch((err) => {
  console.error(`[bootstrap] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
