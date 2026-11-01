"use client";

import { ArrowLeft, Building2, Mail, MapPin, Pencil, Phone, StickyNote, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { EmptyState, FieldRow, PageHeader } from "@/components/common/ui-blocks";
import { formatDateTime, relativeTime } from "@/lib/format";
import type { FirmDto } from "@/types/app";

/**
 * Read-only firm profile with identity, contact, address, notes and audit
 * metadata. Editing is delegated to the shared firm form dialog.
 */
export function FirmDetailView({
  firm,
  onBack,
  onEdit,
  onToggleStatus,
  onDelete,
  busy,
}: {
  firm: FirmDto | null;
  onBack: () => void;
  onEdit: (firm: FirmDto) => void;
  onToggleStatus: (firm: FirmDto) => void;
  onDelete: (firm: FirmDto) => void;
  busy?: boolean;
}) {
  if (!firm) {
    return (
      <EmptyState
        icon={Building2}
        title="Firm not found"
        description="This firm is no longer in the registry. It may have been removed."
        action={
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to registry
          </Button>
        }
      />
    );
  }

  const inactive = firm.status === "INACTIVE";
  const location = [firm.city, firm.state, firm.postalCode].filter(Boolean).join(", ");

  return (
    <div className="space-y-6">
      <PageHeader
        title={firm.name}
        description={firm.legalName ?? "No registered legal name recorded."}
        actions={
          <>
            <Button variant="outline" onClick={onBack} className="hidden sm:inline-flex">
              <ArrowLeft className="size-4" aria-hidden="true" />
              Registry
            </Button>
            <Button variant="outline" onClick={() => onToggleStatus(firm)} disabled={busy}>
              {inactive ? "Reactivate" : "Deactivate"}
            </Button>
            <Button onClick={() => onEdit(firm)}>
              <Pencil className="size-4" aria-hidden="true" />
              Edit
            </Button>
          </>
        }
      />

      <button
        type="button"
        onClick={onBack}
        className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to registry
      </button>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,58%)_minmax(0,42%)] lg:gap-6">
        {/* Identity & contact */}
        <section className="rounded-lg border bg-card">
          <div className="flex items-start gap-4 border-b p-5">
            <div className={"flex size-11 shrink-0 items-center justify-center rounded-md " + (inactive ? "bg-muted" : "bg-secondary")}>
              <Building2 className={"size-5 " + (inactive ? "text-muted-foreground" : "text-navy")} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold leading-snug tracking-tight">{firm.name}</h2>
              {firm.legalName ? (
                <p className="mt-0.5 text-sm text-muted-foreground">{firm.legalName}</p>
              ) : null}
            </div>
            <Badge
              variant="outline"
              className={
                inactive
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }
            >
              <span
                className={"mr-1 size-1.5 rounded-full " + (inactive ? "bg-muted-foreground/60" : "bg-emerald-500")}
                aria-hidden="true"
              />
              {inactive ? "Inactive" : "Active"}
            </Badge>
          </div>

          <dl className="p-5">
            {firm.gstin ? (
              <FieldRow label="GSTIN">
                <span className="tnum font-mono text-[13px]">{firm.gstin}</span>
              </FieldRow>
            ) : null}
            <FieldRow label="Contact person">
              <span className="inline-flex items-center gap-2">
                <User className="size-3.5 text-muted-foreground" aria-hidden="true" />
                {firm.contactPerson ?? "—"}
              </span>
            </FieldRow>
            <FieldRow label="Email">
              {firm.email ? (
                <a
                  href={`mailto:${firm.email}`}
                  className="inline-flex items-center gap-2 text-navy underline-offset-4 hover:underline"
                >
                  <Mail className="size-3.5" aria-hidden="true" />
                  {firm.email}
                </a>
              ) : (
                "—"
              )}
            </FieldRow>
            <FieldRow label="Phone">
              {firm.phone ? (
                <a
                  href={`tel:${firm.phone.replace(/[^+0-9]/g, "")}`}
                  className="tnum inline-flex items-center gap-2 text-navy underline-offset-4 hover:underline"
                >
                  <Phone className="size-3.5" aria-hidden="true" />
                  {firm.phone}
                </a>
              ) : (
                "—"
              )}
            </FieldRow>
            <FieldRow label="Address">
              <span className="inline-flex items-start gap-2">
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span>
                  {firm.addressLine1 ? <span className="block">{firm.addressLine1}</span> : null}
                  {location ? <span className="block text-muted-foreground">{location}</span> : null}
                  {!firm.addressLine1 && !location ? "—" : null}
                </span>
              </span>
            </FieldRow>
          </dl>
        </section>

        {/* Notes & audit */}
        <section className="space-y-4">
          <div className="rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b p-5">
              <StickyNote className="size-4 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Internal notes</h2>
            </div>
            <div className="p-5">
              {firm.notes ? (
                <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">{firm.notes}</p>
              ) : (
                <p className="text-sm text-muted-foreground">No notes recorded for this firm.</p>
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card">
            <h2 className="border-b p-5 text-sm font-semibold">Registry record</h2>
            <dl className="p-5">
              <FieldRow label="Registered">
                <span title={formatDateTime(firm.createdAt)}>
                  {formatDateTime(firm.createdAt)}
                  <span className="ml-2 text-xs text-muted-foreground">({relativeTime(firm.createdAt)})</span>
                </span>
              </FieldRow>
              <FieldRow label="Last updated">
                <span title={formatDateTime(firm.updatedAt)}>
                  {formatDateTime(firm.updatedAt)}
                  <span className="ml-2 text-xs text-muted-foreground">({relativeTime(firm.updatedAt)})</span>
                </span>
              </FieldRow>
              <FieldRow label="Firm ID">
                <span className="font-mono text-xs text-muted-foreground">{firm.id}</span>
              </FieldRow>
            </dl>
          </div>

          <div className="rounded-lg border border-destructive/25 bg-card p-5">
            <p className="text-sm font-medium">Danger zone</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              Deleting removes the firm permanently. Deactivation keeps the record for future phases
              (billing, GST, accounting).
            </p>
            <Button variant="destructive" size="sm" className="mt-3" onClick={() => onDelete(firm)}>
              Delete this firm
            </Button>
          </div>
        </section>
      </div>

      <Separator className="hidden" />
    </div>
  );
}
