"use client";

import { Lock } from "lucide-react";

import { LogoMark } from "@/components/brand/brand-logo";
import { formatDuration, useCountdown } from "@/components/auth/use-countdown";
import { BRAND } from "@/lib/constants";

/**
 * Global account-security lockout screen.
 *
 * Rendered server-side when the login page loads while locked, and
 * client-side when an authentication attempt reports the lockout. The
 * remaining time is computed from the server-provided deadline — the login
 * form is unavailable until it reaches zero.
 */
export function LockoutScreen({
  lockedUntil,
  secondsRemaining,
}: {
  lockedUntil: string | null;
  secondsRemaining: number;
}) {
  const remaining = useCountdown(lockedUntil ?? secondsRemaining * 1000 + Date.now());
  const display = remaining > 0 ? remaining : secondsRemaining;

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <div className="flex items-center justify-between border-b bg-card px-5 py-3 lg:hidden">
        <div className="flex items-center gap-2">
          <LogoMark size={28} />
          <span className="text-[9px] font-medium uppercase tracking-[0.3em] text-muted-foreground">
            Administrator Portal
          </span>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8">
        <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-[0_1px_2px_rgba(27,39,55,0.06)] sm:p-10">
          <div className="mx-auto flex size-12 items-center justify-center rounded-md bg-navy" aria-hidden="true">
            <Lock className="size-6 text-white" />
          </div>

          <h1 className="mt-6 text-center text-xl font-semibold tracking-tight text-foreground">
            Account security lockout
          </h1>
          <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
            Multiple failed authentication attempts were detected. Administrator sign-in is
            temporarily locked to protect {BRAND.name}.
          </p>

          <div className="mt-7 rounded-md border border-gold/40 bg-accent px-4 py-5 text-center">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Sign-in available again in
            </p>
            <p className="tnum mt-2 text-3xl font-semibold tracking-tight text-navy" role="timer" aria-live="off">
              {formatDuration(display)}
            </p>
          </div>

          <ul className="mt-7 space-y-3 text-[13px] leading-relaxed text-muted-foreground">
            <li className="flex gap-2.5">
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-gold" aria-hidden="true" />
              This lockout applies to every device, browser and network — it cannot be bypassed
              by switching locations.
            </li>
            <li className="flex gap-2.5">
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-gold" aria-hidden="true" />
              It lifts automatically when the timer ends. There is no manual override.
            </li>
            <li className="flex gap-2.5">
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-gold" aria-hidden="true" />
              All attempts are recorded. If this was not you, review who has knowledge of the
              administrator credentials.
            </li>
          </ul>

          <p className="mt-8 border-t pt-5 text-center text-[11px] leading-relaxed text-muted-foreground">
            {BRAND.systemName} · Internal system · Authorized administrators only
          </p>
        </div>
      </div>
    </main>
  );
}
