"use server";

import { revalidatePath } from "next/cache";

import { EnvConfigError } from "@/lib/config/env";
import { PublicAuthError, RequestBlockedError, SystemAuthError } from "@/lib/auth/errors";
import { assertTrustedMutation } from "@/lib/auth/server/request-guard";
import { enforceRateLimit } from "@/lib/auth/server/rate-limit";
import { getSessionContext } from "@/lib/auth/server/context";
import { PublicFirmError, SystemFirmError, logFirmError } from "@/lib/firms/errors";
import { storeFirmLogo } from "@/lib/firms/storage";
import { createFirm } from "@/lib/firms/service";
import { firmFormSchema } from "@/lib/firms/validation";
import { RATE_LIMITS } from "@/lib/constants";
import type { FirmActionState } from "@/types/firms";

/**
 * Server Action — the ONLY state-changing firm endpoint.
 *
 * Every invocation, in order:
 *   1. server-side session authorization (only the authenticated
 *      administrator may add firms),
 *   2. origin + CSRF double-submit validation,
 *   3. distributed rate limiting on the write operation,
 *   4. server-authoritative field validation (Zod),
 *   5. logo hardening (magic bytes + sharp re-encode) and upload,
 *   6. parameterized insert into public.firms,
 *   7. revalidation of every surface that renders firm data.
 *
 * Errors are mapped to safe client states — no internal detail, no storage
 * paths, no identifiers ever reach the browser.
 */

function mapFirmError(err: unknown): FirmActionState {
  if (err instanceof EnvConfigError) {
    return {
      status: "config_error",
      message: "Server configuration is incomplete. Please contact your operator.",
    };
  }
  if (err instanceof RequestBlockedError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof PublicFirmError) {
    // Logo rejections carry a public-safe message; show them on the field.
    return { status: "invalid", fieldErrors: { logo: err.message } };
  }
  if (err instanceof SystemFirmError || err instanceof SystemAuthError) {
    return { status: "unavailable", message: err.message };
  }
  if (err instanceof PublicAuthError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  logFirmError("firm_action_unexpected_error", err);
  return {
    status: "unavailable",
    message: "Firm management is temporarily unavailable. Please try again shortly.",
  };
}

export async function createFirmAction(_prev: FirmActionState, formData: FormData): Promise<FirmActionState> {
  try {
    /* --- 1. Authorization ---------------------------------------------------- */
    const session = await getSessionContext();
    if (!session) {
      return {
        status: "unauthorized",
        message: "Your session has expired. Please sign in again to continue.",
      };
    }

    /* --- 2. Origin + CSRF ------------------------------------------------------ */
    await assertTrustedMutation(formData);

    /* --- 3. Rate limit (write operation) ---------------------------------------- */
    await enforceRateLimit(
      "firms:create",
      RATE_LIMITS.firmCreate.limit,
      RATE_LIMITS.firmCreate.windowSeconds,
    );

    /* --- 4. Authoritative field validation ---------------------------------------- */
    const raw = {
      firmName: String(formData.get("firmName") ?? ""),
      websiteUrl: String(formData.get("websiteUrl") ?? ""),
      holdingPercentage: String(formData.get("holdingPercentage") ?? ""),
      address: String(formData.get("address") ?? ""),
      description: String(formData.get("description") ?? ""),
    };
    const parsed = firmFormSchema.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0]?.toString() ?? "form";
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return { status: "invalid", fieldErrors };
    }

    /* --- 5. Optional logo: harden + upload ------------------------------------------ */
    const logoEntry = formData.get("logo");
    let logoUrl: string | null = null;
    if (logoEntry instanceof File && logoEntry.size > 0) {
      const bytes = Buffer.from(await logoEntry.arrayBuffer());
      logoUrl = await storeFirmLogo(bytes);
    }

    /* --- 6. Insert (parameterized via the service client) ------------------------------ */
    const result = await createFirm(raw, logoUrl);
    if (result.status === "invalid") {
      return { status: "invalid", fieldErrors: result.fieldErrors };
    }

    /* --- 7. Refresh every firm-driven surface ------------------------------------------- */
    revalidatePath("/dashboard");
    revalidatePath("/settings/firms");

    return { status: "created", firmName: result.firm.name };
  } catch (err) {
    return mapFirmError(err);
  }
}
