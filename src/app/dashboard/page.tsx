import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";

import { Building2, Database, TriangleAlert } from "lucide-react";

import { ConsoleHeader } from "@/components/dashboard/console-header";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/ui-blocks";
import { FirmsGrid } from "@/components/firms/firms-grid";
import { getSessionContext } from "@/lib/auth/server/context";
import { listFirms } from "@/lib/firms/service";
import { BRAND, COOKIE_NAMES } from "@/lib/constants";
import type { SessionContext } from "@/lib/auth/types";
import type { FirmView } from "@/lib/firms/types";

/**
 * PROTECTED ROUTE — the main dashboard.
 *
 *   * Server-side session validation on every request (database lookup:
 *     revocation, absolute expiry, idle timeout); unauthenticated visitors
 *     are redirected to the login page.
 *   * The firm collection is rendered EXCLUSIVELY from the database — firm
 *     cards are never added in frontend code.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "My Firms",
};

export default async function DashboardPage() {
  let session: SessionContext | null = null;
  try {
    session = await getSessionContext();
  } catch {
    session = null;
  }
  if (!session) {
    redirect("/");
  }

  const csrfToken = (await cookies()).get(COOKIE_NAMES.csrf)?.value ?? "";

  let firms: FirmView[] = [];
  let loadFailed = false;
  try {
    firms = await listFirms();
  } catch {
    // Database unreachable — degrade to an explicit error state instead of
    // crashing the console. Nothing about the failure is exposed in detail.
    loadFailed = true;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <ConsoleHeader
        displayName={session.displayName}
        email={session.email}
        csrfToken={csrfToken}
        showGreeting
      />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <PageHeader
          title="My Firms"
          description="Manage and monitor all your business entities from one centralized workspace."
          actions={
            <Button asChild variant="outline" size="sm" className="h-9">
              <Link href="/settings/firms">
                <Building2 className="size-4" aria-hidden="true" />
                Manage firms
              </Link>
            </Button>
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
        ) : (
          <FirmsGrid firms={firms} />
        )}

        <p className="mt-10 text-center text-[11px] leading-relaxed text-muted-foreground">
          {BRAND.name} · {BRAND.tagline} · Internal system
        </p>
      </main>

      {/* Screen-reader summary of load failures for assistive technology */}
      {loadFailed ? (
        <span className="sr-only">
          <TriangleAlert aria-hidden="true" /> Firm list unavailable.
        </span>
      ) : null}
    </div>
  );
}
