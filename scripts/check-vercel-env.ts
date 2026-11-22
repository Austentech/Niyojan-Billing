import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Pre-flight check for Vercel (or any production target) environment values.
 *
 * Runs the EXACT same validation as the production server (src/lib/config/env
 * parseEnv) against a .env-style file that mirrors what you pasted into
 * Vercel → Settings → Environment Variables, so a failing variable is
 * identified by NAME before you redeploy. Values are never printed.
 *
 * Usage:
 *   bun run check:env [file] [--development]
 *   npx tsx scripts/check-vercel-env.ts [file] [--development]
 *
 *   file          path to the env file (default: .env-vercel-check)
 *   --development validate as NODE_ENV=development (default: production)
 *
 * Exit codes: 0 = values would be accepted, 1 = validation failed,
 *             2 = usage / file error.
 */

/** One-line fix hints per variable (names match the zod schema paths). */
const HINTS: Record<string, string> = {
  ADMIN_NAME: "1-120 characters after trimming.",
  ADMIN_USERNAME: "3-64 chars, only a-z 0-9 . _ - (it is stored lowercase).",
  ADMIN_PASSWORD:
    "12-128 chars containing an uppercase letter, a lowercase letter, a digit AND a symbol.",
  ADMIN_EMAIL: "must be a valid email address (OTP codes are sent there).",
  DATABASE_URL:
    "must be a postgres:// or postgresql:// connection string — no surrounding quotes, no 'export' prefix; URL-encode special characters in the password ('@' -> '%40').",
  DATABASE_URL_UNPOOLED:
    "same rules as DATABASE_URL; delete the variable entirely if unused.",
  SMTP_HOST: "non-empty host name, e.g. smtp.resend.com.",
  SMTP_PORT: "a whole number 1-65535, e.g. 587.",
  SMTP_SECURE:
    'must be exactly "true" or "false" (port 465 -> true). An EMPTY value fails: delete the variable or set a real one.',
  SMTP_USER: "max 254 characters (may be empty only if your SMTP relay needs no auth).",
  SMTP_PASSWORD: "max 512 characters.",
  SMTP_FROM: "must be a valid, verified sender email address.",
  SMTP_DEV_CAPTURE:
    'must be "true" or "false". Never set it to "true" on Vercel; an EMPTY value fails — delete the variable instead.',
  SMTP_DEV_OUTBOX: "max 512 characters (development only).",
  LOGO_STORAGE_MODE:
    'must be "url", "s3" or "local"; "local" is REJECTED in production; an EMPTY value fails — delete the variable or set "url".',
  S3_ENDPOINT: "must be a valid URL (or delete it when not using S3).",
  S3_REGION: "required when LOGO_STORAGE_MODE=s3.",
  S3_BUCKET: "required when LOGO_STORAGE_MODE=s3.",
  S3_ACCESS_KEY_ID: "required when LOGO_STORAGE_MODE=s3.",
  S3_SECRET_ACCESS_KEY: "required when LOGO_STORAGE_MODE=s3.",
  S3_PUBLIC_BASE_URL: "must be a valid URL (or delete it).",
  AUTH_SESSION_SECRET:
    "at least 32 random characters (openssl rand -base64 48) and DIFFERENT from OTP_SECRET.",
  OTP_SECRET:
    "at least 32 random characters (openssl rand -base64 48) and DIFFERENT from AUTH_SESSION_SECRET.",
  APP_URL:
    "full origin with protocol and no trailing slash, e.g. https://your-app.vercel.app.",
};

/** Load the file into a record WITHOUT touching process.env (clean-room model). */
function loadEnvFile(file: string): { values: Record<string, string>; quoted: Set<string> } {
  const content = readFileSync(file, "utf8");
  const values: Record<string, string> = {};
  const quoted = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
      quoted.add(key);
    }
    values[key] = value;
  }
  return { values, quoted };
}

/**
 * Cross-field rules (mirror of validateCrossField in src/lib/config/env.ts),
 * evaluated even when the flat schema already failed.
 */
function crossFieldProblems(values: Record<string, string>): string[] {
  const problems: string[] = [];
  const session = values.AUTH_SESSION_SECRET;
  const otp = values.OTP_SECRET;
  if (session !== undefined && otp !== undefined && session === otp) {
    problems.push("AUTH_SESSION_SECRET", "OTP_SECRET (must differ)");
  }
  if (process.env.NODE_ENV === "production" && values.LOGO_STORAGE_MODE === "local") {
    problems.push("LOGO_STORAGE_MODE (local is development-only)");
  }
  if (values.LOGO_STORAGE_MODE === "s3") {
    for (const name of ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
      if (!values[name]) problems.push(name);
    }
  }
  return problems;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const development = args.includes("--development");
  const fileArg = args.find((a) => !a.startsWith("--")) ?? ".env-vercel-check";
  const file = path.resolve(process.cwd(), fileArg);

  let loaded: ReturnType<typeof loadEnvFile>;
  try {
    loaded = loadEnvFile(file);
  } catch {
    console.error(`[check:env] cannot read "${fileArg}".`);
    console.error("[check:env] create it with the EXACT values you pasted into Vercel, then re-run:");
    console.error("             bun run check:env <file>");
    return 2;
  }
  if (Object.keys(loaded.values).length === 0) {
    console.error(`[check:env] "${fileArg}" contains no KEY=VALUE lines.`);
    return 2;
  }

  // The LOGO_STORAGE_MODE=local production guard reads NODE_ENV, so simulate
  // the target environment before validating.
  process.env.NODE_ENV = development ? "development" : "production";

  const { parseEnv, EnvConfigError } = await import("../src/lib/config/env");
  console.log(`[check:env] validating ${Object.keys(loaded.values).length} variables as NODE_ENV=${process.env.NODE_ENV}`);
  console.log("[check:env] (values are never printed — only variable names)\n");

  if (loaded.quoted.size > 0) {
    console.log(
      `[check:env] NOTE: quotes were stripped for local parsing: ${[...loaded.quoted].join(", ")}.` +
        " In the VERCEL dialog paste values WITHOUT surrounding quotes.",
    );
  }

  try {
    parseEnv(loaded.values);
  } catch (err) {
    if (!(err instanceof EnvConfigError)) throw err;
    // The app skips cross-field rules when the schema itself fails; surface
    // them here anyway (deduped — parseEnv already includes them when the
    // schema passed) so ONE fix-and-redeploy round is enough.
    const problems = [...err.invalidVars];
    for (const p of crossFieldProblems(loaded.values)) {
      if (!problems.includes(p)) problems.push(p);
    }
    console.error(`[check:env] FAIL — ${problems.length} problem(s):\n`);
    for (const rawName of problems) {
      // Cross-field issues append a parenthetical, e.g. "OTP_SECRET (must differ)".
      const base = rawName.replace(/\s*\(.*\)\s*$/, "");
      console.error(`  ✗ ${rawName}`);
      console.error(`    → ${HINTS[base] ?? "see .env.example for the expected format."}`);
    }
    console.error(
      "\n[check:env] fix these in Vercel → Settings → Environment Variables (Production scope)," +
        " then REDEPLOY the latest deployment.",
    );
    return 1;
  }

  console.log("[check:env] PASS — the production server would accept these values.");
  console.log(
    "[check:env] if the banner still shows after pasting them into Vercel, the problem is NOT the values:" +
      " check (1) scope = Production, (2) a REDEPLOY after the change, (3) /api returns status ok.",
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[check:env] unexpected error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
