"use client";

import { ExternalLink, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { FirmLogo } from "@/components/firms/firm-logo";
import type { FirmView } from "@/lib/firms/types";

/**
 * Business card for one registered firm (dashboard grid).
 *
 *   * All content comes from the database row passed in — nothing is
 *     hardcoded in frontend code.
 *   * The website link opens in a new tab with rel="noopener noreferrer"
 *     (target=_blank hardening).
 *   * The holding percentage is visually distinguished with a restrained
 *     gold-accented badge.
 *   * FUTURE NAVIGATION: the card is interactive and carries the firm's
 *     stable UUID; the dedicated per-firm dashboard route attaches here in
 *     its own phase. Until then, clicking informs the administrator instead
 *     of pretending to navigate.
 */
export function FirmCard({ firm }: { firm: FirmView }) {
  const workspaceNotice = () => {
    toast.info("Dedicated firm dashboards arrive in an upcoming phase.", {
      description: "This firm is registered and ready — modules attach to it in later phases.",
    });
  };

  let websiteHost: string | null = null;
  if (firm.websiteUrl) {
    try {
      websiteHost = new URL(firm.websiteUrl).hostname.replace(/^www\./, "");
    } catch {
      websiteHost = null;
    }
  }

  return (
    <article className="flex h-full flex-col rounded-lg border bg-card transition-colors hover:border-gold/50">
      {/* Clickable card body — designed for future navigation to the firm's
          dedicated dashboard (firm.id is the stable attachment key). */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open the workspace for ${firm.name}`}
        onClick={workspaceNotice}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            workspaceNotice();
          }
        }}
        className="cursor-pointer flex-1 p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <div className="flex items-start gap-3.5">
          <FirmLogo name={firm.name} logoUrl={firm.logoUrl} size={48} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold leading-tight text-foreground" title={firm.name}>
              {firm.name}
            </h3>
            {websiteHost ? (
              <a
                href={firm.websiteUrl ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="mt-1 inline-flex max-w-full items-center gap-1 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-[3px]"
                title={firm.websiteUrl ?? undefined}
              >
                <span className="truncate">{websiteHost}</span>
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
              </a>
            ) : (
              <p className="mt-1 text-[12.5px] text-muted-foreground/70">No website on record</p>
            )}
          </div>
        </div>

        <p className="mt-4 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground" title={firm.address}>
          {firm.address}
        </p>
      </div>

      {/* Professional action area */}
      <div className="mt-auto flex items-center justify-between gap-3 border-t px-5 py-3.5">
        <span
          className="tnum inline-flex items-center rounded-md border border-gold/30 bg-accent px-2.5 py-1 text-[12px] font-semibold text-foreground"
          title="Niyojan Corporation holding percentage"
        >
          {firm.holdingPercentage.toFixed(2)}%
          <span className="ml-1 font-medium text-muted-foreground">holding</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2.5 text-[12.5px] text-muted-foreground hover:text-foreground"
          onClick={workspaceNotice}
          title="Dedicated firm dashboards arrive in an upcoming phase"
        >
          Workspace
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </article>
  );
}
