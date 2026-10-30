/**
 * Read-model queries shared by the page render and server actions.
 * All functions map Prisma rows to serializable DTOs (ISO date strings).
 */
import "server-only";
import { db } from "@/lib/db";
import type { AdminUserDto, AuthEnvironmentInfo, DashboardStats, FirmDto, FirmStatus } from "@/types/app";
import type { SessionUser } from "@/server/auth/session";
import { isSmtpConfigured } from "@/server/mailer";
import type { AdminSession, Firm } from "@prisma/client";

/* ------------------------------- mapping -------------------------------- */

export function toFirmDto(f: Firm): FirmDto {
  return {
    id: f.id,
    name: f.name,
    legalName: f.legalName,
    gstin: f.gstin,
    contactPerson: f.contactPerson,
    email: f.email,
    phone: f.phone,
    addressLine1: f.addressLine1,
    city: f.city,
    state: f.state,
    postalCode: f.postalCode,
    notes: f.notes,
    status: f.status as FirmStatus,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

export function toAdminUserDto(u: SessionUser["user"]): AdminUserDto {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

/* -------------------------------- reads --------------------------------- */

export async function listFirms(): Promise<FirmDto[]> {
  const firms = await db.firm.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] });
  return firms.map(toFirmDto);
}

export async function getFirmById(id: string): Promise<FirmDto | null> {
  const firm = await db.firm.findUnique({ where: { id } });
  return firm ? toFirmDto(firm) : null;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [total, active, addedLast30Days] = await Promise.all([
    db.firm.count(),
    db.firm.count({ where: { status: "ACTIVE" } }),
    db.firm.count({ where: { createdAt: { gte: since } } }),
  ]);
  return { total, active, inactive: total - active, addedLast30Days };
}

export interface AccountData {
  user: AdminUserDto;
  sessions: {
    id: string;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    isCurrent: boolean;
  }[];
}

export async function getAccountData(auth: SessionUser): Promise<AccountData> {
  const sessions = await db.adminSession.findMany({
    where: { userId: auth.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
  });
  return {
    user: toAdminUserDto(auth.user),
    sessions: sessions.map((s: AdminSession) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      isCurrent: s.id === auth.sessionId,
    })),
  };
}

export function getAuthEnvironmentInfo(): AuthEnvironmentInfo {
  return {
    smtpConfigured: isSmtpConfigured(),
    exposeResetLink: process.env.EXPOSE_RESET_LINK === "true",
  };
}
