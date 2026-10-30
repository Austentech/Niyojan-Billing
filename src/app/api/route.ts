import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Liveness / readiness probe. Verifies the process is up and the database is
 * reachable. Exposes no application data.
 */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", database: "reachable" });
  } catch {
    return NextResponse.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
