/** Stop the local verification harness (PostgREST, proxy, PostgreSQL). */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";

const run = promisify(execFile);
const HARNESS_DIR = path.dirname(new URL(import.meta.url).pathname);
const PG_BIN = path.join(HARNESS_DIR, "node_modules/@embedded-postgres/linux-x64/native/bin");
const PG_DATA = path.join(HARNESS_DIR, "pgdata");

async function main() {
  // Kill PostgREST by pid if recorded.
  try {
    const state = JSON.parse(readFileSync(path.join(HARNESS_DIR, "harness-state.json"), "utf8"));
    if (state.postgrestPid) {
      try {
        process.kill(state.postgrestPid, "SIGTERM");
        console.log(`[harness] stopped PostgREST (pid ${state.postgrestPid})`);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no state file */
  }

  // Stop PostgreSQL.
  try {
    await run(path.join(PG_BIN, "pg_ctl"), ["-D", PG_DATA, "stop", "-m", "fast"]);
    console.log("[harness] stopped PostgreSQL");
  } catch (err) {
    console.log("[harness] PostgreSQL not running or already stopped");
  }

  // Stop any lingering prefix proxy listening on 5435.
  const req = http.request(
    { host: "127.0.0.1", port: 5435, method: "DELETE", path: "/__harness_shutdown__" },
    () => {},
  );
  req.on("error", () => {});
  req.end();
}

main();
