"use client";

import { useEffect } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Centralized render-error boundary for the application route. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] render error:", error.message);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-md bg-secondary">
          <TriangleAlert className="size-5 text-navy" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-lg font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          The system hit an unexpected error while rendering this view. Your data is safe — try loading the
          application again.
        </p>
        <Button onClick={reset} className="mt-6">
          <RotateCcw className="size-4" aria-hidden="true" />
          Reload application
        </Button>
      </div>
    </div>
  );
}
