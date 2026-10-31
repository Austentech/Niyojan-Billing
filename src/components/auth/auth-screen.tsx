"use client";

import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Building2, KeyRound, ShieldCheck } from "lucide-react";

import { LogoLockup } from "@/components/brand/brand-logo";
import { LoginForm } from "@/components/auth/login-form";
import { OtpForm } from "@/components/auth/otp-form";
import { LockoutScreen } from "@/components/auth/lockout-screen";
import { BRAND } from "@/lib/constants";
import type { OtpScreenData } from "@/types/auth";

const PANEL_POINTS = [
  {
    icon: ShieldCheck,
    title: "Two-step verification",
    text: "Every sign-in is confirmed with a single-use code emailed to the administrator.",
  },
  {
    icon: KeyRound,
    title: "Global lockout protection",
    text: "Repeated failed attempts lock authentication worldwide for 24 hours.",
  },
  {
    icon: Building2,
    title: "Trusted control",
    text: "Centralized oversight of every registered firm — governed, phased and audited.",
  },
] as const;

/**
 * Authentication surface: Step 1 (credentials) -> Step 2 (email verification
 * code), presented in a premium corporate split layout. The GLOBAL lockout
 * screen replaces both steps whenever the server reports an active lockout.
 */
export function AuthScreen({
  csrfToken,
  envReady,
}: {
  csrfToken: string;
  envReady: boolean;
}) {
  const [otpData, setOtpData] = useState<OtpScreenData | null>(null);
  const [lockout, setLockout] = useState<{ lockedUntil: string | null; secondsRemaining: number } | null>(null);

  const handleOtpRequired = useCallback((data: OtpScreenData) => {
    setOtpData(data);
  }, []);

  const handleLocked = useCallback((lockedUntil: string | null, secondsRemaining: number) => {
    setLockout({ lockedUntil, secondsRemaining });
  }, []);

  const handleRestart = useCallback(() => {
    setOtpData(null);
  }, []);

  if (lockout) {
    return (
      <LockoutScreen
        lockedUntil={lockout.lockedUntil}
        secondsRemaining={lockout.secondsRemaining}
      />
    );
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[44%_56%]">
      {/* Brand panel (desktop) */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-navy p-10 lg:flex xl:p-14">
        <div className="absolute inset-x-0 top-0 h-[3px] bg-gold" aria-hidden="true" />

        <div className="flex items-baseline gap-3">
          <span className="text-[22px] font-semibold tracking-tight text-white">Niyojan</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.32em] text-gold">Corporation</span>
        </div>

        <div className="max-w-md">
          <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-white/50">
            Centralized Financial &amp; Billing Management
          </p>
          <h2 className="mt-4 text-[30px] font-semibold leading-[1.2] tracking-tight text-white xl:text-[34px]">
            Structural Growth.
            <br />
            Trusted Control.
          </h2>
          <p className="mt-5 text-sm leading-relaxed text-white/60">
            The internal management system for administering every independent firm registered under the
            Niyojan Corporation structure — from a single, secured console.
          </p>

          <ul className="mt-10 space-y-6">
            {PANEL_POINTS.map((point) => (
              <li key={point.title} className="flex gap-4">
                <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/5">
                  <point.icon className="size-4 text-gold" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">{point.title}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-white/55">{point.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between border-t border-white/10 pt-6 text-[11px] text-white/40">
          <span>© {new Date().getFullYear()} Niyojan Corporation</span>
          <span>Internal system · Authorized administrators only</span>
        </div>
      </aside>

      {/* Form panel */}
      <main className="flex min-h-screen flex-col bg-background">
        {/* Compact brand header for small screens */}
        <div className="flex items-center justify-between border-b bg-card px-5 py-3 lg:hidden">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight text-navy">Niyojan</span>
            <span className="text-[8px] font-medium uppercase tracking-[0.3em] text-gold">Corporation</span>
          </div>
          <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Administrator Portal
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8">
          <div className="w-full max-w-sm">
            <div className="mb-8 flex justify-center">
              <LogoLockup className="max-w-[240px]" priority />
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={otpData ? "otp" : "credentials"}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {otpData ? (
                  <OtpForm
                    csrfToken={csrfToken}
                    data={otpData}
                    onDataRefresh={setOtpData}
                    onLocked={handleLocked}
                    onRestart={handleRestart}
                  />
                ) : (
                  <LoginForm
                    csrfToken={csrfToken}
                    envReady={envReady}
                    onOtpRequired={handleOtpRequired}
                    onLocked={handleLocked}
                  />
                )}
              </motion.div>
            </AnimatePresence>

            <p className="mt-10 text-center text-[11px] leading-relaxed text-muted-foreground">
              Protected system · {BRAND.tagline}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
