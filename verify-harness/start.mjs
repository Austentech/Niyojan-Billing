/**
 * Local verification harness — REAL PostgreSQL + REAL PostgREST stack.
 * =====================================================================
 * Mirrors the Supabase architecture so the application's Supabase client,
 * SQL migrations, RPC functions, RLS policies and role grants run EXACTLY as
 * they will against the production project:
 *
 *   PostgreSQL 18   127.0.0.1:5433   (embedded binaries, data in pgdata/)
 *   PostgREST 12    127.0.0.1:5434   (API layer, JWT auth like Supabase)
 *   prefix proxy    127.0.0.1:5435   (exposes /rest/v1 — the Supabase shape)
 *
 * Roles mirror Supabase: authenticator (PostgREST connection), anon,
 * authenticated, service_role (BYPASSRLS). The service-role JWT generated
 * here is written into the app .env so @supabase/supabase-js authenticates
 * exactly as it would on Supabase.
 *
 * SANDBOX/STAGING ONLY — never run in production.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import http from "node:http";
import pg from "pg";
import { startPrefixProxy } from "./proxy.mjs";

const run = promisify(execFile);

const HARNESS_DIR = path.dirname(new URL(import.meta.url).pathname);
const PG_BIN = path.join(HARNESS_DIR, "node_modules/@embedded-postgres/linux-x64/native/bin");
const PG_DATA = path.join(HARNESS_DIR, "pgdata");
const MIGRATION_SQL = readFileSync(path.join(HARNESS_DIR, "../supabase/migrations/0001_auth_core.sql"), "utf8");
const APP_ENV = path.join(HARNESS_DIR, "../.env");

const PG_PORT = 5433;
const POSTGREST_PORT = 5434;
const PROXY_PORT = 5435;
const DB_NAME = "niyojan";

/* --- JWT helpers (HS256, like Supabase) ----------------------------------- */

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function makeJwt(secret, role) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({ role, iss: "local-harness", iat: now, exp: now + 60 * 60 * 24 * 365 }),
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/* --- Process helpers -------------------------------------------------------- */

function spawnDetached(command, args, env, logFile) {
  const out = openSync(logFile, "a");
  const child = spawn(command, args, {
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return child.pid;
}

async function waitForTcp(port, host = "127.0.0.1", timeoutMs = 20000) {
  const net = await import("node:net");
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
    database,
  });
  await client.connect();
  return client;
}

/* --- Main --------------------------------------------------------------------- */

