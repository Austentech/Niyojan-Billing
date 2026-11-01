import { z } from "zod";

import { OTP_CHARSET, OTP_LENGTH, OTP_TTL_SECONDS } from "@/lib/constants";

/**
 * Zod schemas shared by client (inline field validation) and server
 * (authoritative validation). The server ALWAYS re-validates — client
 * validation is UX only.
 */

export const loginSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters.")
    .max(64, "Username must be at most 64 characters."),
  password: z
    .string()
    .min(1, "Password is required.")
    .max(128, "Password must be at most 128 characters."),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * OTP normalization: uppercase, strip everything outside the charset.
 * Applied identically on client (for display) and server (before hashing).
 */
export function normalizeOtpCode(raw: string): string {
  return raw
    .toUpperCase()
    .split("")
    .filter((ch) => OTP_CHARSET.includes(ch))
    .join("")
    .slice(0, OTP_LENGTH);
}

export const otpSchema = z
  .string()
  .transform((v) => normalizeOtpCode(v))
  .refine((v) => v.length === OTP_LENGTH, {
    message: `The verification code is ${OTP_LENGTH} characters (uppercase letters and digits).`,
  });

export const OTP_TTL_MINUTES = Math.round(OTP_TTL_SECONDS / 60);

/**
 * Account Settings — password change (shared by client form and server
 * action). The new credential must satisfy the bootstrap-grade policy.
 */
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(128),
  newPassword: z
    .string()
    .min(10, "The new password must be at least 10 characters.")
    .max(128, "The new password must be at most 128 characters.")
    .refine((v) => v !== "timing-equalization-placeholder", "Choose a stronger password."),
});

export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;

/** Client-side form variant with the confirmation field. */
export const passwordChangeFormSchema = passwordChangeSchema
  .extend({
    confirmPassword: z.string().min(1, "Repeat the new password."),
  })
  .refine((data) => data.confirmPassword === data.newPassword, {
    path: ["confirmPassword"],
    message: "The new password and the confirmation do not match.",
  });

export type PasswordChangeFormInput = z.input<typeof passwordChangeFormSchema>;
