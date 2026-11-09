"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Building2,
  Check,
  ImagePlus,
  Loader2,
  Mail,
  MailCheck,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useCountdown, formatDuration } from "@/components/auth/use-countdown";
import {
  confirmEmailChangeAction,
  requestEmailChangeAction,
  resendEmailChangeCodeAction,
  updateCorporationProfileAction,
} from "@/server/actions/account-actions";
import {
  corporationProfileSchema,
  emailChangeCodeSchema,
  clientCorporationLogoError,
  CORPORATION_LOGO_ACCEPT_ATTRIBUTE,
  type CorporationProfileInput,
} from "@/lib/account/validation";
import { normalizeOtpCode } from "@/lib/auth/validation";
import type { EmailChangeActionState, ProfileActionState } from "@/types/account";

/**
 * Corporation Profile — the editable profile section of Account Settings.
 *
 *   * Corporation name, corporation logo and the administrator display name
 *     save immediately (validated client- AND server-side; logo re-verified
 *     from the actual bytes on the server).
 *   * The administrator email is managed through a VERIFICATION flow: a code
 *     is emailed to the new address and only a confirmed code activates it.
 *   * After every successful save the interface updates immediately (form
 *     reset to the fresh server values + router refresh).
 */

interface PendingEmail {
  newEmailMasked: string;
  expiresAt: string;
  resendCooldownSeconds: number;
}

export function CorporationProfileCard({
  csrfToken,
  corporationName,
  logoUrl,
  displayName,
  currentEmail,
  initialPendingEmail,
}: {
  csrfToken: string;
  corporationName: string;
  logoUrl: string | null;
  displayName: string;
  currentEmail: string;
  initialPendingEmail: PendingEmail | null;
}) {
  const router = useRouter();

  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b p-5">
        <Building2 className="size-4 text-gold" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Corporation profile</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Brand identity and administrator identity — stored separately from authentication credentials.
          </p>
        </div>
      </div>

      <div className="space-y-0 p-5">
        <ProfileForm
          csrfToken={csrfToken}
          corporationName={corporationName}
          logoUrl={logoUrl}
          displayName={displayName}
          currentEmail={currentEmail}
        />

        <Separator className="my-6" />

        <EmailChangeSection
          csrfToken={csrfToken}
          currentEmail={currentEmail}
          initialPendingEmail={initialPendingEmail}
          onChanged={() => router.refresh()}
        />
      </div>
    </section>
  );
}

/* ============================================================================
 * Profile form — corporation name, logo, administrator display name
 * ==========================================================================*/

