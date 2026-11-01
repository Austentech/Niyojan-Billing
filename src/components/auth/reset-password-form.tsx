"use client";

import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Loader2, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { PasswordInput } from "@/components/auth/password-input";
import { resetPasswordSchema, type ResetPasswordInput } from "@/lib/validators";
import { resetPasswordAction } from "@/server/actions/auth-actions";
import { cn } from "@/lib/utils";

const REQUIREMENTS = [
  { key: "length", label: "At least 10 characters", test: (v: string) => v.length >= 10 },
  { key: "lower", label: "One lowercase letter", test: (v: string) => /[a-z]/.test(v) },
  { key: "upper", label: "One uppercase letter", test: (v: string) => /[A-Z]/.test(v) },
  { key: "digit", label: "One number", test: (v: string) => /[0-9]/.test(v) },
  { key: "symbol", label: "One symbol (e.g. ! @ # $)", test: (v: string) => /[^A-Za-z0-9]/.test(v) },
] as const;

export function ResetPasswordForm({
  token,
  onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, password: "", confirmPassword: "" },
  });
  const password = form.watch("password");
  const states = useMemo(() => REQUIREMENTS.map((r) => ({ ...r, met: r.test(password ?? "") })), [password]);

  async function onSubmit(values: ResetPasswordInput) {
    setServerError(null);
    setSubmitting(true);
    try {
      const result = await resetPasswordAction(values);
      if (result.ok) {
        setSuccess(true);
        toast.success(result.message ?? "Password updated.");
        window.history.replaceState(null, "", "/");
      } else {
        setServerError(result.message);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            form.setError(field as keyof ResetPasswordInput, { message: messages[0] });
          }
        }
      }
    } catch {
      setServerError("The request failed due to a network or server error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="space-y-6">
        <div className="flex size-11 items-center justify-center rounded-md bg-secondary">
          <ShieldCheck className="size-5 text-navy" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Password updated</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            All active sessions were signed out for security. Sign in with your new password to continue.
          </p>
        </div>
        <Button type="button" className="h-10 w-full" onClick={onDone}>
          Continue to sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This link is single-use and expires 30 minutes after it was requested.
        </p>
      </div>

      {serverError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Reset failed</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      ) : null}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <input type="hidden" {...form.register("token")} />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" placeholder="New password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <ul aria-label="Password requirements" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {states.map((r) => (
              <li
                key={r.key}
                className={cn(
                  "flex items-center gap-1.5 text-xs transition-colors",
                  r.met ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {r.met ? (
                  <Check className="size-3.5 shrink-0 text-gold" aria-hidden="true" />
                ) : (
                  <X className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                {r.label}
              </li>
            ))}
          </ul>

          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm new password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" placeholder="Repeat the new password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button type="submit" className="h-10 w-full" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Updating…
              </>
            ) : (
              "Update password"
            )}
          </Button>
        </form>
      </Form>
    </div>
  );
}
