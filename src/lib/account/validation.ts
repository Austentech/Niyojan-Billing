import { z } from "zod";

import { CORPORATION_LOGO_POLICY, CORPORATION_POLICY, EMAIL_CHANGE_POLICY, OTP_LENGTH } from "@/lib/constants";
import { normalizeOtpCode } from "@/lib/auth/validation";

/**
 * Account Settings validation — ONE schema set shared by the client
 * (react-hook-form resolver, immediate UX feedback) and the server
 * (authoritative re-validation inside the server action).
 */

/** Corporation name (the brand shown across the console). */
export const corporationNameSchema = z
  .string()
  .trim()
  .min(CORPORATION_POLICY.nameMinLength, `Corporation name must be at least ${CORPORATION_POLICY.nameMinLength} characters.`)
  .max(CORPORATION_POLICY.nameMaxLength, `Corporation name must be at most ${CORPORATION_POLICY.nameMaxLength} characters.`);

/** Administrator display name (rendered in the header, greeting, etc.). */
export const displayNameSchema = z
  .string()
  .trim()
  .min(CORPORATION_POLICY.displayNameMinLength, `Administrator name must be at least ${CORPORATION_POLICY.displayNameMinLength} characters.`)
  .max(CORPORATION_POLICY.displayNameMaxLength, `Administrator name must be at most ${CORPORATION_POLICY.displayNameMaxLength} characters.`);

/** Administrator email — strict address format, stored lowercase. */
export const adminEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Enter a valid email address.")
  .max(CORPORATION_POLICY.emailMaxLength, `Email must be at most ${CORPORATION_POLICY.emailMaxLength} characters.`)
  .refine((value) => z.email().safeParse(value).success, "Enter a valid email address.");

/** Corporation profile form (client + server). */
export const corporationProfileSchema = z.object({
  corporationName: corporationNameSchema,
  displayName: displayNameSchema,
  email: adminEmailSchema,
});

export type CorporationProfileInput = z.input<typeof corporationProfileSchema>;
export type CorporationProfileServiceInput = z.output<typeof corporationProfileSchema>;

/** Email-change confirmation code — same normalization as the sign-in OTP. */
export const emailChangeCodeSchema = z
  .string()
  .transform((v) => normalizeOtpCode(v))
  .refine((v) => v.length === OTP_LENGTH, {
    message: `The confirmation code is ${OTP_LENGTH} characters (uppercase letters and digits).`,
  });

/** Flatten a failed parse into { field: message } for form display. */
export function accountFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0]?.toString() ?? "form";
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

/** Human-readable email-change code lifetime (for UI hints). */
export const EMAIL_CHANGE_TTL_MINUTES = Math.round(EMAIL_CHANGE_POLICY.ttlSeconds / 60);

/* ============================================================================
 * LOGO UPLOAD VALIDATION (client-side pre-check; the server re-verifies from
 * the actual bytes — magic-byte sniffing + sharp decode — and is the only
 * authority that matters).
 * ==========================================================================*/

export const CORPORATION_LOGO_ACCEPT_ATTRIBUTE = CORPORATION_LOGO_POLICY.extensions
  .map((ext) => `.${ext}`)
  .join(",");

/** Immediate client-side feedback for a chosen File; null when acceptable. */
export function clientCorporationLogoError(file: File | null | undefined): string | null {
  if (!file || file.size === 0) return null; // optional field
  if (file.size > CORPORATION_LOGO_POLICY.maxBytes) {
    return "Corporation logo must be at most 2 MB.";
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(CORPORATION_LOGO_POLICY.extensions as readonly string[]).includes(ext)) {
    return "Corporation logo must be a PNG, JPG, JPEG or WebP image.";
  }
  if (!(CORPORATION_LOGO_POLICY.mimeTypes as readonly string[]).includes(file.type)) {
    return "Corporation logo must be a PNG, JPG, JPEG or WebP image.";
  }
  return null;
}
