import { NextResponse } from "next/server";

import { getSql } from "@/lib/db";
import { isServerEnvConfigured } from "@/lib/config/env";

/**
 * Liveness / readiness probe. Verifies the process is up, the environment is
 * parsed and the database is reachable. Exposes NO application data — only
 * aggregate status flags.
 */
export async function GET() {
  if (!isServerEnvConfigured()) {
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
