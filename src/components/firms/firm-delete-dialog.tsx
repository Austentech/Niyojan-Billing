"use client";

import { useEffect, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteFirmAction } from "@/server/actions/firm-actions";
import type { FirmDto } from "@/types/app";

/**
 * Destructive-action confirmation. The firm name must be typed exactly to
 * enable deletion — deactivation is always offered as the reversible option.
 */
export function FirmDeleteDialog({
  open,
  onOpenChange,
  firm,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  firm: FirmDto | null;
  onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setConfirmation("");
      setError(null);
    }
  }, [open]);

  if (!firm) return null;
  const matches = confirmation.trim() === firm.name.trim();

  async function onDelete() {
    if (!firm) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await deleteFirmAction(firm.id);
      if (result.ok) {
        toast.success(result.message ?? "Firm deleted.");
        onDeleted();
        onOpenChange(false);
      } else {
        setError(result.message);
      }
    } catch {
      setError("The request failed due to a network or server error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-destructive" aria-hidden="true" />
            Delete “{firm.name}”?
          </DialogTitle>
          <DialogDescription>
            This permanently removes the firm from the registry. Consider deactivating instead — inactive
            firms keep their record for future phases (billing, GST, accounting).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="firm-delete-confirm">
            Type the firm name <span className="font-semibold text-foreground">{firm.name}</span> to confirm
          </Label>
          <Input
            id="firm-delete-confirm"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder={firm.name}
            autoComplete="off"
            className="h-10"
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches && !submitting) {
                e.preventDefault();
                void onDelete();
              }
            }}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onDelete} disabled={!matches || submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Deleting…
              </>
            ) : (
              "Delete permanently"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
