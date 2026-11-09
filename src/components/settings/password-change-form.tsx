"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Loader2, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/auth/password-input";
import { changePasswordAction } from "@/server/actions/account-actions";
import { passwordChangeFormSchema, type PasswordChangeFormInput } from "@/lib/auth/validation";
import { PASSWORD_POLICY } from "@/lib/constants";
import type { PasswordActionState } from "@/types/account";

/**
 * Account Settings — password change.
 *
 *   * Client-side Zod mirrors the server schema (UX only; the server action
 *     re-validates authoritatively).
 *   * STRONG policy: at least 12 characters with uppercase, lowercase, number
 *     and special character — live checklist mirrors the server rules.
 *   * The new password is Argon2id-hashed server-side; plaintext never
 *     reaches the database, logs or responses.
 *   * On success every OTHER session is revoked server-side; this session
 *     stays valid.
 */

const PASSWORD_REQUIREMENTS = [
  {
    key: "length",
    label: `At least ${PASSWORD_POLICY.minLength} characters`,
    test: (v: string) => v.length >= PASSWORD_POLICY.minLength,
  },
  { key: "lower", label: "One lowercase letter", test: (v: string) => /[a-z]/.test(v) },
  { key: "upper", label: "One uppercase letter", test: (v: string) => /[A-Z]/.test(v) },
  { key: "digit", label: "One number", test: (v: string) => /[0-9]/.test(v) },
  { key: "symbol", label: "One special character (e.g. ! @ # $)", test: (v: string) => /[^A-Za-z0-9]/.test(v) },
] as const;

export function PasswordChangeForm({ csrfToken }: { csrfToken: string }) {
  const [serverState, setServerState] = useState<PasswordActionState>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<PasswordChangeFormInput>({
    resolver: zodResolver(passwordChangeFormSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const newPassword = form.watch("newPassword");
  const requirementStates = useMemo(
    () => PASSWORD_REQUIREMENTS.map((requirement) => ({ ...requirement, met: requirement.test(newPassword ?? "") })),
    [newPassword],
  );

  async function onSubmit(values: PasswordChangeFormInput) {
    setServerState({ status: "idle" });
    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.set("csrf", csrfToken);
      formData.set("currentPassword", values.currentPassword);
      formData.set("newPassword", values.newPassword);
      formData.set("confirmPassword", values.confirmPassword);
      const result = await changePasswordAction({ status: "idle" }, formData);
      setServerState(result);
      if (result.status === "success") {
        toast.success(result.message, {
          description: "Use the new password at your next sign-in — the environment credentials no longer apply.",
        });
        form.reset();
      } else if (result.status === "unauthorized") {
        toast.error(result.message);
      }
    } catch {
      setServerState({
        status: "unavailable",
        message: "The password change could not be submitted. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const currentError = form.formState.errors.currentPassword?.message;
  const newError = form.formState.errors.newPassword?.message;
  const confirmError = form.formState.errors.confirmPassword?.message;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div aria-live="polite">
        {serverState.status === "error" ? (
          <div
            role="alert"
            className="flex gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="leading-relaxed">{serverState.message}</p>
          </div>
        ) : serverState.status === "success" ? (
          <div
            role="status"
            className="flex gap-2.5 rounded-md border border-gold/40 bg-accent px-3.5 py-3 text-sm text-foreground"
          >
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-gold" aria-hidden="true" />
            <p className="leading-relaxed">{serverState.message}</p>
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

      <div className="space-y-1.5">
        <Label htmlFor="currentPassword">Current password</Label>
        <PasswordInput
          id="currentPassword"
          autoComplete="current-password"
          placeholder="Enter your current password"
          aria-invalid={Boolean(currentError)}
          aria-describedby={currentError ? "currentPassword-error" : undefined}
          {...form.register("currentPassword")}
        />
        {currentError ? (
          <p id="currentPassword-error" className="text-[13px] font-medium text-destructive">
            {currentError}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="newPassword">New password</Label>
        <PasswordInput
          id="newPassword"
          autoComplete="new-password"
          placeholder={`At least ${PASSWORD_POLICY.minLength} characters`}
          aria-invalid={Boolean(newError)}
          aria-describedby={newError ? "newPassword-error" : "newPassword-hint"}
          {...form.register("newPassword")}
        />
        {newError ? (
          <p id="newPassword-error" className="text-[13px] font-medium text-destructive">
            {newError}
          </p>
        ) : (
          <p id="newPassword-hint" className="text-[12px] text-muted-foreground">
            {PASSWORD_POLICY.minLength}–{PASSWORD_POLICY.maxLength} characters · stored only as an Argon2id hash.
          </p>
        )}
        <ul aria-label="Password requirements" className="mt-2 space-y-1.5">
          {requirementStates.map((requirement) => (
            <li
              key={requirement.key}
              className={
                "flex items-center gap-1.5 text-xs transition-colors " +
                (requirement.met ? "text-foreground" : "text-muted-foreground")
              }
            >
              {requirement.met ? (
                <Check className="size-3.5 shrink-0 text-gold" aria-hidden="true" />
              ) : (
                <X className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              {requirement.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          placeholder="Repeat the new password"
          aria-invalid={Boolean(confirmError)}
          aria-describedby={confirmError ? "confirmPassword-error" : undefined}
          className="h-10"
          {...form.register("confirmPassword")}
        />
        {confirmError ? (
          <p id="confirmPassword-error" className="text-[13px] font-medium text-destructive">
            {confirmError}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="h-10" disabled={submitting} aria-busy={submitting}>
        {submitting ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Updating password…
          </>
        ) : (
          "Update password"
        )}
      </Button>
    </form>
  );
}
