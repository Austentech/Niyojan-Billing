import { asc, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { firms } from "@/lib/db/schema";
import { dbSystemError } from "@/lib/auth/server/db";
import { logSecurityEvent } from "@/lib/auth/server/audit";
import { firmFieldErrors, firmFormSchema } from "@/lib/firms/validation";
import { logFirmEvent } from "@/lib/firms/errors";
import type { FirmRecord, FirmView } from "@/lib/firms/types";

/**
 * Firm-management service layer (framework-independent — explicit inputs,
 * no request context, fully integration-testable).
 *
 * Every query is a parameterized Drizzle statement. The dashboard and the
 * firm-management list render ONLY from these functions — firm data is never
 * hardcoded in frontend code.
 */

function toFirmView(row: FirmRecord): FirmView {
  return {
    id: row.id,
    name: row.firm_name.trim(),
    logoUrl: row.logo_url ?? null,
    websiteUrl: row.website_url ?? null,
    holdingPercentage: Number(row.holding_percentage),
    address: row.address,
    description: row.description ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** All registered firms, in registration (creation) order. */
export async function listFirms(): Promise<FirmView[]> {
  let rows: (typeof firms.$inferSelect)[];
  try {
    rows = await getDb().select().from(firms).orderBy(asc(firms.createdAt));
  } catch (err) {
    throw dbSystemError("firms.select", err);
  }
  return rows.map((row) =>
    toFirmView({
      id: row.id,
      firm_name: row.firmName,
      logo_url: row.logoUrl,
      website_url: row.websiteUrl,
      holding_percentage: row.holdingPercentage,
      address: row.address,
      description: row.description,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }),
  );
}

export type CreateFirmResult =
  | { status: "created"; firm: FirmView }
  | { status: "invalid"; fieldErrors: Record<string, string> };

/**
 * Validate and insert one firm. `raw` is the untrusted form payload (the
 * server-side Zod parse is authoritative); `logoUrl` is the already-stored
 * logo public URL or null when no logo was supplied.
 */
export async function createFirm(raw: unknown, logoUrl: string | null, adminId?: string): Promise<CreateFirmResult> {
  const parsed = firmFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "invalid", fieldErrors: firmFieldErrors(parsed.error) };
  }

  let row: typeof firms.$inferSelect | undefined;
  try {
    const rows = await getDb()
      .insert(firms)
      .values({
        firmName: parsed.data.firmName,
        logoUrl,
        websiteUrl: parsed.data.websiteUrl ?? null,
        holdingPercentage: String(parsed.data.holdingPercentage),
        address: parsed.data.address,
        description: parsed.data.description ?? null,
      })
      .returning();
    row = rows[0];
  } catch (err) {
    // e.g. a CHECK constraint rejected a value that slipped past validation.
    throw dbSystemError("firms.insert", err);
  }
  if (!row) {
    throw dbSystemError("firms.insert", null);
  }

  logFirmEvent("firm_created", { firm_id: row.id, has_logo: logoUrl !== null });
  await logSecurityEvent("firm_created", {
    adminId: adminId ?? null,
    detail: { firm_id: row.id, has_logo: logoUrl !== null },
  });

  const view = toFirmView({
    id: row.id,
    firm_name: row.firmName,
    logo_url: row.logoUrl,
    website_url: row.websiteUrl,
    holding_percentage: row.holdingPercentage,
    address: row.address,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
  return { status: "created", firm: view };
}

/**
 * Destructive reset of firm data. Test/operations hook ONLY — never exposed
 * through any HTTP route or server action.
 */
export async function resetFirmDataForTests(): Promise<void> {
  await getDb().execute(sql`delete from public.firms`);
}
