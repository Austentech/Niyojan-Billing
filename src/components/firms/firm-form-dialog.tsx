"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { firmFormSchema, type FirmFormValues } from "@/lib/validators";
import { INDIAN_STATES } from "@/lib/constants";
import { createFirmAction, updateFirmAction } from "@/server/actions/firm-actions";
import type { FirmDto } from "@/types/app";

const EMPTY_FORM: FirmFormValues = {
  name: "",
  legalName: "",
  gstin: "",
  contactPerson: "",
  email: "",
  phone: "",
  addressLine1: "",
  city: "",
  state: "",
  postalCode: "",
  notes: "",
  status: "ACTIVE",
};

function firmToForm(firm: FirmDto): FirmFormValues {
  return {
    name: firm.name,
    legalName: firm.legalName ?? "",
    gstin: firm.gstin ?? "",
    contactPerson: firm.contactPerson ?? "",
    email: firm.email ?? "",
    phone: firm.phone ?? "",
    addressLine1: firm.addressLine1 ?? "",
    city: firm.city ?? "",
    state: firm.state ?? "",
    postalCode: firm.postalCode ?? "",
    notes: firm.notes ?? "",
    status: firm.status,
  };
}

/**
 * Create / edit firm dialog. Same form, same Zod schema as the server action;
 * mobile single column, two columns from `sm`.
 */
export function FirmFormDialog({
  open,
  onOpenChange,
  firm,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  firm: FirmDto | null;
  onSaved: (payload: { firms: FirmDto[]; stats: DashboardStatsLike }, savedFirm?: FirmDto) => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<FirmFormValues>({
    resolver: zodResolver(firmFormSchema),
    defaultValues: EMPTY_FORM,
  });

  useEffect(() => {
    if (open) {
      setServerError(null);
      form.reset(firm ? firmToForm(firm) : EMPTY_FORM);
    }
  }, [open, firm, form]);

  async function onSubmit(values: FirmFormValues) {
    setServerError(null);
    setSubmitting(true);
    try {
      if (firm) {
        const result = await updateFirmAction(firm.id, values);
        if (result.ok) {
          toast.success(result.message ?? "Firm saved.");
          onSaved(result.data!, result.data!.firm);
          onOpenChange(false);
          return;
        }
        applyFailure(result);
      } else {
        const result = await createFirmAction(values);
        if (result.ok) {
          toast.success(result.message ?? "Firm saved.");
          onSaved(result.data!);
          onOpenChange(false);
          return;
        }
        applyFailure(result);
      }
    } catch {
      setServerError("The form could not be submitted due to a network or server error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function applyFailure(result: { message: string; fieldErrors?: Record<string, string[]> }) {
    setServerError(result.message);
    if (result.fieldErrors) {
      for (const [field, messages] of Object.entries(result.fieldErrors)) {
        form.setError(field as keyof FirmFormValues, { message: messages[0] });
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[680px] scrollbar-thin">
        <DialogHeader>
          <DialogTitle>{firm ? `Edit “${firm.name}”` : "Register a new firm"}</DialogTitle>
          <DialogDescription>
            {firm
              ? "Update the registered information for this firm."
              : "Add an independent business firm under centralized Niyojan Corporation management."}
          </DialogDescription>
        </DialogHeader>

        {serverError ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        ) : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <section className="space-y-4">
              <h3 className="text-[13px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Identity
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>Firm name *</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Shree Balaji Constructions" className="h-10" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="legalName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Registered legal name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Shree Balaji Constructions (P) Ltd." className="h-10" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="gstin"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>GSTIN</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="08ABCDE1234F1Z5"
                          className="h-10 font-mono uppercase"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <h3 className="text-[13px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Contact</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="contactPerson"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contact person</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Rajendra Agarwal" className="h-10" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl>
                        <Input placeholder="+91 98250 12345" className="h-10" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="contact@firmname.in" className="h-10" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <h3 className="text-[13px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Registered address
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="addressLine1"
                  render={({ field }) => (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>Address line</FormLabel>
                      <FormControl>
                        <Input placeholder="Street, area, landmark" className="h-10" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>City</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. Jaipur" className="h-10" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="state"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>State</FormLabel>
                      <Select
                        value={field.value === "" ? "__none__" : field.value}
                        onValueChange={(v) => field.onChange(v === "__none__" ? "" : v)}
                      >
                        <FormControl>
                          <SelectTrigger className="h-10 w-full">
                            <SelectValue placeholder="Select state" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-72">
                          <SelectItem value="__none__">Not specified</SelectItem>
                          {INDIAN_STATES.map((state) => (
                            <SelectItem key={state} value={state}>
                              {state}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="postalCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Postal code</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 302017" className="h-10" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <h3 className="text-[13px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Registry
              </h3>
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Internal notes</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Scope of work, rate contract references, coordination notes…"
                        className="min-h-[88px] resize-y"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between rounded-lg border p-4">
                      <div className="space-y-0.5">
                        <Label htmlFor="firm-status" className="text-sm font-medium">
                          Active firm
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Inactive firms stay in the registry but are flagged as dormant.
                        </p>
                      </div>
                      <FormControl>
                        <Switch
                          id="firm-status"
                          checked={field.value === "ACTIVE"}
                          onCheckedChange={(checked) => field.onChange(checked ? "ACTIVE" : "INACTIVE")}
                        />
                      </FormControl>
                    </div>
                  </FormItem>
                )}
              />
            </section>

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Saving…
                  </>
                ) : firm ? (
                  "Save changes"
                ) : (
                  "Register firm"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** Local structural mirror of the server payload type (avoids server import). */
interface DashboardStatsLike {
  total: number;
  active: number;
  inactive: number;
  addedLast30Days: number;
}
