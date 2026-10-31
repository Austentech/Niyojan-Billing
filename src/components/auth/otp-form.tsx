"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, MailCheck, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeOtpCode, otpSchema, OTP_TTL_MINUTES } from "@/lib/auth/validation";
import { resendOtpAction, verifyOtpAction } from "@/server/actions/auth-actions";
import { OTP_LENGTH } from "@/lib/constants";
import { formatDuration, useCountdown } from "@/components/auth/use-countdown";
import type { OtpActionState, OtpScreenData } from "@/types/auth";

/**
 * STEP 2 — email verification code.
 *
 *   * Single input accepts the complete 8-character code, including full
 *     pasting (paste is normalized: uppercase, charset-filtered).
 *   * Shows the code expiry and gates Resend behind the server-enforced
 *     cooldown (display mirrors the server value).
 *   * The code lives only in this input's memory — never localStorage,
 *     never a URL, never a cookie.
 */
export function OtpForm({
  csrfToken,
  data,
  onDataRefresh,
  onLocked,
  onRestart,
}: {
  csrfToken: string;
  data: OtpScreenData;
  onDataRefresh: (data: OtpScreenData) => void;
  onLocked: (lockedUntil: string | null, secondsRemaining: number) => void;
  onRestart: () => void;
}) {
  const [code, setCode] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<OtpActionState>({ status: "idle" });
  const [resendState, setResendState] = useState<OtpActionState>({ status: "idle" });
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldownTarget, setCooldownTarget] = useState<number>(
    Date.now() + data.resendCooldownSeconds * 1000,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const expiresInSeconds = useCountdown(data.expiresAt);
  const cooldownSeconds = useCountdown(cooldownTarget);
  const codeExpired = expiresInSeconds <= 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (verifyState.status === "locked") {
      onLocked(verifyState.lockedUntil, verifyState.secondsRemaining);
    }
  }, [verifyState, onLocked]);

  useEffect(() => {
    if (resendState.status === "otp_required") {
      onDataRefresh({
        emailMasked: resendState.emailMasked,
        expiresAt: resendState.expiresAt,
        resendCooldownSeconds: resendState.resendCooldownSeconds,
      });
      setCooldownTarget(Date.now() + resendState.resendCooldownSeconds * 1000);
      setCode("");
      setLocalError(null);
      setVerifyState({ status: "idle" });
      inputRef.current?.focus();
    } else if (resendState.status === "locked") {
      onLocked(resendState.lockedUntil, resendState.secondsRemaining);
    } else if (resendState.status === "preauth_expired") {
      onRestart();
    }
  }, [resendState, onDataRefresh, onLocked, onRestart]);

  const resendMessage =
    resendState.status === "otp_required"
      ? resendState.message ?? "A new verification code has been sent."
      : null;

  function handleCodeChange(raw: string) {
    setCode(normalizeOtpCode(raw));
    setLocalError(null);
  }

  async function handleVerify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = otpSchema.safeParse(code);
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "Enter the 8-character code from the email.");
      inputRef.current?.focus();
      return;
    }

    setLocalError(null);
    setVerifyState({ status: "idle" });
    setVerifying(true);
    try {
      const formData = new FormData();
      formData.set("csrf", csrfToken);
      formData.set("code", parsed.data);
      const result = await verifyOtpAction({ status: "idle" }, formData);
      setVerifyState(result);
    } catch {
      setVerifyState({
        status: "unavailable",
        message: "Verification failed due to a network or server error. Please try again.",
      });
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    setResendState({ status: "idle" });
    setResending(true);
    try {
      const formData = new FormData();
      formData.set("csrf", csrfToken);
      const result = await resendOtpAction({ status: "idle" }, formData);
      setResendState(result);
      if (result.status === "blocked" && result.retryAfterSeconds) {
        setCooldownTarget(Date.now() + result.retryAfterSeconds * 1000);
      }
    } catch {
      setResendState({
        status: "unavailable",
        message: "Could not request a new code. Please try again.",
      });
    } finally {
      setResending(false);
    }
  }

  const verifyErrorMessage = useMemo(() => {
    if (localError) return localError;
    if (verifyState.status === "error") return verifyState.message;
    if (verifyState.status === "blocked" || verifyState.status === "unavailable" || verifyState.status === "config_error") {
      return verifyState.message;
    }
    return null;
  }, [localError, verifyState]);

  const resendErrorMessage =
    resendState.status === "blocked" || resendState.status === "unavailable" ? resendState.message : null;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-md bg-secondary" aria-hidden="true">
          <MailCheck className="size-5 text-navy" />
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground">Enter verification code</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          A {OTP_LENGTH}-character code was sent to{" "}
          <span className="font-medium text-foreground">{data.emailMasked}</span>. It is valid for{" "}
          {OTP_TTL_MINUTES} minutes and can be used once.
        </p>
      </div>

      <div
        className={`rounded-md border px-3.5 py-3 text-center text-[13px] ${
          codeExpired
            ? "border-destructive/30 bg-destructive/5 text-destructive"
            : "border-gold/40 bg-accent text-muted-foreground"
        }`}
        role="status"
      >
        {codeExpired ? (
          <span className="font-medium">This code has expired. Request a new one below.</span>
        ) : (
          <>
            Code expires in{" "}
            <span className="tnum font-semibold text-navy">{formatDuration(expiresInSeconds)}</span>
          </>
        )}
      </div>

      <div aria-live="polite">
        {verifyErrorMessage ? (
          <div
            role="alert"
            className="flex gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="leading-relaxed">{verifyErrorMessage}</p>
          </div>
        ) : null}
        {resendMessage && !verifyErrorMessage ? (
          <div
            role="status"
            className="flex gap-2.5 rounded-md border border-emerald-700/25 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-800"
          >
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="leading-relaxed">{resendMessage}</p>
          </div>
        ) : null}
        {resendErrorMessage && !resendMessage && !verifyErrorMessage ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm text-destructive"
          >
            <p className="leading-relaxed">{resendErrorMessage}</p>
          </div>
        ) : null}
      </div>

      <form onSubmit={handleVerify} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="otp-code">Verification code</Label>
          <Input
            ref={inputRef}
            id="otp-code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="••••••••"
            value={code}
            onChange={(e) => handleCodeChange(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text");
              if (pasted) {
                e.preventDefault();
                handleCodeChange(pasted);
              }
            }}
            aria-invalid={Boolean(verifyErrorMessage)}
            aria-describedby={verifyErrorMessage ? "otp-error" : undefined}
            disabled={verifying}
            className="h-14 text-center font-mono text-[20px] font-semibold uppercase tracking-[0.45em]"
            maxLength={OTP_LENGTH + 4}
          />
          {verifyErrorMessage ? (
            <p id="otp-error" className="sr-only">
              {verifyErrorMessage}
            </p>
          ) : null}
        </div>

        <Button type="submit" className="h-10 w-full" disabled={verifying || codeExpired} aria-busy={verifying}>
          {verifying ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Verifying…
            </>
          ) : (
            <>
              <ShieldCheck className="size-4" aria-hidden="true" />
              Verify and sign in
            </>
          )}
        </Button>
      </form>

      <div className="space-y-3">
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full"
          onClick={handleResend}
          disabled={resending || cooldownSeconds > 0}
          aria-busy={resending}
        >
          {resending ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Sending new code…
            </>
          ) : cooldownSeconds > 0 ? (
            <>
              <RefreshCw className="size-4 opacity-50" aria-hidden="true" />
              Resend code in {formatDuration(cooldownSeconds)}
            </>
          ) : (
            <>
              <RefreshCw className="size-4" aria-hidden="true" />
              Resend code
            </>
          )}
        </Button>

        <button
          type="button"
          onClick={onRestart}
          className="flex w-full cursor-pointer items-center justify-center gap-1.5 text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to sign in
        </button>
      </div>
    </div>
  );
}
