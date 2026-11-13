/** Stop the local verification harness (PostgreSQL). */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const HARNESS_DIR = path.dirname(new URL(import.meta.url).pathname);
const PG_BIN = path.join(HARNESS_DIR, "node_modules/@embedded-postgres/linux-x64/native/bin");
const PG_DATA = path.join(HARNESS_DIR, "pgdata");

async function main() {
  try {
    await run(path.join(PG_BIN, "pg_ctl"), ["-D", PG_DATA, "stop", "-m", "fast"]);
    console.log("[harness] stopped PostgreSQL");
  } catch {
    console.log("[harness] PostgreSQL not running or already stopped");
  }
}

main();
