import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/** Standard page heading with description and action slot. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-[22px]">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Empty / zero-result state block. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed bg-card px-6 py-14 text-center",
        className,
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-md bg-secondary">
        <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="mt-4 text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** Dashboard statistic tile. */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number | string;
  hint?: string;
  icon: LucideIcon;
  tone?: "default" | "gold" | "muted";
}) {
  return (
    <div className="rounded-lg border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md",
            tone === "gold" ? "bg-accent" : tone === "muted" ? "bg-muted" : "bg-secondary",
          )}
        >
          <Icon
            className={cn("size-4", tone === "gold" ? "text-gold" : "text-muted-foreground")}
            aria-hidden="true"
          />
        </div>
      </div>
      <p className="tnum mt-3 text-[28px] font-semibold leading-none tracking-tight text-foreground">{value}</p>
      {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Small labelled data row used in detail views. */
export function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-1 border-b py-3 last:border-b-0 sm:grid-cols-[170px_1fr]">
      <dt className="text-[13px] font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}
