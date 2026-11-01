"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Building2, Plus, Search, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, PageHeader } from "@/components/common/ui-blocks";
import { FirmCard } from "@/components/dashboard/firm-card";
import { cn } from "@/lib/utils";
import type { FirmDto, FirmStatus } from "@/types/app";

type StatusFilter = "ALL" | FirmStatus;
type SortKey = "name-asc" | "name-desc" | "recent" | "oldest";

const FILTER_LABELS: Record<StatusFilter, string> = {
  ALL: "All firms",
  ACTIVE: "Active only",
  INACTIVE: "Inactive only",
};

/**
 * Firm registry — searchable, filterable, sortable listing with the
 * responsive 1 / 2 / 4 column card grid.
 */
export function FirmsView({
  firms,
  busyFirmId,
  onOpenFirm,
  onEditFirm,
  onToggleStatus,
  onDeleteFirm,
  onAddFirm,
}: {
  firms: FirmDto[];
  busyFirmId: string | null;
  onOpenFirm: (firm: FirmDto) => void;
  onEditFirm: (firm: FirmDto) => void;
  onToggleStatus: (firm: FirmDto) => void;
  onDeleteFirm: (firm: FirmDto) => void;
  onAddFirm: () => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("name-asc");
  const deferredQuery = useDeferredValue(query);

  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const filtered = firms.filter((firm) => {
      if (statusFilter !== "ALL" && firm.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [
        firm.name,
        firm.legalName,
        firm.contactPerson,
        firm.email,
        firm.phone,
        firm.city,
        firm.state,
        firm.gstin,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });

    const sorted = [...filtered];
    switch (sortKey) {
      case "name-asc":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-desc":
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "recent":
        sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        break;
      case "oldest":
        sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        break;
    }
    return sorted;
  }, [firms, deferredQuery, statusFilter, sortKey]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Firm Registry"
        description={`${firms.length} registered firm${firms.length === 1 ? "" : "s"} under centralized management.`}
        actions={
          <Button onClick={onAddFirm} className="hidden sm:inline-flex">
            <Plus className="size-4" aria-hidden="true" />
            Register firm
          </Button>
        }
      />

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, contact, city, GSTIN…"
            aria-label="Search firms"
            className="h-10 bg-card pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="h-10 w-full bg-card sm:w-[150px]" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FILTER_LABELS) as StatusFilter[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {FILTER_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
            <SelectTrigger className="h-10 w-full bg-card sm:w-[150px]" aria-label="Sort firms">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name-asc">Name A–Z</SelectItem>
              <SelectItem value="name-desc">Name Z–A</SelectItem>
              <SelectItem value="recent">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={onAddFirm} className="sm:hidden" size="icon" aria-label="Register firm">
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Grid: 1 col mobile · 2 cols tablet · 4 cols desktop */}
      {visible.length > 0 ? (
        <div
          className={cn(
            "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4",
            "transition-opacity",
          )}
          aria-live="polite"
        >
          {visible.map((firm) => (
            <FirmCard
              key={firm.id}
              firm={firm}
              busy={busyFirmId === firm.id}
              onOpen={onOpenFirm}
              onEdit={onEditFirm}
              onToggleStatus={onToggleStatus}
              onDelete={onDeleteFirm}
            />
          ))}
        </div>
      ) : firms.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No firms registered yet"
          description="Register the first business firm to bring it under centralized Niyojan Corporation management."
          action={
            <Button onClick={onAddFirm}>
              <Plus className="size-4" aria-hidden="true" />
              Register your first firm
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={SearchX}
          title="No matching firms"
          description="No registered firm matches the current search or filter. Try adjusting the query."
          action={
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setStatusFilter("ALL");
              }}
            >
              Clear search &amp; filters
            </Button>
          }
        />
      )}
    </div>
  );
}
