/**
 * Zod validation schemas — the single source of truth for both client-side
 * (react-hook-form) and server-side validation of every form in the system.
 */
import { z } from "zod";
import { FIRM_STATUSES, INDIAN_STATES } from "@/lib/constants";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_REGEX = /^\+?[0-9][0-9\s\-()]{6,19}$/;
const POSTAL_REGEX = /^[A-Za-z0-9][A-Za-z0-9\s-]{2,9}$/;
const GSTIN_REGEX = /^[0-9A-Za-z]{15}$/;

const emailField = z
  .string()
  .trim()
  .min(1, "Email is required")
  .max(254, "Email is too long")
  .refine((v) => EMAIL_REGEX.test(v), "Enter a valid email address");

/** Strong password policy for administrator accounts. */
export const strongPasswordField = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(128, "Password is too long")
  .superRefine((val, ctx) => {
    if (!/[a-z]/.test(val)) ctx.addIssue({ code: "custom", message: "Include at least one lowercase letter" });
    if (!/[A-Z]/.test(val)) ctx.addIssue({ code: "custom", message: "Include at least one uppercase letter" });
    if (!/[0-9]/.test(val)) ctx.addIssue({ code: "custom", message: "Include at least one number" });
    if (!/[^A-Za-z0-9]/.test(val)) ctx.addIssue({ code: "custom", message: "Include at least one symbol (e.g. ! @ # $)" });
  });

/* ------------------------------- Auth ---------------------------------- */

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Password is required").max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: emailField });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(10, "Reset token is missing or invalid"),
    password: strongPasswordField,
    confirmPassword: z.string().min(1, "Confirm the new password"),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/* ------------------------------ Account -------------------------------- */

export const profileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(60, "Name must be at most 60 characters"),
  email: emailField,
  /** Required only when the email address is being changed. */
  currentPassword: z.string().max(128),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: strongPasswordField,
    confirmPassword: z.string().min(1, "Confirm the new password"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/* -------------------------------- Firms -------------------------------- */

const optionalText = (max: number, label: string) =>
  z.string().max(max, `${label} must be at most ${max} characters`);

export const firmFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, "Firm name is required (min 2 characters)")
      .max(100, "Firm name must be at most 100 characters"),
    legalName: optionalText(140, "Legal name"),
    gstin: z
      .string()
      .trim()
      .max(15, "GSTIN must be exactly 15 characters")
      .refine((v) => v === "" || GSTIN_REGEX.test(v), {
        message: "GSTIN must be exactly 15 alphanumeric characters (e.g. 08ABCDE1234F1Z5)",
      }),
    contactPerson: optionalText(80, "Contact person"),
    email: z
      .string()
      .trim()
      .max(254)
      .refine((v) => v === "" || EMAIL_REGEX.test(v), "Enter a valid email address"),
    phone: z
      .string()
      .trim()
      .refine((v) => v === "" || PHONE_REGEX.test(v), "Enter a valid phone number (e.g. +91 98250 12345)"),
    addressLine1: optionalText(160, "Address"),
    city: optionalText(60, "City"),
    state: z.string().trim(),
    postalCode: z
      .string()
      .trim()
      .refine((v) => v === "" || POSTAL_REGEX.test(v), "Enter a valid postal code"),
    notes: optionalText(500, "Notes"),
    status: z.enum(FIRM_STATUSES),
  })
  .superRefine((val, ctx) => {
    if (val.state !== "" && !(INDIAN_STATES as readonly string[]).includes(val.state)) {
      ctx.addIssue({ code: "custom", path: ["state"], message: "Select a valid state" });
    }
  });
export type FirmFormValues = z.infer<typeof firmFormSchema>;

/** Convert validated form values into nullable DB values. */
export function normalizeFirmForm(values: FirmFormValues) {
  const clean = (v: string) => {
    const t = v.trim();
    return t === "" ? null : t;
  };
  return {
    name: values.name.trim(),
    legalName: clean(values.legalName),
    gstin: clean(values.gstin)?.toUpperCase() ?? null,
    contactPerson: clean(values.contactPerson),
    email: clean(values.email)?.toLowerCase() ?? null,
    phone: clean(values.phone),
    addressLine1: clean(values.addressLine1),
    city: clean(values.city),
    state: clean(values.state),
    postalCode: clean(values.postalCode)?.toUpperCase() ?? null,
    notes: clean(values.notes),
    status: values.status,
  };
}
