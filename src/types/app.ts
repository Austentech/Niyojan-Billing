/**
 * Shared application types.
 *
 * DTO shapes crossing the server/client boundary. Password hashes, session
 * token hashes and other secrets are never part of these types.
 */

export type FirmStatus = "ACTIVE" | "INACTIVE";

/** Standard result envelope for every server action. */
export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export interface AdminUserDto {
  id: string;
  name: string;
  email: string;
  role: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

export interface FirmDto {
  id: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  notes: string | null;
  status: FirmStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardStats {
  total: number;
  active: number;
  inactive: number;
  addedLast30Days: number;
}

/** Public runtime configuration surfaced to the auth screens. */
export interface AuthEnvironmentInfo {
  smtpConfigured: boolean;
  exposeResetLink: boolean;
}

/** Client-side view routing for the single-route application shell. */
export type AppView =
  | { type: "dashboard" }
  | { type: "firms" }
  | { type: "firm-detail"; firmId: string }
  | { type: "settings" };
