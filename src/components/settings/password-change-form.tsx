"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/auth/password-input";
import { changePasswordAction } from "@/server/actions/account-actions";
import { passwordChangeFormSchema, type PasswordChangeFormInput } from "@/lib/auth/validation";
import type { PasswordActionState } from "@/types/firms";

/**
 * Account Settings — password change.
 *
 *   * Client-side Zod mirrors the server schema (UX only; the server action
 *     re-validates authoritatively).
 *   * The new password is Argon2id-hashed server-side; plaintext never
 *     reaches the database, logs or responses.
 *   * On success every OTHER session is revoked server-side.
 */
export function PasswordChangeForm({ csrfToken }: { csrfToken: string }) {
  const [serverState, setServerState] = useState<PasswordActionState>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<PasswordChangeFormInput>({
    resolver: zodResolver(passwordChangeFormSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

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
        toast.success(result.message);
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
          placeholder="At least 10 characters"
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
            10–128 characters. Stored only as an Argon2id hash.
          </p>
        )}
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
