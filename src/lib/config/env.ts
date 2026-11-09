import { z } from "zod";

import { PASSWORD_POLICY } from "@/lib/constants";

/**
 * Server-side environment contract (Phase 1 authentication, Phase 2 firm
 * management, Phase 3 account settings).
 *
 * Validated lazily (never at import/build time) so `next build` succeeds
 * without credentials. Validation failures list VARIABLE NAMES ONLY — values
 * are never included in error output.
 *
 * This module must never be imported from a client component: it parses
 * server secrets (SUPABASE_SERVICE_ROLE_KEY, SMTP_PASSWORD, OTP_SECRET...).
 */

const storageModeSchema = z.enum(["supabase", "local"]);

const envSchema = z
  .object({
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

    // --- Logo storage (Phases 2 & 3) ----------------------------------------------
    // "supabase" (default) — dedicated Supabase Storage buckets (firm-logos,
    //   corporation-logos) written by the service-role client.
    // "local" — development/staging adapter that stores files on disk and
    //   serves them through the /uploads route (used by the verification
    //   harness, which has no Storage API). NEVER set "local" in production.
    // LOGO_STORAGE_MODE is canonical; FIRM_LOGO_STORAGE_MODE is a legacy
    // Phase 2 alias that still takes effect when only it is set.
    LOGO_STORAGE_MODE: storageModeSchema.optional(),
    FIRM_LOGO_STORAGE_MODE: storageModeSchema.optional(),

    // --- Secrets -------------------------------------------------------------------
    AUTH_SESSION_SECRET: z.string().min(32).max(512),
    OTP_SECRET: z.string().min(32).max(512),

    // --- Application -----------------------------------------------------------------
    APP_URL: z.url(),
  })
  .transform((raw) => ({
    ...raw,
    LOGO_STORAGE_MODE: raw.LOGO_STORAGE_MODE ?? raw.FIRM_LOGO_STORAGE_MODE ?? ("supabase" as const),
  }));

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
  const inputs = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}|${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}|${process.env.SMTP_HOST ?? ""}`;
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
