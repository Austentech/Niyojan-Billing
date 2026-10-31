import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Building2, LogOut, ShieldCheck } from "lucide-react";

import { LogoMark, Wordmark } from "@/components/brand/brand-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getSessionContext } from "@/lib/auth/server/context";
import { logoutAction } from "@/server/actions/auth-actions";
import { BRAND } from "@/lib/constants";
import { COOKIE_NAMES } from "@/lib/constants";
import type { SessionContext } from "@/lib/auth/types";

/**
 * PROTECTED ROUTE — minimal authenticated console shell (Phase 1).
 *
 * Every request validates the session server-side (database lookup:
 * revocation, absolute expiry, idle timeout). Unauthenticated visitors are
 * redirected to the login page. The full dashboard/firm-management
 * experience is deliberately NOT built here — it arrives in Phase 2 after
 * this authentication phase is signed off.
 */
export const dynamic = "force-dynamic";

function formatUtc(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

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
  const issuedAt = formatUtc(session.createdAt);
  const expiresAt = formatUtc(session.expiresAt);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Console header */}
      <header className="sticky top-0 z-10 border-b bg-card">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-5">
          <div className="flex items-center gap-3">
            <LogoMark size={30} />
            <Wordmark className="hidden sm:block" />
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground md:inline">
              Administrator Console
            </span>
            <form action={logoutAction}>
              <input type="hidden" name="csrf" value={csrfToken} />
              <Button type="submit" variant="outline" size="sm" className="h-9">
                <LogOut className="size-4" aria-hidden="true" />
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-8 sm:py-10">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-[22px]">
              Welcome back, {session.displayName}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {BRAND.systemName}
            </p>
          </div>
          <Badge className="w-fit gap-1.5 border-gold/40 bg-accent text-navy hover:bg-accent">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Two-step verification complete
          </Badge>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Authenticated session</CardTitle>
              <CardDescription>
                Your session is protected with an HttpOnly cookie and validated on every request.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between gap-4 border-t pt-2.5">
                <span className="text-muted-foreground">Administrator</span>
                <span className="font-medium">{session.displayName}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Username</span>
                <span className="font-mono text-[13px]">{session.username}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Verified email</span>
                <span className="font-medium">{session.email}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Session issued</span>
                <span className="tnum text-[13px]">{issuedAt}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Session expires</span>
                <span className="tnum text-[13px]">{expiresAt}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="size-4 text-gold" aria-hidden="true" />
                Phase 2 — Firm management
              </CardTitle>
              <CardDescription>Reserved for the next development phase.</CardDescription>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed text-muted-foreground">
              <p>
                The firm dashboard — the centralized listing of every registered business with
                the responsive 4 / 2 / 1 column grid — is intentionally not part of this phase.
                It will be developed on top of this authentication foundation once Phase 1 is
                reviewed and signed off.
              </p>
              <p className="mt-3 rounded-md border bg-secondary/60 px-3 py-2.5 text-[12px]">
                Billing, invoices, GST, accounting, transactions, expenses and reporting remain
                strictly out of scope until their dedicated phases.
              </p>
            </CardContent>
          </Card>
        </div>

        <p className="mt-8 text-center text-[11px] leading-relaxed text-muted-foreground">
          {BRAND.name} · {BRAND.tagline} · Internal system
        </p>
      </main>
    </div>
  );
}
