import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import { getServerEnv } from "@/lib/config/env";
import * as schema from "./schema";

/**
 * SINGLE reusable database connection module — every application query in
 * the entire codebase flows through here (Drizzle ORM over postgres.js).
 *
 * SERVERLESS-SAFE BY DESIGN
 *   * Lazy singletons — nothing connects at import time, so `next build`
 *     and cold starts never require live credentials.
 *   * Small pool + no prepared statements: safe behind transaction-mode
 *     connection poolers (Neon's -pooler endpoints, PgBouncer) and across
 *     serverless instance churn.
 *   * TLS enabled for every non-local host (Neon/Lakebase both require it);
 *     `?sslmode=disable` in the URL opts out for local development.
 *   * Credentials are read from the validated environment only — the
 *     connection string is NEVER logged or returned to any client.
 */

export type Db = PostgresJsDatabase<typeof schema>;

interface DbState {
  key: string;
  client: Sql;
  db: Db;
}

let state: DbState | null = null;

/** TLS decision derived from the connection URL — see module doc. */
function sslFor(url: URL): boolean | "require" {
  const sslmode = url.searchParams.get("sslmode") ?? url.searchParams.get("ssl");
  if (sslmode === "disable") return false;
  const host = url.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (isLocal && !sslmode) return false;
  return "require";
}

function createState(connectionString: string): DbState {
  const url = new URL(connectionString);
  const client = postgres(connectionString, {
    // Transaction-mode poolers reject named prepared statements; a single-admin
    // console loses nothing by disabling them everywhere.
    prepare: false,
    // Small bounded pool — serverless-friendly (per-instance).
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: sslFor(url),
  });
  return { key: connectionString, client, db: drizzle(client, { schema }) };
}

function getState(): DbState {
  const env = getServerEnv();
  // Rebuild when the connection input changes (e.g. the local verification
  // harness re-writing .env) — never serve a client built from stale creds.
  if (state && state.key === env.DATABASE_URL) return state;
  state = createState(env.DATABASE_URL);
  return state;
}

/** The Drizzle database (typed against the full schema). */
export function getDb(): Db {
  return getState().db;
}

/**
 * The raw postgres.js client — used ONLY for parameterized calls to the
 * migration-defined SECURITY DEFINER functions (auth_consume_otp, ...).
 * Never interpolate user input into these templates; always bind parameters.
 */
export function getSql(): Sql {
  return getState().client;
}

/**
 * Close the pooled connections (used by test scripts and graceful shutdown).
 * The next call rebuilds lazily.
 */
export async function closeDb(): Promise<void> {
  if (state) {
    await state.client.end({ timeout: 5 });
    state = null;
  }
}

/** Normalize any timestamp the driver returns into an ISO 8601 UTC string. */
export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
