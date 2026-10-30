"use client";

import { Building2, LayoutDashboard, Lock, Settings, LogOut, Loader2 } from "lucide-react";

import { LogoMark } from "@/components/brand/brand-logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";
import { BRAND, FUTURE_MODULES } from "@/lib/constants";
import type { AdminUserDto, AppView } from "@/types/app";

export interface NavItem {
  key: string;
  label: string;
  icon: typeof LayoutDashboard;
  view: AppView;
  isActive: (view: AppView) => boolean;
}

export const NAV_ITEMS: NavItem[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    view: { type: "dashboard" },
    isActive: (v) => v.type === "dashboard",
  },
  {
    key: "firms",
    label: "Firms",
    icon: Building2,
    view: { type: "firms" },
    isActive: (v) => v.type === "firms" || v.type === "firm-detail",
  },
  {
    key: "settings",
    label: "Account Settings",
    icon: Settings,
    view: { type: "settings" },
    isActive: (v) => v.type === "settings",
  },
];

/**
 * Navigation content shared by the desktop sidebar and the mobile drawer.
 */
export function AppNav({
  view,
  onNavigate,
  user,
  onSignOut,
  signingOut,
}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
  user: AdminUserDto;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex items-center gap-3 px-4 py-5 lg:px-5">
        <LogoMark size={38} />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold leading-tight tracking-tight text-navy">
            {BRAND.shortName}
          </p>
          <p className="mt-0.5 text-[9px] font-medium uppercase tracking-[0.26em] text-muted-foreground">
            Corporation
          </p>
        </div>
      </div>

      <Separator />

      {/* Primary navigation */}
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4 scrollbar-thin">
        <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Management
        </p>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = item.isActive(view);
            return (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => onNavigate(item.view)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  <item.icon className={cn("size-[18px] shrink-0", active && "text-navy")} aria-hidden="true" />
                  {item.label}
                  {active ? <span className="ml-auto h-4 w-[3px] rounded-full bg-gold" aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>

        <p className="px-2 pb-2 pt-6 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Planned Modules
        </p>
        <ul className="space-y-1">
          {FUTURE_MODULES.map((module) => (
            <li key={module.label}>
              <div
                className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm text-muted-foreground/70"
                aria-disabled="true"
                title={`Scheduled for ${module.hint}`}
              >
                <Lock className="size-[18px] shrink-0" aria-hidden="true" />
                <span className="truncate">{module.label}</span>
                <span className="ml-auto rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
                  {module.hint}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </nav>

      {/* Account block */}
      <div className="border-t bg-card p-3 lg:p-4">
        <div className="flex items-center gap-3">
          <Avatar className="size-9 border">
            <AvatarFallback className="bg-navy text-xs font-semibold text-white">
              {initials(user.name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium leading-tight text-foreground">{user.name}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{user.email}</p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full"
          onClick={onSignOut}
          disabled={signingOut}
        >
          {signingOut ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="size-3.5" aria-hidden="true" />
          )}
          Sign out
        </Button>
      </div>
    </div>
  );
}
