import Link from "next/link";

import { Building2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/ui-blocks";
import { FirmCard } from "@/components/firms/firm-card";
import type { FirmView } from "@/lib/firms/types";

/**
 * The dashboard firm collection — a fully database-driven responsive grid:
 *
 *   * Mobile            → 1 card per row
 *   * Tablet  (md ≥768) → 2 cards per row
 *   * Desktop (xl ≥1280)→ 4 cards per row
 *
 * Rows continue automatically as more firms are registered — the grid never
 * needs a frontend change for new firms.
 */
export function FirmsGrid({ firms }: { firms: FirmView[] }) {
  if (firms.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No firms added yet."
        description="Start building your centralized business workspace by adding your first firm."
        action={
          <Button asChild>
            <Link href="/settings/firms?new=1">
              <Plus className="size-4" aria-hidden="true" />
              Add Your First Firm
            </Link>
          </Button>
        }
        className="mt-6"
      />
    );
  }

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {firms.map((firm) => (
        <FirmCard key={firm.id} firm={firm} />
      ))}
    </div>
  );
}
