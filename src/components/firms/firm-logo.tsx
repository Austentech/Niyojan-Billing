import Image from "next/image";

import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";

/**
 * Firm logo tile — the firm's uploaded logo (database-driven URL) or a
 * professional fallback built from the firm's initials.
 */
export function FirmLogo({
  name,
  logoUrl,
  size = 48,
  className,
}: {
  name: string;
  logoUrl: string | null;
  size?: number;
  className?: string;
}) {
  if (logoUrl) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-md border bg-secondary/60",
          className,
        )}
        style={{ width: size, height: size }}
      >
        <Image
          src={logoUrl}
          alt={`${name} logo`}
          width={size}
          height={size}
          sizes={`${size}px`}
          className="h-full w-full object-contain"
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-primary font-semibold uppercase text-primary-foreground",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
    >
      {initials(name)}
    </span>
  );
}
