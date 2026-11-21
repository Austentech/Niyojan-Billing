/**
 * Local verification harness — REAL PostgreSQL for the Drizzle stack.
 * =====================================================================
 *   PostgreSQL 18   127.0.0.1:5433   (embedded binaries, data in pgdata/)
 *   Database        niyojan          (migrated with drizzle-kit migrate)
 *
 * The application connects with DATABASE_URL exactly as it will against Neon
 * or Lakebase in production (Drizzle ORM over postgres.js, same migration
 * files, same SECURITY DEFINER functions).
 *
 * SANDBOX/STAGING ONLY — never run in production.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import pg from "pg";

const run = promisify(execFile);

const HARNESS_DIR = path.dirname(new URL(import.meta.url).pathname);
const PG_BIN = path.join(HARNESS_DIR, "node_modules/@embedded-postgres/linux-x64/native/bin");
const PG_DATA = path.join(HARNESS_DIR, "pgdata");

const PG_PORT = 5433;
const DB_NAME = "niyojan";
const DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;

/* --- ICU 60 compatibility --------------------------------------------------- */
/* The embedded PostgreSQL 18 binaries link libicuuc.so.60 (version-suffixed
 * ICU symbols — a newer system ICU cannot substitute). If a compatible copy
 * has been extracted into pglibs/icu60/ (see pglibs/icu60/README), prepend it
 * to LD_LIBRARY_PATH so initdb/pg_ctl/postgres resolve it. No-op on machines
 * where the system ICU already matches. */
const ICU_DIR = path.join(HARNESS_DIR, "pglibs/icu60/extracted/usr/lib/x86_64-linux-gnu");
if (existsSync(path.join(ICU_DIR, "libicuuc.so.60"))) {
  process.env.LD_LIBRARY_PATH = [ICU_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}

/* --- Helpers ------------------------------------------------------------------ */

function spawnDetached(command, args, env, logFile) {
  const out = openSync(logFile, "a");
  const child = spawn(command, args, { env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  return child.pid;
}

async function waitForTcp(port, host = "127.0.0.1", timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 500);
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${host}:${port}`);
}

async function superuserClient(database = "postgres") {
  const client = new pg.Client({
    host: "127.0.0.1",
    port: PG_PORT,
    user: "postgres",
    password: "postgres",
    database,
  });
  await client.connect();
  return client;
}

async function isHealthy() {
  try {
    const client = await superuserClient(DB_NAME);
    const result = await client.query("select auth_lockout_state() is not null as ok");
    await client.end();
    return result.rows[0]?.ok === true;
  } catch {
    return false;
  }
}

/* --- Main --------------------------------------------------------------------- */

async function main() {
  mkdirSync(path.join(HARNESS_DIR, "logs"), { recursive: true });

  /* 0. Fast path: stack already healthy? (idempotent re-runs) ---------------- */
  if (await isHealthy()) {
    console.log("[harness] already running and healthy — nothing to do");
    process.exit(0);
  }

  /* 1. Initialize + start PostgreSQL --------------------------------------- */
  if (!existsSync(path.join(PG_DATA, "PG_VERSION"))) {
    console.log("[harness] initializing PostgreSQL data directory...");
    await run(path.join(PG_BIN, "initdb"), [
      "-D", PG_DATA, "-U", "postgres",
      "--auth=trust", "-E", "UTF8",
    ]);
  }

  try {
    await run(path.join(PG_BIN, "pg_ctl"), ["-D", PG_DATA, "status"]);
    console.log("[harness] PostgreSQL already running");
  } catch {
    console.log("[harness] starting PostgreSQL on :5433 ...");
    await run(path.join(PG_BIN, "pg_ctl"), [
      "-D", PG_DATA,
      "-o", `-p ${PG_PORT} -k ${PG_DATA}`,
      "-l", path.join(HARNESS_DIR, "logs/postgres.log"),
      "start",
    ]);
    await waitForTcp(PG_PORT);
  }

  /* 2. Database + unprivileged probe role -------------------------------------- */
  // niyojan_anon: a LOGIN role with ZERO table privileges. The integration
  // tests connect as it to prove the unprivileged database surface stays
  // blocked (the successor to the Supabase-era anon/RLS checks).
  const admin = await superuserClient();
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'niyojan_anon') then
      create role niyojan_anon login;
    end if;
  end $$;`);

  const dbExists = await admin.query("select 1 from pg_database where datname = $1", [DB_NAME]);
  if (dbExists.rowCount === 0) {
    console.log(`[harness] creating database ${DB_NAME} ...`);
    await admin.query(`create database ${DB_NAME}`);
  }
  await admin.end();

  /* 3. Apply Drizzle migrations (the REAL migration machinery) ----------------- */
  console.log("[harness] applying Drizzle migrations (drizzle-kit migrate) ...");
  const migrateEnv = {
    ...process.env,
    DATABASE_URL,
    DATABASE_URL_UNPOOLED: DATABASE_URL,
    NODE_ENV: "development",
  };
  const migrateLog = openSync(path.join(HARNESS_DIR, "logs/migrate.log"), "a");
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "bunx.cmd" : "bunx",
      ["drizzle-kit", "migrate", "--config=drizzle.config.ts"],
      { cwd: path.join(HARNESS_DIR, ".."), env: migrateEnv, stdio: ["ignore", migrateLog, migrateLog] },
    );
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`drizzle-kit migrate exited with code ${code} (see verify-harness/logs/migrate.log)`));
    });
    child.on("error", reject);
  });

  /* 4. Health verification ------------------------------------------------------- */
  if (!(await isHealthy())) {
    console.error("[harness] health check FAILED after migration — inspect verify-harness/logs/");
    process.exit(1);
  }

  console.log(`[harness] ready — PostgreSQL on :${PG_PORT}, database ${DB_NAME}`);
  console.log(`[harness] DATABASE_URL=${DATABASE_URL}`);
}

main().catch((err) => {
  console.error(`[harness] ${err.message ?? err}`);
  process.exit(1);
});
