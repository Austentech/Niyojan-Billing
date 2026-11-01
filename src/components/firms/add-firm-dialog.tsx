"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ImagePlus, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createFirmAction } from "@/server/actions/firm-actions";
import {
  firmFormSchema,
  clientLogoError,
  LOGO_ACCEPT_ATTRIBUTE,
  type FirmFormInput,
} from "@/lib/firms/validation";
import { FIRM_POLICY } from "@/lib/constants";
import type { FirmActionState } from "@/types/firms";

/**
 * Add New Firm — professional modal form.
 *
 *   * Client-side Zod mirrors the authoritative server validation (UX only).
 *   * The optional logo is checked immediately (type + size) and re-verified
 *     on the server from the actual bytes.
 *   * On success: feedback, the form closes, and both the dashboard and the
 *     firm-management list revalidate (server re-render) — the new firm is
 *     immediately visible everywhere.
 */
export function AddFirmDialog({
  csrfToken,
  autoOpen = false,
  trigger = "header",
}: {
  csrfToken: string;
  autoOpen?: boolean;
  trigger?: "header" | "empty";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverState, setServerState] = useState<FirmActionState>({ status: "idle" });
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<FirmFormInput, unknown, ReturnType<typeof firmFormSchema.parse>>({
    resolver: zodResolver(firmFormSchema),
    defaultValues: { firmName: "", websiteUrl: "", holdingPercentage: "", address: "", description: "" },
  });

  /* Auto-open via /settings/firms?new=1 (dashboard empty-state CTA), then
     strip the parameter so a refresh does not reopen the modal. */
  useEffect(() => {
    if (autoOpen) {
      setOpen(true);
      router.replace("/settings/firms");
    }
  }, [autoOpen, router]);

  /* Blob preview lifecycle. */
  useEffect(() => {
    if (!logoFile) {
      setLogoPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  function resetAll() {
    form.reset();
    setLogoFile(null);
    setLogoError(null);
    setServerState({ status: "idle" });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleLogoChange(event: React.ChangeEvent<HTMLInputElement>) {
    setLogoError(null);
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setLogoFile(null);
      return;
    }
    const error = clientLogoError(file);
    if (error) {
      setLogoError(error);
      setLogoFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setLogoFile(file);
  }

  async function onSubmit(values: ReturnType<typeof firmFormSchema.parse>) {
    setServerState({ status: "idle" });
    const localLogoError = clientLogoError(logoFile);
    if (localLogoError) {
      setLogoError(localLogoError);
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.set("csrf", csrfToken);
      formData.set("firmName", values.firmName);
      formData.set("websiteUrl", values.websiteUrl ?? "");
      formData.set("holdingPercentage", String(values.holdingPercentage));
      formData.set("address", values.address);
      formData.set("description", values.description ?? "");
      if (logoFile) formData.set("logo", logoFile);

      const result = await createFirmAction({ status: "idle" }, formData);
      setServerState(result);

      if (result.status === "created") {
        toast.success(`${result.firmName} has been added.`, {
          description: "The dashboard and this list now include the new firm.",
        });
        setOpen(false);
        resetAll();
        // Belt and braces alongside the action's revalidatePath.
        router.refresh();
      } else if (result.status === "invalid") {
        for (const [field, message] of Object.entries(result.fieldErrors)) {
          if (field === "logo") {
            setLogoError(message);
          } else if (field === "form") {
            continue;
          } else {
            form.setError(field as keyof FirmFormInput, { type: "server", message });
          }
        }
        if (result.fieldErrors.form) {
          toast.error(result.fieldErrors.form);
        }
      } else if (result.status === "unauthorized") {
        toast.error(result.message);
        setOpen(false);
        router.refresh();
      } else {
        toast.error("The firm could not be saved. Please try again.");
      }
    } catch {
      setServerState({
        status: "unavailable",
        message: "The firm could not be submitted due to a network or server error. Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const errors = form.formState.errors;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetAll();
      }}
    >
      <DialogTrigger asChild>
        {trigger === "empty" ? (
          <Button size="lg">
            <Plus className="size-4" aria-hidden="true" />
            Add Your First Firm
          </Button>
        ) : (
          <Button size="sm" className="h-9">
            <Plus className="size-4" aria-hidden="true" />
            Add New Firm
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-h-[88vh] overflow-y-auto scrollbar-thin sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add New Firm</DialogTitle>
          <DialogDescription>
            Register a business entity operating under Niyojan Corporation. Fields marked with an
            asterisk are required.
          </DialogDescription>
        </DialogHeader>

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

          {/* Firm name — required */}
          <div className="space-y-1.5">
            <Label htmlFor="firmName">
              Firm name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="firmName"
              autoComplete="organization"
              placeholder="e.g. Khurana Structural Works LLP"
              aria-invalid={Boolean(errors.firmName)}
              aria-describedby={errors.firmName ? "firmName-error" : undefined}
              className="h-10"
              {...form.register("firmName")}
            />
            {errors.firmName ? (
              <p id="firmName-error" className="text-[13px] font-medium text-destructive">
                {errors.firmName.message}
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_150px]">
            {/* Website — optional, must be a valid http(s) URL */}
            <div className="space-y-1.5">
              <Label htmlFor="websiteUrl">Website URL</Label>
              <Input
                id="websiteUrl"
                type="text"
                inputMode="url"
                autoComplete="url"
                placeholder="https://www.example.com"
                aria-invalid={Boolean(errors.websiteUrl)}
                aria-describedby={errors.websiteUrl ? "websiteUrl-error" : "websiteUrl-hint"}
                className="h-10"
                {...form.register("websiteUrl")}
              />
              {errors.websiteUrl ? (
                <p id="websiteUrl-error" className="text-[13px] font-medium text-destructive">
                  {errors.websiteUrl.message}
                </p>
              ) : (
                <p id="websiteUrl-hint" className="text-[12px] text-muted-foreground">
                  Optional — must start with http:// or https://
                </p>
              )}
            </div>

            {/* Holding percentage — required, 0–100, two decimals */}
            <div className="space-y-1.5">
              <Label htmlFor="holdingPercentage">
                Holding <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="holdingPercentage"
                  inputMode="decimal"
                  placeholder="51.25"
                  aria-invalid={Boolean(errors.holdingPercentage)}
                  aria-describedby={errors.holdingPercentage ? "holdingPercentage-error" : "holdingPercentage-hint"}
                  className="tnum h-10 pr-8"
                  {...form.register("holdingPercentage")}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[13px] text-muted-foreground">
                  %
                </span>
              </div>
              {errors.holdingPercentage ? (
                <p id="holdingPercentage-error" className="text-[13px] font-medium text-destructive">
                  {errors.holdingPercentage.message}
                </p>
              ) : (
                <p id="holdingPercentage-hint" className="text-[12px] text-muted-foreground">
                  Niyojan Corp. share
                </p>
              )}
            </div>
          </div>

          {/* Address — required */}
          <div className="space-y-1.5">
            <Label htmlFor="address">
              Address <span className="text-destructive">*</span>
            </Label>
            <Input
              id="address"
              autoComplete="street-address"
              placeholder="Street, city, state — a short registered address"
              aria-invalid={Boolean(errors.address)}
              aria-describedby={errors.address ? "address-error" : `address-hint`}
              className="h-10"
              {...form.register("address")}
            />
            {errors.address ? (
              <p id="address-error" className="text-[13px] font-medium text-destructive">
                {errors.address.message}
              </p>
            ) : (
              <p id="address-hint" className="text-[12px] text-muted-foreground">
                {FIRM_POLICY.addressMinLength}–{FIRM_POLICY.addressMaxLength} characters.
              </p>
            )}
          </div>

          {/* Basic details — optional */}
          <div className="space-y-1.5">
            <Label htmlFor="description">Basic details</Label>
            <Textarea
              id="description"
              rows={3}
              placeholder="Optional notes about the firm's nature of business, registration, etc."
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? "description-error" : "description-hint"}
              className="resize-none"
              {...form.register("description")}
            />
            {errors.description ? (
              <p id="description-error" className="text-[13px] font-medium text-destructive">
                {errors.description.message}
              </p>
            ) : (
              <p id="description-hint" className="text-[12px] text-muted-foreground">
                Optional — up to {FIRM_POLICY.descriptionMaxLength} characters.
              </p>
            )}
          </div>

          {/* Firm logo — optional image upload */}
          <div className="space-y-1.5">
            <Label htmlFor="firmLogoFile">Firm logo</Label>
            <div className="flex items-center gap-4">
              <span
                className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-secondary/60"
                aria-hidden="true"
              >
                {logoPreviewUrl ? (
                   
                  <img src={logoPreviewUrl} alt="" className="h-full w-full object-contain p-1" />
                ) : (
                  <ImagePlus className="size-5 text-muted-foreground" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <input
                  ref={fileInputRef}
                  id="firmLogoFile"
                  type="file"
                  accept={LOGO_ACCEPT_ATTRIBUTE}
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
                    {logoFile ? "Replace logo" : "Choose logo"}
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
                      Remove
                    </Button>
                  ) : null}
                </div>
                {logoFile ? (
                  <p className="mt-1.5 truncate text-[12px] text-muted-foreground" title={logoFile.name}>
                    {logoFile.name} · {(logoFile.size / 1024).toFixed(0)} KB
                  </p>
                ) : (
                  <p className="mt-1.5 text-[12px] text-muted-foreground">
                    PNG, JPG, JPEG or WebP · up to 2 MB · optional
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

          <DialogFooter className="gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
                resetAll();
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Saving firm…
                </>
              ) : (
                "Save Firm"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