function ProfileForm({
  csrfToken,
  corporationName,
  logoUrl,
  displayName,
  currentEmail,
}: {
  csrfToken: string;
  corporationName: string;
  logoUrl: string | null;
  displayName: string;
  currentEmail: string;
}) {
  const router = useRouter();
  const [serverState, setServerState] = useState<ProfileActionState>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);

  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<CorporationProfileInput>({
    resolver: zodResolver(corporationProfileSchema),
    defaultValues: { corporationName, displayName, email: currentEmail },
  });

  // Keep the form in sync with fresh server values after revalidation. The
  // email field is carried for schema validation only (the current email —
  // changes go through the dedicated verification section below).
  useEffect(() => {
    form.reset({ corporationName, displayName, email: currentEmail });
  }, [form, corporationName, displayName, currentEmail]);

  // Reset the "remove logo" intent whenever a new file is chosen.
  useEffect(() => {
    if (logoFile) setRemoveLogo(false);
  }, [logoFile]);

  // Blob preview lifecycle.
  useEffect(() => {
    if (!logoFile) {
      setLogoPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  function handleLogoChange(event: React.ChangeEvent<HTMLInputElement>) {
    setLogoError(null);
    setServerState({ status: "idle" });
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setLogoFile(null);
      return;
    }
    const error = clientCorporationLogoError(file);
    if (error) {
      setLogoError(error);
      setLogoFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setLogoFile(file);
  }

  async function onSubmit(values: CorporationProfileInput) {
    setServerState({ status: "idle" });
    const localLogoError = clientCorporationLogoError(logoFile);
    if (localLogoError) {
      setLogoError(localLogoError);
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.set("csrf", csrfToken);
      formData.set("corporationName", values.corporationName);
      formData.set("displayName", values.displayName);
      formData.set("email", values.email ?? "");
      if (logoFile) formData.set("logo", logoFile);
      if (removeLogo) formData.set("removeLogo", "true");

      const result = await updateCorporationProfileAction({ status: "idle" }, formData);
      setServerState(result);

      if (result.status === "saved") {
        toast.success(result.message);
        setLogoFile(null);
        setRemoveLogo(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
        router.refresh();
      } else if (result.status === "invalid") {
        for (const [field, message] of Object.entries(result.fieldErrors)) {
          if (field === "logo") {
            setLogoError(message);
          } else if (field === "email") {
            continue; // managed by the dedicated section
          } else {
            form.setError(field as keyof CorporationProfileInput, { type: "server", message });
          }
        }
      } else if (result.status === "unauthorized") {
        toast.error(result.message);
        router.refresh();
      }
    } catch {
      setServerState({
        status: "unavailable",
        message: "The profile could not be submitted due to a network or server error. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const nameError = form.formState.errors.corporationName?.message;
  const displayNameError = form.formState.errors.displayName?.message;

  const shownLogo = logoPreviewUrl ?? (removeLogo ? null : logoUrl);

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div aria-live="polite">
        {serverState.status === "blocked" ||
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

      {/* Corporation logo — upload / replace / restore default */}
      <div className="space-y-1.5">
        <Label htmlFor="corporationLogoFile">Corporation logo</Label>
        <div className="flex items-center gap-4">
          <span
            className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-secondary/60"
            aria-hidden="true"
          >
            {shownLogo ? (
              <img src={shownLogo} alt="" className="h-full w-full object-contain p-1.5" />
            ) : (
              <Building2 className="size-6 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <input
              ref={fileInputRef}
              id="corporationLogoFile"
              type="file"
              accept={CORPORATION_LOGO_ACCEPT_ATTRIBUTE}
              className="hidden"
              onChange={handleLogoChange}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus className="size-3.5" aria-hidden="true" />
                {logoFile ? "Replace logo" : logoUrl ? "Upload new logo" : "Choose logo"}
              </Button>
              {logoFile ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-muted-foreground"
                  onClick={() => {
                    setLogoFile(null);
                    setLogoError(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  Discard
                </Button>
              ) : logoUrl && !removeLogo ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-muted-foreground"
                  onClick={() => {
                    setRemoveLogo(true);
                    setServerState({ status: "idle" });
                  }}
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Restore official logo
                </Button>
              ) : removeLogo ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-muted-foreground"
                  onClick={() => setRemoveLogo(false)}
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Keep uploaded logo
                </Button>
              ) : null}
            </div>
            {logoFile ? (
              <p className="mt-1.5 truncate text-[12px] text-muted-foreground" title={logoFile.name}>
                {logoFile.name} · {(logoFile.size / 1024).toFixed(0)} KB — uploaded on save
              </p>
            ) : (
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                {logoUrl
                  ? "A custom logo is active. PNG, JPG, JPEG or WebP · up to 2 MB."
                  : "Official brand logo in use. Upload to customize — PNG, JPG, JPEG or WebP · up to 2 MB."}
              </p>
            )}
          </div>
        </div>
        {logoError ? (
          <p role="alert" className="text-[13px] font-medium text-destructive">
            {logoError}
          </p>
        ) : null}
      </div>

      {/* Corporation name */}
      <div className="space-y-1.5">
        <Label htmlFor="corporationName">Corporation name</Label>
        <Input
          id="corporationName"
          autoComplete="organization"
          placeholder="Niyojan Corporation"
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? "corporationName-error" : undefined}
          className="h-10"
          {...form.register("corporationName")}
        />
        {nameError ? (
          <p id="corporationName-error" className="text-[13px] font-medium text-destructive">
            {nameError}
          </p>
        ) : null}
      </div>

      {/* Administrator display name */}
      <div className="space-y-1.5">
        <Label htmlFor="displayName">Administrator display name</Label>
        <Input
          id="displayName"
          autoComplete="name"
          placeholder="Deepak Khurana"
          aria-invalid={Boolean(displayNameError)}
          aria-describedby={displayNameError ? "displayName-error" : "displayName-hint"}
          className="h-10"
          {...form.register("displayName")}
        />
        {displayNameError ? (
          <p id="displayName-error" className="text-[13px] font-medium text-destructive">
            {displayNameError}
          </p>
        ) : (
          <p id="displayName-hint" className="text-[12px] text-muted-foreground">
            Shown in the console header and greetings — sourced from the authenticated account.
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Saving changes…
            </>
          ) : (
            "Save changes"
          )}
        </Button>
      </div>
    </form>
  );
}

/* ============================================================================
 * Email change — verification-gated activation
 * ==========================================================================*/

function EmailChangeSection({
  csrfToken,
  currentEmail,
  initialPendingEmail,
  onChanged,
}: {
  csrfToken: string;
  currentEmail: string;
  initialPendingEmail: PendingEmail | null;
  onChanged: () => void;
}) {
  const [newEmail, setNewEmail] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [resending, setResending] = useState(false);
  const [code, setCode] = useState("");

  const [requestState, setRequestState] = useState<EmailChangeActionState>({ status: "idle" });
  const [confirmState, setConfirmState] = useState<EmailChangeActionState>({ status: "idle" });

  const [pending, setPending] = useState<PendingEmail | null>(initialPendingEmail);

  const [cooldownTarget, setCooldownTarget] = useState<number>(
    initialPendingEmail ? Date.now() + initialPendingEmail.resendCooldownSeconds * 1000 : 0,
  );
  const cooldownSeconds = useCountdown(cooldownTarget || null);
  const expiresInSeconds = useCountdown(pending?.expiresAt ?? null);

  useEffect(() => {
    if (initialPendingEmail) setPending(initialPendingEmail);
  }, [initialPendingEmail]);

  async function handleRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestState({ status: "idle" });
    setConfirmState({ status: "idle" });

    const emailValue = newEmail.trim();
    if (emailValue.length === 0) {
      setRequestState({ status: "error", message: "Enter the new email address first." });
      return;
    }
    if (emailValue.toLowerCase() === currentEmail.toLowerCase()) {
      setRequestState({ status: "error", message: "This is already your administrator email." });
      return;
    }

    setRequesting(true);
    try {
      const formData = new FormData();
      formData.set("csrf", csrfToken);
      formData.set("newEmail", emailValue);
      const result = await requestEmailChangeAction({ status: "idle" }, formData);
      setRequestState(result);
      if (result.status === "sent") {
        setPending(result.pendingEmail);
        setCooldownTarget(Date.now() + result.pendingEmail.resendCooldownSeconds * 1000);
        setCode("");
        toast.success("Verification code sent.", {
          description: `Check the inbox at ${result.pendingEmail.newEmailMasked}.`,
        });
      }
    } catch {
      setRequestState({
        status: "unavailable",
        message: "The request could not be submitted due to a network or server error. Please try again.",
      });
    } finally {
      setRequesting(false);
    }
  }

  async function handleConfirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirmState({ status: "idle" });

    const parsed = emailChangeCodeSchema.safeParse(code);
    if (!parsed.success) {
      setConfirmState({
        status: "error",
        message: parsed.error.issues[0]?.message ?? "Enter the 8-character code from the email.",
      });
      return;
    }

    setConfirming(true);
    try {
      const formData = new FormData();
      formData.set("csrf", csrfToken);
      formData.set("code", parsed.data);
      const result = await confirmEmailChangeAction({ status: "idle" }, formData);
      setConfirmState(result);
      if (result.status === "verified") {
        setPending(null);
        setNewEmail("");
        setCode("");
        setCooldownTarget(0);
        toast.success(result.message);
        onChanged();
      }
    } catch {
      setConfirmState({
        status: "unavailable",
        message: "Verification failed due to a network or server error. Please try again.",
      });
    } finally {
      setConfirming(false);
    }
  }

  async function handleResend() {
    setRequestState({ status: "idle" });
    setConfirmState({ status: "idle" });
    setResending(true);
    try {
      const formData = new FormData();
      formData.set("csrf", csrfToken);
      const result = await resendEmailChangeCodeAction({ status: "idle" }, formData);
      if (result.status === "sent") {
        setPending(result.pendingEmail);
        setCooldownTarget(Date.now() + result.pendingEmail.resendCooldownSeconds * 1000);
        setCode("");
        toast.success(result.message);
      } else if (result.status === "error") {
        setConfirmState(result);
      }
    } catch {
      setConfirmState({
        status: "unavailable",
        message: "The resend failed due to a network or server error. Please try again.",
      });
    } finally {
      setResending(false);
    }
  }

  const requestError =
    requestState.status === "error" || requestState.status === "blocked" ||
    requestState.status === "unavailable" || requestState.status === "config_error"
      ? requestState.message
      : null;
  const confirmError =
    confirmState.status === "error" || confirmState.status === "blocked" ||
    confirmState.status === "unavailable" || confirmState.status === "config_error"
      ? confirmState.message
      : null;
  const codeExpired = pending !== null && expiresInSeconds <= 0;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="currentEmailDisplay">Administrator email</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="currentEmailDisplay"
            readOnly
            value={currentEmail}
            className="h-10 max-w-md flex-1 font-mono text-[13px]"
            aria-describedby="currentEmail-hint"
          />
          <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-700/25 bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-800">
            <MailCheck className="size-3.5" aria-hidden="true" />
            Active
          </span>
        </div>
        <p id="currentEmail-hint" className="text-[12px] text-muted-foreground">
          Sign-in verification codes are delivered to this address. Changing it requires email verification.
        </p>
      </div>

      {/* Step 1 — request the change */}
      <form onSubmit={handleRequest} className="space-y-2.5" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="newEmail">New email address</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="newEmail"
              type="email"
              autoComplete="email"
              placeholder="new.address@company.com"
              value={newEmail}
              onChange={(e) => {
                setNewEmail(e.target.value);
                setRequestState({ status: "idle" });
              }}
              className="h-10 max-w-md flex-1"
              aria-invalid={Boolean(requestError)}
              aria-describedby={requestError ? "newEmail-error" : undefined}
            />
            <Button type="submit" variant="outline" className="h-10" disabled={requesting} aria-busy={requesting}>
              {requesting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Sending code…
                </>
              ) : (
                <>
                  <Mail className="size-4" aria-hidden="true" />
                  Send verification code
                </>
              )}
            </Button>
          </div>
          {requestError ? (
            <p id="newEmail-error" role="alert" className="text-[13px] font-medium text-destructive">
              {requestError}
            </p>
          ) : null}
        </div>
      </form>

      {/* Step 2 — confirm with the code */}
      {pending ? (
        <div className="rounded-lg border border-gold/40 bg-accent/60 p-4">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-gold" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                Confirm your new email — code sent to{" "}
                <span className="font-mono text-[13px]">{pending.newEmailMasked}</span>
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {codeExpired ? (
                  <span className="font-medium text-destructive">
                    This code has expired — request a new one below.
                  </span>
                ) : (
                  <>
                    Code expires in{" "}
                    <span className="tnum font-semibold text-navy">{formatDuration(expiresInSeconds)}</span> · the
                    current email stays active until the code is confirmed.
                  </>
                )}
              </p>
            </div>
          </div>

          <form onSubmit={handleConfirm} className="mt-3.5 space-y-2.5" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="emailChangeCode">Confirmation code</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="emailChangeCode"
                  type="text"
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="••••••••"
                  value={code}
                  onChange={(e) => {
                    setCode(normalizeOtpCode(e.target.value));
                    setConfirmState({ status: "idle" });
                  }}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData("text");
                    if (pasted) {
                      e.preventDefault();
                      setCode(normalizeOtpCode(pasted));
                    }
                  }}
                  maxLength={12}
                  className="h-11 w-48 text-center font-mono text-[16px] font-semibold uppercase tracking-[0.35em]"
                  aria-invalid={Boolean(confirmError)}
                  aria-describedby={confirmError ? "emailChangeCode-error" : undefined}
                />
                <Button type="submit" className="h-11" disabled={confirming || code.length === 0} aria-busy={confirming}>
                  {confirming ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Verifying…
                    </>
                  ) : (
                    "Confirm new email"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  onClick={() => void handleResend()}
                  disabled={resending || cooldownSeconds > 0}
                  aria-busy={resending}
                >
                  {resending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Resending…
                    </>
                  ) : cooldownSeconds > 0 ? (
                    `Resend in ${cooldownSeconds}s`
                  ) : (
                    <>
                      <RefreshCw className="size-4" aria-hidden="true" />
                      Resend code
                    </>
                  )}
                </Button>
              </div>
              {confirmError ? (
                <p id="emailChangeCode-error" role="alert" className="text-[13px] font-medium text-destructive">
                  {confirmError}
                </p>
              ) : null}
            </div>
          </form>

          {confirmState.status === "verified" ? (
            <div
              role="status"
              className="mt-3 flex gap-2.5 rounded-md border border-emerald-700/25 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-800"
            >
              <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p className="leading-relaxed">{confirmState.message}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
