import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LogOut, Settings, ShieldCheck } from "lucide-react";

import { LogoMark, Wordmark } from "@/components/brand/brand-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSessionContext } from "@/lib/auth/server/context";
import { logoutAction } from "@/server/actions/auth-actions";
import { BRAND, COOKIE_NAMES } from "@/lib/constants";
import type { SessionContext } from "@/lib/auth/types";

/**
 * PROTECTED ROUTE — Account Settings placeholder.
 *
 * Route protection is live in Phase 1 (server-side session validation on
 * every request). The settings experience itself — profile and password
 * change backed by the database-stored Argon2id credential — is scheduled
 * for a later phase, as specified.
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
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

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-10 border-b bg-card">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-5">
          <div className="flex items-center gap-3">
            <LogoMark size={30} />
            <Wordmark className="hidden sm:block" />
          </div>
          <form action={logoutAction}>
            <input type="hidden" name="csrf" value={csrfToken} />
            <Button type="submit" variant="outline" size="sm" className="h-9">
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </Button>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-8 sm:py-10">
        <div className="flex items-center gap-2.5">
          <Settings className="size-5 text-gold" aria-hidden="true" />
          <h1 className="text-xl font-semibold tracking-tight sm:text-[22px]">Account settings</h1>
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4 text-navy" aria-hidden="true" />
              Scheduled for a later phase
            </CardTitle>
            <CardDescription>
              Signed in as {session.displayName} ({session.username}).
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm leading-relaxed text-muted-foreground">
            <p>
              Account Settings — administrator profile maintenance and the password change that
              will move the credential source from the environment bootstrap to the database
              (Argon2id-hashed) — is intentionally deferred to its own phase. The password
              management foundation for it is already in place.
            </p>
          </CardContent>
        </Card>

        <p className="mt-8 text-center text-[11px] leading-relaxed text-muted-foreground">
          {BRAND.name} · {BRAND.tagline} · Internal system
        </p>
      </main>
    </div>
  );
}
