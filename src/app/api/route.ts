import { NextResponse } from "next/server";

import { getSupabaseServiceClient } from "@/lib/auth/server/db";
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
    const { error } = await getSupabaseServiceClient().rpc("auth_lockout_state");
    if (error) {
      return NextResponse.json({ status: "degraded", database: "unreachable" }, { status: 503 });
    }
    return NextResponse.json({ status: "ok", database: "reachable" });
  } catch {
    return NextResponse.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
