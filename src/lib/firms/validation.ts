import { z } from "zod";

import { FIRM_LOGO_POLICY, FIRM_POLICY } from "@/lib/constants";

/**
 * Firm form validation — ONE schema shared by the client (react-hook-form
 * resolver, immediate UX feedback) and the server (authoritative check).
 *
 * The input shape is what the form produces (strings, empty = not provided);
 * the output shape is the typed service input after parsing.
 */

/** Optional URL: empty/whitespace -> undefined; must be a real http(s) URL. */
const optionalHttpUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.optional(
    z
      .string()
      .trim()
      .max(FIRM_POLICY.websiteUrlMaxLength, `Website URL must be at most ${FIRM_POLICY.websiteUrlMaxLength} characters.`)
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      }, "Enter a valid website URL starting with http:// or https://."),
  ),
);

/** Optional free-text description with a bounded length. */
const optionalDescription = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.optional(
    z.string().trim().max(FIRM_POLICY.descriptionMaxLength, `Basic details must be at most ${FIRM_POLICY.descriptionMaxLength} characters.`),
  ),
);

/**
 * Holding percentage: numeric string like "51", "51.5" or "51.25".
 * Up to two decimal places, bounded 0–100.
 */
const holdingPercentage = z
  .string()
  .trim()
  .regex(
    /^\d{1,3}(\.\d{1,2})?$/,
    "Enter the holding percentage as a number between 0 and 100 (up to two decimals), e.g. 51.25.",
  )
  .transform(Number)
  .refine(
    (value) => value >= FIRM_POLICY.holdingMin && value <= FIRM_POLICY.holdingMax,
    `Holding percentage must be between ${FIRM_POLICY.holdingMin} and ${FIRM_POLICY.holdingMax}.`,
  );

export const firmFormSchema = z.object({
  /** Required firm name. */
  firmName: z
    .string()
    .trim()
    .min(FIRM_POLICY.nameMinLength, `Firm name must be at least ${FIRM_POLICY.nameMinLength} characters.`)
    .max(FIRM_POLICY.nameMaxLength, `Firm name must be at most ${FIRM_POLICY.nameMaxLength} characters.`),
  /** Optional website URL (http/https only). */
  websiteUrl: optionalHttpUrl,
  /** Required holding percentage, 0–100, up to 2 decimals. */
  holdingPercentage,
  /** Required address. */
  address: z
    .string()
    .trim()
    .min(FIRM_POLICY.addressMinLength, `Address must be at least ${FIRM_POLICY.addressMinLength} characters.`)
    .max(FIRM_POLICY.addressMaxLength, `Address must be at most ${FIRM_POLICY.addressMaxLength} characters.`),
  /** Optional basic details / description. */
  description: optionalDescription,
});

/** What the form (and FormData) produces — all strings. */
export type FirmFormInput = z.input<typeof firmFormSchema>;

/** What the service consumes after server-side parsing. */
export type FirmServiceInput = z.output<typeof firmFormSchema>;

/** Flatten a failed parse into { field: message } for form display. */
export function firmFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0]?.toString() ?? "form";
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

/* ============================================================================
 * LOGO UPLOAD VALIDATION (client-side pre-check; the server re-verifies from
 * the actual bytes — magic-byte sniffing + sharp decode — and is the only
 * authority that matters).
 * ==========================================================================*/

export const LOGO_ACCEPT_ATTRIBUTE = FIRM_LOGO_POLICY.extensions.map((ext) => `.${ext}`).join(",");

/** Immediate client-side feedback for a chosen File; null when acceptable. */
export function clientLogoError(file: File | null | undefined): string | null {
  if (!file || file.size === 0) return null; // optional field
  if (file.size > FIRM_LOGO_POLICY.maxBytes) {
    return "Firm logo must be at most 2 MB.";
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(FIRM_LOGO_POLICY.extensions as readonly string[]).includes(ext)) {
    return "Firm logo must be a PNG, JPG, JPEG or WebP image.";
  }
  if (!(FIRM_LOGO_POLICY.mimeTypes as readonly string[]).includes(file.type)) {
    return "Firm logo must be a PNG, JPG, JPEG or WebP image.";
  }
  return null;
}