async function main() {
  mkdirSync(path.join(HARNESS_DIR, "logs"), { recursive: true });

  /* 0. Fast path: stack already healthy? (idempotent re-runs) ---------------- */
  try {
    const env = readFileSync(APP_ENV, "utf8");
    const existingKey = env.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m)?.[1];
    if (existingKey && !existingKey.includes("local-service-role-jwt")) {
      const probe = await new Promise((resolve) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: PROXY_PORT,
            method: "POST",
            path: "/rest/v1/rpc/auth_lockout_state",
            headers: {
              "content-type": "application/json",
              apikey: existingKey,
              authorization: `Bearer ${existingKey}`,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          },
        );
        req.on("error", () => resolve(false));
        req.end();
      });
      if (probe) {
        console.log("[harness] already running and healthy — nothing to do");
        process.exit(0);
      }
    }
    // Stale proxy may hold the port without a working backend: shut it down.
    const shutdown = http.request(
      { host: "127.0.0.1", port: PROXY_PORT, method: "DELETE", path: "/__harness_shutdown__" },
      () => {},
    );
    shutdown.on("error", () => {});
    shutdown.end();
  } catch {
    /* no .env yet — fresh start */
  }

  /* 1. Initialize + start PostgreSQL --------------------------------------- */
  if (!existsSync(path.join(PG_DATA, "PG_VERSION"))) {
    console.log("[harness] initializing PostgreSQL data directory...");
    await run(path.join(PG_BIN, "initdb"), ["-D", PG_DATA, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
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

  /* 2. Roles + database + migration ---------------------------------------- */
  const admin = await superuserClient();

  const roles = [
    ["anon", "nologin"],
    ["authenticated", "nologin"],
    ["service_role", "nologin bypassrls"],
    ["authenticator", "login"],
  ];
  for (const [role, options] of roles) {
    await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then
        execute 'create role ${role} ${options}';
      end if;
    end $$;`);
  }
  await admin.query("grant anon, authenticated, service_role to authenticator");
  await admin.query("grant usage on schema public to anon, authenticated, service_role, authenticator");

  const dbExists = await admin.query("select 1 from pg_database where datname = $1", [DB_NAME]);
  if (dbExists.rowCount === 0) {
    console.log(`[harness] creating database ${DB_NAME} ...`);
    await admin.query(`create database ${DB_NAME}`);
  }
  await admin.end();

  const app = await superuserClient(DB_NAME);
  console.log("[harness] applying migration supabase/migrations/0001_auth_core.sql ...");
  await app.query(MIGRATION_SQL);
  await app.end();

  /* 3. JWT secrets ------------------------------------------------------------- */
  const jwtSecret = randomBytes(32).toString("base64url");
  const serviceRoleKey = makeJwt(jwtSecret, "service_role");
  const anonKey = makeJwt(jwtSecret, "anon");

  /* 4. PostgREST ---------------------------------------------------------------- */
  // Kill any stale instance from a previous run before rebinding the port.
  try {
    const { execSync } = await import("node:child_process");
    execSync(`pkill -f "${HARNESS_DIR}/bin/postgrest" || true`, { shell: "/bin/bash" });
  } catch {
    /* pkill not available or nothing to kill */
  }
  await new Promise((r) => setTimeout(r, 500));
  const postgrest = path.join(HARNESS_DIR, "bin/postgrest");
  const postgrestEnv = {
    ...process.env,
    PGRST_DB_URI: `postgres://authenticator@127.0.0.1:${PG_PORT}/${DB_NAME}`,
    PGRST_DB_SCHEMAS: "public",
    PGRST_DB_ANON_ROLE: "anon",
    PGRST_JWT_SECRET: jwtSecret,
    PGRST_SERVER_PORT: String(POSTGREST_PORT),
    PGRST_SERVER_HOST: "127.0.0.1",
    PGRST_LOG_LEVEL: "crit",
  };
  console.log("[harness] starting PostgREST on :5434 ...");
  const postgrestPid = spawnDetached(postgrest, [], postgrestEnv, path.join(HARNESS_DIR, "logs/postgrest.log"));
  await waitForTcp(POSTGREST_PORT);

  /* 5. /rest/v1 prefix proxy ------------------------------------------------------ */
  const proxyServer = await startPrefixProxy();
  console.log(`[harness] rest/v1 prefix proxy on :${PROXY_PORT}`);

  /* 6. Write the real keys into the app .env -------------------------------------- */
  let env = readFileSync(APP_ENV, "utf8");
  env = env.replace(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*$/m, `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`);
  env = env.replace(/^SUPABASE_SERVICE_ROLE_KEY=.*$/m, `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`);
  writeFileSync(APP_ENV, env);

  writeFileSync(
    path.join(HARNESS_DIR, "harness-state.json"),
    JSON.stringify(
      { postgrestPid, proxyPort: PROXY_PORT, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  /* 7. Smoke checks ------------------------------------------------------------------ */
  const probe = await new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PROXY_PORT,
        method: "POST",
        path: "/rest/v1/rpc/auth_lockout_state",
        headers: {
          "content-type": "application/json",
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end();
  });

  if (probe.status === 200) {
    console.log(`[harness] RPC probe OK -> ${probe.body.trim()}`);
    console.log(`[harness] READY: supabase url http://127.0.0.1:${PROXY_PORT} (keys written to .env)`);
  } else {
    console.error(`[harness] RPC probe FAILED (${probe.status}): ${probe.body}`);
    process.exitCode = 1;
  }

  // Keep the process alive holding the proxy server.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error("[harness] startup failed:", err);
  process.exit(1);
});
