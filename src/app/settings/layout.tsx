import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ConsoleHeader } from "@/components/dashboard/console-header";
import { SettingsNav } from "@/components/settings/settings-nav";
import { getSessionContext } from "@/lib/auth/server/context";
import { COOKIE_NAMES } from "@/lib/constants";
import type { SessionContext } from "@/lib/auth/types";

/**
 * Settings section — shared protected layout.
 *
 * Route protection is AUTHORITATIVE here: every /settings/* request validates
 * the session server-side (database lookup: revocation, absolute expiry,
 * idle timeout) before any settings page renders. Unauthenticated visitors
 * are redirected to the login page. Each page re-checks as well (defense in
 * depth), and the edge proxy fast-path redirects cookie-less requests.
 */
export const dynamic = "force-dynamic";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
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
      <ConsoleHeader displayName={session.displayName} email={session.email} csrfToken={csrfToken} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <div className="mt-2 flex flex-col gap-6 md:flex-row md:gap-8">
          <div className="md:w-60 md:shrink-0">
            <h1 className="mb-3 hidden text-[15px] font-semibold tracking-tight text-foreground md:block">
              Settings
            </h1>
            <SettingsNav />
          </div>
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </main>
    </div>
  );
}
