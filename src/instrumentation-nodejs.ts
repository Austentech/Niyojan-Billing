/**
 * Node.js-only instrumentation (imported exclusively from src/instrumentation.ts
 * when NEXT_RUNTIME === "nodejs").
 *
 * Starts the LOCAL verification harness alongside the dev server. See the
 * guard chain in src/instrumentation.ts — this never runs in production.
 *
 * Node built-ins are resolved through `process.getBuiltinModule` (Node ≥ 22)
 * instead of static `node:` imports so this module also compiles cleanly for
 * the Edge target — the runtime guards above mean these calls only ever
 * execute under the Node.js server runtime.
 */
interface ChildProcessModule {
  spawn: typeof import("node:child_process").spawn;
}

export async function registerNodejs(): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes("127.0.0.1:5435")) return;

  try {
    const proc = process as typeof process & {
      getBuiltinModule?: (id: string) => unknown;
    };
    const childProcess = proc.getBuiltinModule?.("node:child_process") as ChildProcessModule | undefined;
    if (!childProcess) return;

    const child = childProcess.spawn("node", ["verify-harness/start.mjs"], {
      cwd: process.env.PWD ?? ".",
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.info("[instrumentation] local verification harness start requested");
  } catch (err) {
    console.error("[instrumentation] failed to request the local harness:", err);
  }
}
