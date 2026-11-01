import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Building2, Database } from "lucide-react";

import { PageHeader, EmptyState } from "@/components/common/ui-blocks";
import { AddFirmDialog } from "@/components/firms/add-firm-dialog";
import { FirmList } from "@/components/firms/firm-list";
import { getSessionContext } from "@/lib/auth/server/context";
import { listFirms } from "@/lib/firms/service";
import { COOKIE_NAMES } from "@/lib/constants";
import type { SessionContext } from "@/lib/auth/types";
import type { FirmView } from "@/lib/firms/types";

/**
 * PROTECTED ROUTE — Firm Management.
 *
 *   * Server-side session validation on every request.
 *   * The list renders EXCLUSIVELY from the database; adding a firm happens
 *     only through the validated, rate-limited server action.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Firm Management",
};

export default async function FirmManagementPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  let session: SessionContext | null = null;
  try {
    session = await getSessionContext();
  } catch {
    session = null;
  }
  if (!session) {
    redirect("/");
  }

  const params = await searchParams;
  const autoOpen = params.new === "1";
  const csrfToken = (await cookies()).get(COOKIE_NAMES.csrf)?.value ?? "";

  let firms: FirmView[] = [];
  let loadFailed = false;
  try {
    firms = await listFirms();
  } catch {
    loadFailed = true;
  }

  return (
    <div className="space-y-2">
      <PageHeader
        title="Manage Firms"
        description="Add and manage the business entities operating under Niyojan Corporation."
        actions={
          firms.length > 0 && !loadFailed ? (
            <AddFirmDialog csrfToken={csrfToken} />
          ) : null
        }
      />

      {loadFailed ? (
        <div
          role="alert"
          className="mt-6 flex gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3.5 text-sm text-destructive"
        >
          <Database className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="leading-relaxed">
            The firm list could not be loaded right now. Please refresh the page in a moment — if
            the problem persists, contact your operator.
          </p>
        </div>
      ) : firms.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No firms added yet."
          description="Start building your centralized business workspace by adding your first firm."
          action={<AddFirmDialog csrfToken={csrfToken} autoOpen={autoOpen} trigger="empty" />}
          className="mt-6"
        />
      ) : (
        <FirmList firms={firms} />
      )}
    </div>
  );
}
