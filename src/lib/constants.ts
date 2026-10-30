/** Central application constants. */

export const BRAND = {
  name: "Niyojan Corporation",
  shortName: "Niyojan",
  tagline: "Structural Growth. Trusted Control.",
  systemName: "Centralized Financial & Billing Management System",
} as const;

/** Session lifetime in milliseconds (8 hours). */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Password reset token lifetime in minutes. */
export const RESET_TOKEN_TTL_MIN = 30;

/** Account lockout policy. */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_DURATION_MIN = 15;

export const FIRM_STATUSES = ["ACTIVE", "INACTIVE"] as const;

/** India state list for firm registration (selection list). */
export const INDIAN_STATES = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
] as const;

/** Future modules locked for the current phase (sidebar "coming soon"). */
export const FUTURE_MODULES = [
  { label: "Billing & Invoices", hint: "Phase 2" },
  { label: "GST Filing", hint: "Phase 3" },
  { label: "Accounting & Ledger", hint: "Phase 3" },
  { label: "Reports & Analytics", hint: "Phase 4" },
] as const;
