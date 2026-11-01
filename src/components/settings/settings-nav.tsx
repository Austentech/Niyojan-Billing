"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Building2, UserCog } from "lucide-react";

import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/settings/account", label: "Account Settings", icon: UserCog },
  { href: "/settings/firms", label: "Firm Management", icon: Building2 },
] as const;

/**
 * Settings section navigation — desktop sidebar / mobile horizontal tabs,
 * with the active page derived from the current route.
 */
export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings" className="md:shrink-0">
      {/* Desktop: vertical sidebar list */}
      <ul className="hidden gap-1 md:flex md:flex-col">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md border px-3.5 py-2.5 text-[13.5px] font-medium transition-colors",
                  active
                    ? "border-gold/40 bg-accent text-foreground"
                    : "border-transparent bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4", active ? "text-gold" : "text-muted-foreground")} aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>

      {/* Mobile: horizontal tab strip */}
      <ul className="flex gap-1.5 overflow-x-auto md:hidden">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-2 text-[13px] font-medium transition-colors",
                  active
                    ? "border-gold/40 bg-accent text-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className={cn("size-3.5", active ? "text-gold" : "text-muted-foreground")} aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
