import Image from "next/image";
import { cn } from "@/lib/utils";
import { BRAND } from "@/lib/constants";

/**
 * Renders the official Niyojan Corporation logo. The artwork is used as
 * supplied (never recreated or distorted); the PNG carries a white plate, so
 * it is always placed on white/light surfaces.
 */

export function LogoLockup({ className, priority = false }: { className?: string; priority?: boolean }) {
  return (
    <Image
      src="/brand/logo-full.png"
      alt={`${BRAND.name} logo`}
      width={1000}
      height={324}
      priority={priority}
      className={cn("h-auto w-auto", className)}
    />
  );
}

export function LogoMark({ className, size = 36 }: { className?: string; size?: number }) {
  return (
    <Image
      src="/brand/logo-mark.png"
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0 rounded-[3px]", className)}
      style={{ width: size, height: size }}
    />
  );
}

/** Wordmark for contexts where the raster logo is too wide (mobile headers). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("leading-none", className)}>
      <span className="block font-semibold tracking-tight text-navy">Niyojan</span>
      <span className="mt-[3px] block text-[9px] font-medium uppercase tracking-[0.28em] text-muted-foreground">
        Corporation
      </span>
    </span>
  );
}
