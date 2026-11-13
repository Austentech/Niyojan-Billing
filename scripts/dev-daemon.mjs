/** Launch the Next.js dev server as a detached daemon (survives tool sessions). */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

// The sandbox shell may carry stale Prisma-era DATABASE_URL=file:... values;
// process.env always wins over .env files in Next.js, so drop it here and let
// the project's .env (the single source of truth) provide the real one.
const env = { ...process.env, FORCE_COLOR: "0" };
if (env.DATABASE_URL && env.DATABASE_URL.startsWith("file:")) {
  delete env.DATABASE_URL;
}

const out = openSync("dev.log", "a");
const child = spawn("bun", ["run", "dev"], {
  cwd: process.cwd(),
  detached: true,
  stdio: ["ignore", out, out],
  env,
});
child.unref();
console.log("dev daemon pid:", child.pid);
