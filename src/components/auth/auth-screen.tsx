"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Building2, KeyRound, ShieldCheck } from "lucide-react";

import { LogoLockup } from "@/components/brand/brand-logo";
import { LoginForm } from "@/components/auth/login-form";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { BRAND } from "@/lib/constants";
import type { AuthEnvironmentInfo } from "@/types/app";

type AuthMode = "login" | "forgot" | "reset";

const PANEL_POINTS = [
  {
    icon: ShieldCheck,
    title: "Secure administrator access",
    text: "Hardened sessions, lockout protection and audited password policies.",
  },
  {
    icon: Building2,
    title: "Centralized firm oversight",
    text: "Every registered business, one corporate structure, one source of truth.",
  },
  {
    icon: KeyRound,
    title: "Trusted control",
    text: "Financial operations stay governed, phased and reviewable.",
  },
] as const;

/**
 * Authentication surface: sign-in, forgot-password and reset-password flows
 * presented in a premium corporate split layout.
 */
export function AuthScreen({ envInfo, initialResetToken }: { envInfo: AuthEnvironmentInfo; initialResetToken?: string }) {
  const [mode, setMode] = useState<AuthMode>(initialResetToken ? "reset" : "login");
  const [resetToken, setResetToken] = useState<string | undefined>(initialResetToken);

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

            {!envInfo.smtpConfigured ? (
              <p className="mb-6 rounded-md border border-gold/40 bg-accent px-3 py-2 text-center text-[11px] leading-relaxed text-muted-foreground">
                Email delivery (SMTP) is not configured on this environment. Password-reset links are written to
                the server log{envInfo.exposeResetLink ? " and shown on request" : ""}.
              </p>
            ) : null}

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={mode + (resetToken ?? "")}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {mode === "login" ? (
                  <div className="space-y-6">
                    <div className="text-center">
                      <h1 className="text-xl font-semibold tracking-tight">Administrator sign in</h1>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {BRAND.systemName}
                      </p>
                    </div>
                    <LoginForm />
                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => setMode("forgot")}
                        className="cursor-pointer text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                      >
                        Forgot your password?
                      </button>
                    </div>
                  </div>
                ) : mode === "forgot" ? (
                  <ForgotPasswordForm
                    onBack={() => setMode("login")}
                    onContinueToReset={(token) => {
                      setResetToken(token);
                      setMode("reset");
                    }}
                  />
                ) : resetToken ? (
                  <ResetPasswordForm token={resetToken} onDone={() => setMode("login")} />
                ) : (
                  <ForgotPasswordForm onBack={() => setMode("login")} onContinueToReset={() => undefined} />
                )}
              </motion.div>
            </AnimatePresence>

            <p className="mt-10 text-center text-[11px] leading-relaxed text-muted-foreground">
              Protected system. Activity is attributable to your administrator account.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
