import { ExternalLink } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { FirmLogo } from "@/components/firms/firm-logo";
import { formatDate } from "@/lib/format";
import type { FirmView } from "@/lib/firms/types";

/**
 * Firm Management — the existing-firms list.
 *
 * Every row renders from the database: logo (with professional initials
 * fallback), firm name, website link (new tab + security attributes),
 * holding percentage, short address and the registration date.
 */
export function FirmList({ firms }: { firms: FirmView[] }) {
  return (
    <Card className="mt-6">
      <CardContent className="divide-y p-0">
        {firms.map((firm) => {
          let websiteHost: string | null = null;
          if (firm.websiteUrl) {
            try {
              websiteHost = new URL(firm.websiteUrl).hostname.replace(/^www\./, "");
            } catch {
              websiteHost = null;
            }
          }

          return (
            <div key={firm.id} className="flex items-center gap-4 px-4 py-4 sm:px-5">
              <FirmLogo name={firm.name} logoUrl={firm.logoUrl} size={44} />

              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-foreground" title={firm.name}>
                  {firm.name}
                </p>
                <div className="mt-0.5 flex min-w-0 items-center gap-x-2 text-[12.5px] text-muted-foreground">
                  {websiteHost ? (
                    <a
                      href={firm.websiteUrl ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex max-w-[45%] shrink-0 items-center gap-1 truncate underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-[3px]"
                      title={firm.websiteUrl ?? undefined}
                    >
                      <span className="truncate">{websiteHost}</span>
                      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="shrink-0 text-muted-foreground/70">No website</span>
                  )}
                  {websiteHost ? <span aria-hidden="true">·</span> : null}
                  <span className="truncate" title={firm.address}>
                    {firm.address}
                  </span>
                </div>
              </div>

              <span
                className="tnum hidden shrink-0 rounded-md border border-gold/30 bg-accent px-2.5 py-1 text-[12px] font-semibold text-foreground sm:inline-flex"
                title="Niyojan Corporation holding percentage"
              >
                {firm.holdingPercentage.toFixed(2)}%
              </span>

              <span className="tnum hidden w-24 shrink-0 text-right text-[12px] text-muted-foreground lg:block">
                Added {formatDate(firm.createdAt)}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
