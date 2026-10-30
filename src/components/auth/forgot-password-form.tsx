"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, MailQuestion, ArrowLeft, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/lib/validators";
import { forgotPasswordAction } from "@/server/actions/auth-actions";

/**
 * Forgot-password request form. The server always answers with a generic
 * message (no account enumeration). When SMTP is unconfigured and
 * EXPOSE_RESET_LINK=true, the reset link is surfaced for environment setup.
 */
export function ForgotPasswordForm({
  onBack,
  onContinueToReset,
}: {
  onBack: () => void;
  onContinueToReset: (token: string) => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [exposedLink, setExposedLink] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  async function onSubmit(values: ForgotPasswordInput) {
    setServerError(null);
    setSentMessage(null);
    setExposedLink(null);
    setSubmitting(true);
    try {
      const result = await forgotPasswordAction(values);
      if (result.ok) {
        setSentMessage(result.message ?? "Check your inbox for reset instructions.");
        if (result.data?.resetUrl) setExposedLink(result.data.resetUrl);
      } else {
        setServerError(result.message);
      }
    } catch {
      setServerError("The request failed due to a network or server error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the administrator email address and we will send reset instructions.
        </p>
      </div>

      {sentMessage ? (
        <Alert className="border-border bg-secondary">
          <MailQuestion className="size-4 text-navy" aria-hidden="true" />
          <AlertTitle>Request received</AlertTitle>
          <AlertDescription>{sentMessage}</AlertDescription>
          {exposedLink ? (
            <div className="mt-3 space-y-2 rounded-md border border-gold/40 bg-accent p-3">
              <p className="text-xs font-medium text-foreground">
                Email delivery is not configured on this environment (SMTP). The single-use link below is shown
                for environment setup only and expires in 30 minutes:
              </p>
              <p className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground">{exposedLink}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => {
                  const token = exposedLink.split("reset=")[1];
                  if (token) {
                    onContinueToReset(decodeURIComponent(token));
                  } else {
                    toast.error("Could not extract the reset token from the link.");
                  }
                }}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Continue to reset form
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : null}

      {serverError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      ) : null}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email address</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="admin@niyojan.com"
                    className="h-10"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" className="h-10 w-full" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Sending…
              </>
            ) : (
              "Send reset instructions"
            )}
          </Button>
        </form>
      </Form>

      <button
        type="button"
        onClick={onBack}
        className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to sign in
      </button>
    </div>
  );
}
