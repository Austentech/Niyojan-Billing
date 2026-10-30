"use server";

/**
 * Firm management server actions — create, update, status change and delete.
 * Every action re-checks the session server-side and re-validates input.
 */
import { db } from "@/lib/db";
import { firmFormSchema, normalizeFirmForm } from "@/lib/validators";
import { getSessionUser } from "@/server/auth/session";
import { getFirmById, listFirms, getDashboardStats, toFirmDto } from "@/server/queries";
import type { ActionResult, DashboardStats, FirmDto, FirmStatus } from "@/types/app";

function zodFieldErrors(error: { issues: { path: PropertyKey[]; message: string }[] }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export interface FirmsPayload {
  firms: FirmDto[];
  stats: DashboardStats;
}

async function isDuplicateName(name: string, excludeId?: string): Promise<boolean> {
  // Case-insensitive name check. Implemented in JS so it works identically on
  // SQLite (dev) and PostgreSQL/Supabase (prod) — on Postgres this can later
  // become a `mode: "insensitive"` query or a functional unique index.
  const rows = await db.firm.findMany({ select: { id: true, name: true } });
  const target = name.trim().toLowerCase();
  return rows.some((f) => f.name.trim().toLowerCase() === target && f.id !== excludeId);
}

async function buildPayload(): Promise<FirmsPayload> {
  const [firms, stats] = await Promise.all([listFirms(), getDashboardStats()]);
  return { firms, stats };
}

export async function getFirmsAction(): Promise<ActionResult<FirmsPayload>> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };
  return { ok: true, data: await buildPayload() };
}

export async function getFirmAction(firmId: string): Promise<ActionResult<FirmDto>> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };
  if (typeof firmId !== "string" || firmId.length === 0) return { ok: false, message: "Invalid firm reference." };
  const firm = await getFirmById(firmId);
  if (!firm) return { ok: false, message: "That firm no longer exists." };
  return { ok: true, data: firm };
}

export async function createFirmAction(input: unknown): Promise<ActionResult<FirmsPayload>> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };

  const parsed = firmFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Please correct the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error) };
  }
  const data = normalizeFirmForm(parsed.data);

  if (await isDuplicateName(data.name)) {
    return {
      ok: false,
      message: "A firm with this name is already registered.",
      fieldErrors: { name: ["A firm with this name is already registered"] },
    };
  }

  await db.firm.create({ data });
  return { ok: true, message: `“${data.name}” registered.`, data: await buildPayload() };
}

export async function updateFirmAction(firmId: string, input: unknown): Promise<ActionResult<FirmsPayload & { firm: FirmDto }>> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };
  if (typeof firmId !== "string" || firmId.length === 0) return { ok: false, message: "Invalid firm reference." };

  const parsed = firmFormSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Please correct the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error) };
  }
  const data = normalizeFirmForm(parsed.data);

  const existing = await db.firm.findUnique({ where: { id: firmId } });
  if (!existing) return { ok: false, message: "That firm no longer exists." };

  if (await isDuplicateName(data.name, firmId)) {
    return {
      ok: false,
      message: "A different firm with this name is already registered.",
      fieldErrors: { name: ["A firm with this name is already registered"] },
    };
  }

  const updated = await db.firm.update({ where: { id: firmId }, data });
  return {
    ok: true,
    message: `“${updated.name}” updated.`,
    data: { ...(await buildPayload()), firm: toFirmDto(updated) },
  };
}

export async function setFirmStatusAction(firmId: string, status: string): Promise<ActionResult<FirmsPayload>> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };
  if (typeof firmId !== "string" || firmId.length === 0) return { ok: false, message: "Invalid firm reference." };
  if (status !== "ACTIVE" && status !== "INACTIVE") return { ok: false, message: "Invalid status." };

  const existing = await db.firm.findUnique({ where: { id: firmId } });
  if (!existing) return { ok: false, message: "That firm no longer exists." };
  if (existing.status === status) {
    return { ok: false, message: `Firm is already ${status === "ACTIVE" ? "active" : "inactive"}.` };
  }

  await db.firm.update({ where: { id: firmId }, data: { status: status as FirmStatus } });
  return {
    ok: true,
    message: status === "ACTIVE" ? `“${existing.name}” reactivated.` : `“${existing.name}” deactivated.`,
    data: await buildPayload(),
  };
}

export async function deleteFirmAction(firmId: string): Promise<ActionResult<FirmsPayload>> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };
  if (typeof firmId !== "string" || firmId.length === 0) return { ok: false, message: "Invalid firm reference." };

  const existing = await db.firm.findUnique({ where: { id: firmId } });
  if (!existing) return { ok: false, message: "That firm no longer exists." };

  await db.firm.delete({ where: { id: firmId } });
  return { ok: true, message: `“${existing.name}” removed from the registry.`, data: await buildPayload() };
}
