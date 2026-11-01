"use client";

import Link from "next/link";

import { Building2, ChevronDown, LogOut, Settings } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logoutAction } from "@/server/actions/auth-actions";
import { initials } from "@/lib/format";

/**
 * Administrator profile menu — identity from the authenticated account
 * configuration (never a hardcoded UI string), settings navigation and the
 * logout action (server-side session revocation + CSRF token).
 */
export function ProfileMenu({
  displayName,
  email,
  csrfToken,
}: {
  displayName: string;
  email: string;
  csrfToken: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-9 items-center gap-2 rounded-md border bg-card px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 data-[state=open]:bg-secondary"
        aria-label={`Account menu for ${displayName}`}
      >
        <Avatar className="size-6">
          <AvatarFallback className="bg-primary text-[11px] font-semibold uppercase text-primary-foreground">
            {initials(displayName)}
          </AvatarFallback>
        </Avatar>
        <span className="hidden max-w-[160px] truncate md:inline">{displayName}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="min-w-0 py-2.5">
          <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
          <p className="mt-0.5 truncate text-xs font-normal text-muted-foreground">{email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/settings/account" className="cursor-pointer">
            <Settings className="size-4" aria-hidden="true" />
            Account settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/firms" className="cursor-pointer">
            <Building2 className="size-4" aria-hidden="true" />
            Firm management
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <form action={logoutAction}>
          <input type="hidden" name="csrf" value={csrfToken} />
          <DropdownMenuItem asChild>
            <button
              type="submit"
              className="w-full cursor-pointer text-destructive focus:text-destructive"
            >
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
