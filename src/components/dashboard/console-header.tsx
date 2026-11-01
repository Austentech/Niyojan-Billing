import Link from "next/link";

import { Bell, Settings } from "lucide-react";

import { LogoMark, Wordmark } from "@/components/brand/brand-logo";
import { Button } from "@/components/ui/button";
import { ProfileMenu } from "@/components/dashboard/profile-menu";
import { BRAND } from "@/lib/constants";

/**
 * Authenticated console header shared by the dashboard and the settings
 * section.
 *
 *   * Niyojan Corporation logo + name (links back to the dashboard).
 *   * Notification area — VISUAL PLACEHOLDER ONLY (a future phase wires the
 *     real notification feed; nothing is clickable or faked today).
 *   * Settings navigation and the administrator profile menu (greeting,
 *     account settings, firm management, logout).
 *   * On the dashboard an optional greeting band renders below the bar with
 *     the administrator name from the authenticated account configuration.
 */
export function ConsoleHeader({
  displayName,
  email,
  csrfToken,
  showGreeting = false,
}: {
  displayName: string;
  email: string;
  csrfToken: string;
  showGreeting?: boolean;
}) {
  return (
    <header className="sticky top-0 z-20 border-b bg-card">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link
          href="/dashboard"
          className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${BRAND.name} dashboard`}
        >
          <LogoMark size={30} />
          <Wordmark className="hidden sm:block" />
        </Link>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {/* Notification area — visual placeholder only for now. */}
          <span
            className="relative flex size-9 items-center justify-center rounded-md text-muted-foreground"
            title="Notifications — this area becomes active in a future phase"
          >
            <Bell className="size-[18px]" aria-hidden="true" />
            <span className="absolute right-1.5 top-1.5 size-[7px] rounded-full border border-card bg-gold" aria-hidden="true" />
            <span className="sr-only">Notifications (placeholder — inactive in this phase)</span>
          </span>

          <Button variant="ghost" size="icon" className="size-9" asChild>
            <Link href="/settings/account" aria-label="Settings">
              <Settings className="size-[18px]" aria-hidden="true" />
            </Link>
          </Button>

          <ProfileMenu displayName={displayName} email={email} csrfToken={csrfToken} />
        </div>
      </div>

      {showGreeting ? (
        <div className="border-b bg-card">
          <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6">
            <p className="text-[15px] font-semibold tracking-tight text-foreground sm:text-base">
              Welcome back, {displayName}
            </p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{BRAND.systemName}</p>
          </div>
        </div>
      ) : null}
    </header>
  );
}
