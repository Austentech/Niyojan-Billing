import { z } from "zod";

import { OTP_CHARSET, OTP_LENGTH, OTP_TTL_SECONDS, PASSWORD_POLICY } from "@/lib/constants";

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
 * action). STRONG policy: minimum 12 characters with uppercase, lowercase,
 * number and special character (mirrors the environment bootstrap policy).
 */
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(128),
  newPassword: z
    .string()
    .min(PASSWORD_POLICY.minLength, `The new password must be at least ${PASSWORD_POLICY.minLength} characters.`)
    .max(PASSWORD_POLICY.maxLength, `The new password must be at most ${PASSWORD_POLICY.maxLength} characters.`)
    .refine((v) => /[a-z]/.test(v), "The new password must include a lowercase letter.")
    .refine((v) => /[A-Z]/.test(v), "The new password must include an uppercase letter.")
    .refine((v) => /[0-9]/.test(v), "The new password must include a number.")
    .refine((v) => /[^A-Za-z0-9]/.test(v), "The new password must include a special character (e.g. ! @ # $).")
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
