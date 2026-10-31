import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Minimal .env loader for test scripts (no external dependency).
 * Mirrors the common dotenv semantics: KEY=VALUE lines, # comments,
 * values already present in the environment are NOT overridden.
 */
export function loadDotEnv(relativePath = ".env"): void {
  const file = path.resolve(process.cwd(), relativePath);
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
