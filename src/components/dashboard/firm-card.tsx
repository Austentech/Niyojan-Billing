"use client";

import { Building2, Mail, MapPin, MoreHorizontal, Phone, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDate, relativeTime } from "@/lib/format";
import type { FirmDto } from "@/types/app";

function FirmIcon({ inactive }: { inactive: boolean }) {
  return (
    <div
      className={
        "flex size-9 shrink-0 items-center justify-center rounded-md " +
        (inactive ? "bg-muted" : "bg-secondary")
      }
    >
      <Building2 className={"size-[18px] " + (inactive ? "text-muted-foreground" : "text-navy")} aria-hidden="true" />
    </div>
  );
}

/**
 * Firm summary card used by the dashboard and the firms registry.
 * Layout-agnostic: the parent grid controls columns (1 / 2 / 4).
 */
export function FirmCard({
  firm,
  onOpen,
  onEdit,
  onToggleStatus,
  onDelete,
  busy,
}: {
  firm: FirmDto;
  onOpen: (firm: FirmDto) => void;
  onEdit: (firm: FirmDto) => void;
  onToggleStatus: (firm: FirmDto) => void;
  onDelete: (firm: FirmDto) => void;
  busy?: boolean;
}) {
  const inactive = firm.status === "INACTIVE";
  const location = [firm.city, firm.state].filter(Boolean).join(", ");

  return (
    <article
      className={
        "group flex flex-col rounded-lg border bg-card transition-[border-color,box-shadow] " +
        (busy ? "opacity-60" : "hover:border-input hover:shadow-[0_1px_3px_rgba(27,39,55,0.08)]")
      }
      aria-busy={busy || undefined}
    >
      <header className="flex items-start gap-3 border-b p-4 sm:p-5">
        <FirmIcon inactive={inactive} />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onOpen(firm)}
            className="block max-w-full cursor-pointer truncate text-left text-[15px] font-semibold leading-snug tracking-tight text-foreground transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            {firm.name}
          </button>
          {firm.legalName ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={firm.legalName}>
              {firm.legalName}
            </p>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground data-[state=open]:bg-secondary"
              aria-label={`Actions for ${firm.name}`}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs">{firm.name}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onOpen(firm)}>View details</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEdit(firm)}>Edit information</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onToggleStatus(firm)} disabled={busy}>
              {inactive ? "Reactivate" : "Deactivate"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(firm)}
              className="text-destructive focus:text-destructive"
            >
              Delete firm
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <dl className="flex-1 space-y-2.5 p-4 text-sm sm:p-5">
        {firm.contactPerson ? (
          <div className="flex items-center gap-2.5">
            <User className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <dd className="truncate text-foreground">{firm.contactPerson}</dd>
          </div>
        ) : null}
        {firm.email ? (
          <div className="flex items-center gap-2.5">
            <Mail className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <dd className="truncate text-muted-foreground" title={firm.email}>
              {firm.email}
            </dd>
          </div>
        ) : null}
        {firm.phone ? (
          <div className="flex items-center gap-2.5">
            <Phone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <dd className="tnum truncate text-muted-foreground">{firm.phone}</dd>
          </div>
        ) : null}
        {location ? (
          <div className="flex items-center gap-2.5">
            <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <dd className="truncate text-muted-foreground">{location}</dd>
          </div>
        ) : null}
        {firm.gstin ? (
          <div className="flex items-center gap-2.5">
            <span className="w-[14px] shrink-0 text-center text-[10px] font-semibold tracking-wider text-muted-foreground" aria-hidden="true">
              GST
            </span>
            <dd className="tnum truncate font-mono text-xs text-muted-foreground">{firm.gstin}</dd>
          </div>
        ) : null}
        {!firm.contactPerson && !firm.email && !firm.phone && !location && !firm.gstin ? (
          <p className="text-sm text-muted-foreground">No contact details recorded yet.</p>
        ) : null}
      </dl>

      <footer className="flex items-center justify-between gap-2 border-t p-4 sm:p-5">
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
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground" title={`Registered ${formatDate(firm.createdAt)}`}>
            Added {relativeTime(firm.createdAt)}
          </span>
          <button
            type="button"
            onClick={() => onOpen(firm)}
            className="cursor-pointer text-[13px] font-medium text-navy underline-offset-4 transition-colors hover:text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            View
          </button>
        </div>
      </footer>
    </article>
  );
}
