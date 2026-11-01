import { getSupabaseServiceClient } from "@/lib/auth/server/db";
import { firmFieldErrors, firmFormSchema } from "@/lib/firms/validation";
import { SystemFirmError, logFirmEvent } from "@/lib/firms/errors";
import type { FirmRecord, FirmView } from "@/lib/firms/types";

/**
 * Firm-management service layer (framework-independent — explicit inputs,
 * no request context, fully integration-testable).
 *
 * Every query goes through the Supabase service-role client: PostgREST
 * generates parameterized SQL, and Row Level Security blocks every other
 * role. The dashboard and the firm-management list render ONLY from these
 * functions — firm data is never hardcoded in frontend code.
 */

const FIRM_SELECT =
  "id, firm_name, logo_url, website_url, holding_percentage, address, description, created_at, updated_at";

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
  const { data, error } = await getSupabaseServiceClient()
    .from("firms")
    .select(FIRM_SELECT)
    .order("created_at", { ascending: true });
  if (error) {
    throw new SystemFirmError(`firms.select failed (${error.code ?? ""})`);
  }
  return (data ?? []).map(toFirmView);
}

export type CreateFirmResult =
  | { status: "created"; firm: FirmView }
  | { status: "invalid"; fieldErrors: Record<string, string> };

/**
 * Validate and insert one firm. `raw` is the untrusted form payload (the
 * server-side Zod parse is authoritative); `logoUrl` is the already-stored
 * logo public URL or null when no logo was supplied.
 */
export async function createFirm(raw: unknown, logoUrl: string | null): Promise<CreateFirmResult> {
  const parsed = firmFormSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "invalid", fieldErrors: firmFieldErrors(parsed.error) };
  }

  const { data, error } = await getSupabaseServiceClient()
    .from("firms")
    .insert({
      firm_name: parsed.data.firmName,
      logo_url: logoUrl,
      website_url: parsed.data.websiteUrl ?? null,
      holding_percentage: parsed.data.holdingPercentage,
      address: parsed.data.address,
      description: parsed.data.description ?? null,
    })
    .select(FIRM_SELECT)
    .single<FirmRecord>();
  if (error || !data) {
    // e.g. a CHECK constraint rejected a value that slipped past validation.
    throw new SystemFirmError(`firms.insert failed (${error?.code ?? "no row"})`);
  }

  logFirmEvent("firm_created", { firm_id: data.id, has_logo: logoUrl !== null });
  return { status: "created", firm: toFirmView(data) };
}

/**
 * Destructive reset of firm data. Test/operations hook ONLY — never exposed
 * through any HTTP route or server action.
 */
export async function resetFirmDataForTests(): Promise<void> {
  await getSupabaseServiceClient().from("firms").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}
