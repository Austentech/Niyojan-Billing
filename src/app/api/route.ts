import { NextResponse } from "next/server";

import { getSql } from "@/lib/db";
import { EnvConfigError, getServerEnv } from "@/lib/config/env";

/**
 * Liveness / readiness probe. Verifies the process is up, the environment is
 * parsed and the database is reachable. Exposes NO application data — only
 * aggregate status flags.
 *
 * When configuration is invalid, the failing variable NAMES (never values)
 * are logged as "[api] env_config_invalid" so an operator can diagnose a
 * broken deployment from the runtime logs WITHOUT a sign-in attempt.
 */
export async function GET() {
  try {
    getServerEnv();
  } catch (err) {
    if (err instanceof EnvConfigError) {
      // Names only by construction — see src/lib/config/env.ts.
      console.error(`[api] env_config_invalid detail="${err.message}"`);
    }
    return NextResponse.json({ status: "degraded", environment: "unconfigured" }, { status: 503 });
  }

  try {
    // Lightweight authenticated probe: the lockout-state function touches the
    // security tables without exposing any value.
    await getSql()`select auth_lockout_state()`;
    return NextResponse.json({ status: "ok", database: "reachable" });
  } catch {
    return NextResponse.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
