import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration — PostgreSQL (Neon / Lakebase / standard PG).
 *
 *   * `db:generate` — creates a new versioned SQL migration in ./drizzle by
 *     diffing src/lib/db/schema.ts against the last snapshot.
 *   * `db:migrate`  — applies pending migrations (in order, exactly once) to
 *     the DATABASE_URL database. Uses DATABASE_URL_UNPOOLED when provided,
 *     as providers recommend running migrations on a direct connection.
 *
 * NEVER use `drizzle-kit push` in production: schema must change only through
 * the version-controlled migrations in ./drizzle.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
