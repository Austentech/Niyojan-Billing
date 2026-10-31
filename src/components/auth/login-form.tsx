"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, LogIn, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/auth/password-input";
import { loginSchema, type LoginInput } from "@/lib/auth/validation";
import { loginAction } from "@/server/actions/auth-actions";
import { LOCKOUT_FAILURE_THRESHOLD } from "@/lib/constants";
import type { LoginActionState, OtpScreenData } from "@/types/auth";

/**
 * STEP 1 — administrator credential verification.
 *
 *   * Client-side Zod validation mirrors the server schema (UX only; the
 *     server always re-validates).
 *   * No credential or username is ever written to localStorage or
 *     sessionStorage — the browser remembers nothing between visits.
 *   * Server errors are generic: the response never reveals whether the
 *     username or the password was wrong.
 */
export function LoginForm({
  csrfToken,
  envReady,
  onOtpRequired,
  onLocked,
}: {
  csrfToken: string;
  envReady: boolean;
  onOtpRequired: (data: OtpScreenData) => void;
  onLocked: (lockedUntil: string | null, secondsRemaining: number) => void;
}) {
  const [serverState, setServerState] = useState<LoginActionState>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  useEffect(() => {
    if (serverState.status === "otp_required") {
      onOtpRequired({
        emailMasked: serverState.emailMasked,
        expiresAt: serverState.expiresAt,
        resendCooldownSeconds: serverState.resendCooldownSeconds,
      });
    } else if (serverState.status === "locked") {
      onLocked(serverState.lockedUntil, serverState.secondsRemaining);
    }
  }, [serverState, onOtpRequired, onLocked]);

  async function onSubmit(values: LoginInput) {
    setServerState({ status: "idle" });
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.set("csrf", csrfToken);
      formData.set("username", values.username);
      formData.set("password", values.password);
      const result = await loginAction({ status: "idle" }, formData);
      setServerState(result);
      if (result.status === "invalid_credentials") {
        form.setValue("password", "");
      }
    } catch {
      setServerState({
        status: "unavailable",
        message: "Sign-in failed due to a network or server error. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const usernameError = form.formState.errors.username?.message;
  const passwordError = form.formState.errors.password?.message;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Administrator sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Two-step verification protects this console.
        </p>
      </div>

      {!envReady ? (
        <p
          className="rounded-md border border-gold/40 bg-accent px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground"
          role="note"
        >
          Server configuration is incomplete on this environment — sign-in is disabled until an
          operator finishes the environment setup.
        </p>
      ) : null}

      <div aria-live="polite">
        {serverState.status === "invalid_credentials" ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm text-destructive"
          >
            <p className="font-medium">{serverState.message}</p>
            {serverState.failuresUntilLockout > 0 && serverState.failuresUntilLockout <= LOCKOUT_FAILURE_THRESHOLD - 1 ? (
              <p className="mt-1 text-[12px] opacity-90">
                {serverState.failuresUntilLockout} failed attempt
                {serverState.failuresUntilLockout === 1 ? "" : "s"} remaining before a 24-hour
                security lockout.
              </p>
            ) : null}
          </div>
        ) : serverState.status === "blocked" ||
          serverState.status === "unavailable" ||
          serverState.status === "config_error" ? (
          <div
            role="alert"
            className="flex gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="leading-relaxed">{serverState.message}</p>
          </div>
        ) : null}
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            placeholder="Administrator username"
            aria-invalid={Boolean(usernameError)}
            aria-describedby={usernameError ? "username-error" : undefined}
            className="h-10"
            {...form.register("username")}
          />
          {usernameError ? (
            <p id="username-error" className="text-[13px] font-medium text-destructive">
              {usernameError}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            placeholder="Enter your password"
            aria-invalid={Boolean(passwordError)}
            aria-describedby={passwordError ? "password-error" : undefined}
            {...form.register("password")}
          />
          {passwordError ? (
            <p id="password-error" className="text-[13px] font-medium text-destructive">
              {passwordError}
            </p>
          ) : null}
        </div>

        <Button type="submit" className="h-10 w-full" disabled={submitting} aria-busy={submitting}>
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Verifying credentials…
            </>
          ) : (
            <>
              <LogIn className="size-4" aria-hidden="true" />
              Continue
            </>
          )}
        </Button>
      </form>

      <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
        This is a restricted internal system. Activity is attributable to the administrator
        account and all attempts are logged.
      </p>
    </div>
  );
}
