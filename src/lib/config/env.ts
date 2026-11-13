import { z } from "zod";

import { PASSWORD_POLICY } from "@/lib/constants";

/**
 * Server-side environment contract (PostgreSQL + Drizzle architecture).
 *
 * Validated lazily (never at import/build time) so `next build` succeeds
 * without credentials. Validation failures list VARIABLE NAMES ONLY — values
 * are never included in error output.
 *
 * This module must never be imported from a client component: it parses
 * server secrets (DATABASE_URL, SMTP_PASSWORD, S3 keys, OTP_SECRET...).
 */

const storageModeSchema = z.enum(["url", "s3", "local"]);

/** postgres:// or postgresql:// connection string (optionally URL-encoded). */
const postgresUrl = z
  .url()
  .refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "must be a postgres:// or postgresql:// connection string",
  );

const envSchema = z.object({
  // --- Initial administrator (bootstrap only) --------------------------------
  ADMIN_NAME: z.string().trim().min(1).max(120),
  ADMIN_USERNAME: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9._-]+$/, "lowercase letters, digits, dot, underscore, hyphen"),
  // The bootstrap password must satisfy the same strong policy as Account
  // Settings password changes: 12+ chars, mixed case, digit, symbol.
  ADMIN_PASSWORD: z
    .string()
    .min(PASSWORD_POLICY.minLength, "minimum 12 characters")
    .max(PASSWORD_POLICY.maxLength)
    .regex(/[a-z]/, "one lowercase letter")
    .regex(/[A-Z]/, "one uppercase letter")
    .regex(/[0-9]/, "one digit")
    .regex(/[^A-Za-z0-9]/, "one symbol"),
  ADMIN_EMAIL: z.email().max(254),

  // --- PostgreSQL (Neon / Lakebase / any standard PostgreSQL) ------------------
  DATABASE_URL: postgresUrl,
  /** Optional unpooled/administrative connection (migrations). */
  DATABASE_URL_UNPOOLED: postgresUrl.optional(),

  // --- SMTP --------------------------------------------------------------------
  SMTP_HOST: z.string().trim().min(1).max(253),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: z.string().max(254).default(""),
  SMTP_PASSWORD: z.string().max(512).default(""),
  SMTP_FROM: z.email().max(254),
  SMTP_DEV_CAPTURE: z.enum(["true", "false"]).default("false"),
  SMTP_DEV_OUTBOX: z.string().max(512).default(".dev-outbox"),

  // --- Logo storage ---------------------------------------------------------------
  // "url" (default) — no object storage configured: logos are entered as
  //   validated http(s) URLs (or the bundled static asset is kept). Upload
  //   controls are hidden rather than pretending to work.
  // "s3" — persistent uploads to an S3-compatible object store (AWS S3,
  //   Cloudflare R2, Backblaze B2, MinIO, ...). Requires the S3_* group.
  // "local" — DEVELOPMENT/verification-harness adapter (filesystem + the
  //   sanitized /uploads route). NEVER allowed in production.
  LOGO_STORAGE_MODE: storageModeSchema.default("url"),

  // --- S3-compatible object storage (required when LOGO_STORAGE_MODE=s3) --------
  S3_ENDPOINT: z.url().max(512).optional(),
  S3_REGION: z.string().trim().min(1).max(64).optional(),
  S3_BUCKET: z.string().trim().min(1).max(128).optional(),
  S3_ACCESS_KEY_ID: z.string().trim().min(1).max(256).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).max(256).optional(),
  /** Public base for logo URLs; defaults to the provider's bucket URL. */
  S3_PUBLIC_BASE_URL: z.url().max(512).optional(),

  // --- Secrets -------------------------------------------------------------------
  AUTH_SESSION_SECRET: z.string().min(32).max(512),
  OTP_SECRET: z.string().min(32).max(512),

  // --- Application -----------------------------------------------------------------
  APP_URL: z.url(),
});

export type ServerEnv = z.infer<typeof envSchema>;

export class EnvConfigError extends Error {
  /** Variable names that failed validation — never contains values. */
  readonly invalidVars: readonly string[];

  constructor(invalidVars: readonly string[]) {
    super(
      `Server environment is not configured correctly (${invalidVars.join(", ")}). ` +
        "See .env.example for the required variables.",
    );
    this.name = "EnvConfigError";
    this.invalidVars = invalidVars;
  }
}

/** Cross-field rules the flat schema cannot express. */
function validateCrossField(env: z.infer<typeof envSchema>): readonly string[] {
  const problems: string[] = [];
  if (env.AUTH_SESSION_SECRET === env.OTP_SECRET) {
    problems.push("AUTH_SESSION_SECRET", "OTP_SECRET (must differ)");
  }
  if (env.LOGO_STORAGE_MODE === "s3") {
    const required = ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
    for (const name of required) {
      if (!env[name]) problems.push(name);
    }
  }
  if (env.LOGO_STORAGE_MODE === "local" && process.env.NODE_ENV === "production") {
    problems.push("LOGO_STORAGE_MODE (local is development-only)");
  }
  return problems;
}

/**
 * Pure validation (exported for unit tests): parses a raw record against the
 * environment contract. Throws EnvConfigError listing variable NAMES only.
 */
export function parseEnv(raw: Record<string, string | undefined>): ServerEnv {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const invalidVars = parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean);
    throw new EnvConfigError(invalidVars.length > 0 ? invalidVars : ["(unknown)"]);
  }
  const crossField = validateCrossField(parsed.data);
  if (crossField.length > 0) {
    throw new EnvConfigError(crossField);
  }
  return parsed.data;
}

let cached: ServerEnv | null = null;
let cachedInputs = "";

/**
 * Parse and cache the server environment. Throws EnvConfigError on problems.
 *
 * The cache is keyed by the inputs that actually build clients/transporters,
 * so a `.env` rewrite (e.g. the local verification harness re-minting keys)
 * is picked up by the NEXT call without a server restart (Next.js reloads
 * env files in dev without resetting module caches).
 */
export function getServerEnv(): ServerEnv {
  const inputs = `${process.env.DATABASE_URL ?? ""}|${process.env.SMTP_HOST ?? ""}`;
  if (cached && cachedInputs === inputs) return cached;
  cached = parseEnv(process.env);
  cachedInputs = inputs;
  return cached;
}

/** Non-throwing probe used to degrade rendering gracefully. */
export function isServerEnvConfigured(): boolean {
  try {
    getServerEnv();
    return true;
  } catch {
    return false;
  }
}

/** Development-only mail capture must never activate in production. */
export function isDevMailCaptureEnabled(env: ServerEnv): boolean {
  return env.SMTP_DEV_CAPTURE === "true" && process.env.NODE_ENV !== "production";
}

/** Whether logo UPLOADS are backed by persistent object storage. */
export function isLogoUploadEnabled(env: ServerEnv): boolean {
  return env.LOGO_STORAGE_MODE === "s3" || env.LOGO_STORAGE_MODE === "local";
}
