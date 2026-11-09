/** Launch the Next.js dev server as a detached daemon (survives tool sessions). */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
const out = openSync("dev.log", "a");
const child = spawn("bun", ["run", "dev"], {
  cwd: process.cwd(),
  detached: true,
  stdio: ["ignore", out, out],
  env: { ...process.env, FORCE_COLOR: "0" },
});
child.unref();
console.log("dev daemon pid:", child.pid);
