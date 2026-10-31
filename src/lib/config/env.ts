import { z } from "zod";

/**
 * Server-side environment contract for Phase 1 (authentication).
 *
 * Validated lazily (never at import/build time) so `next build` succeeds
 * without credentials. Validation failures list VARIABLE NAMES ONLY — values
 * are never included in error output.
 *
 * This module must never be imported from a client component: it parses
 * server secrets (SUPABASE_SERVICE_ROLE_KEY, SMTP_PASSWORD, OTP_SECRET...).
 */

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
  ADMIN_PASSWORD: z.string().min(10).max(128),
  ADMIN_EMAIL: z.email().max(254),

  // --- Supabase ---------------------------------------------------------------
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // --- SMTP --------------------------------------------------------------------
  SMTP_HOST: z.string().trim().min(1).max(253),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: z.string().max(254).default(""),
  SMTP_PASSWORD: z.string().max(512).default(""),
  SMTP_FROM: z.email().max(254),
  SMTP_DEV_CAPTURE: z.enum(["true", "false"]).default("false"),
  SMTP_DEV_OUTBOX: z.string().max(512).default(".dev-outbox"),

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
  if (parsed.data.AUTH_SESSION_SECRET === parsed.data.OTP_SECRET) {
    throw new EnvConfigError(["AUTH_SESSION_SECRET", "OTP_SECRET (must differ)"]);
  }
  return parsed.data;
}

let cached: ServerEnv | null = null;

/** Parse and cache the server environment. Throws EnvConfigError on problems. */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  cached = parseEnv(process.env);
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
