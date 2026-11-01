/**
 * Next.js instrumentation hook — LOCAL DEVELOPMENT ONLY.
 *
 * When the application is configured against the bundled verification harness
 * (NEXT_PUBLIC_SUPABASE_URL = http://127.0.0.1:5435), the harness stack
 * (PostgreSQL + PostgREST + the /rest/v1 proxy) is started automatically with
 * the dev server so the login flow works out of the box.
 *
 * Guards — the spawn can NEVER happen in a real deployment:
 *   * NEXT_RUNTIME === "nodejs"            (skip the edge runtime)
 *   * NODE_ENV !== "production"            (never in production servers/builds)
 *   * the Supabase URL points at the LOCAL harness, not a hosted project
 *
 * start.mjs is idempotent: when the harness is already healthy it exits
 * immediately, so repeated dev-server restarts are harmless.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Official Next.js pattern: nodejs-only code lives in a separate module
    // that is imported only here, so the Edge build never bundles it.
    const { registerNodejs } = await import("./instrumentation-nodejs");
    await registerNodejs();
  }
}
