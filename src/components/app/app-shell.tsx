"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, Settings, LogOut } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AppNav } from "@/components/app/app-nav";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { FirmsView } from "@/components/firms/firms-view";
import { FirmDetailView } from "@/components/firms/firm-detail-view";
import { FirmFormDialog } from "@/components/firms/firm-form-dialog";
import { FirmDeleteDialog } from "@/components/firms/firm-delete-dialog";
import { SettingsView } from "@/components/settings/settings-view";
import { logoutAction } from "@/server/actions/auth-actions";
import { getFirmsAction, setFirmStatusAction } from "@/server/actions/firm-actions";
import { initials } from "@/lib/format";
import { BRAND } from "@/lib/constants";
import type { AdminUserDto, AppView, DashboardStats, FirmDto } from "@/types/app";

/**
 * Authenticated application shell: navigation, header, and client-side view
 * routing across dashboard, firm registry, firm detail and settings.
 */
export function AppShell({
  user: initialUser,
  firms: initialFirms,
  stats: initialStats,
  smtpConfigured,
}: {
  user: AdminUserDto;
  firms: FirmDto[];
  stats: DashboardStats;
  smtpConfigured: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState<AppView>({ type: "dashboard" });
  const [user, setUser] = useState(initialUser);
  const [firms, setFirms] = useState(initialFirms);
  const [stats, setStats] = useState(initialStats);
  const [busyFirmId, setBusyFirmId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [formDialog, setFormDialog] = useState<{ open: boolean; firm: FirmDto | null }>({
    open: false,
    firm: null,
  });
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; firm: FirmDto | null }>({
    open: false,
    firm: null,
  });

  useEffect(() => {
    setUser(initialUser);
    setFirms(initialFirms);
    setStats(initialStats);
  }, [initialUser, initialFirms, initialStats]);

  const navigate = useCallback((next: AppView) => {
    setView(next);
    setMobileNavOpen(false);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  const activeFirm = useMemo(
    () => (view.type === "firm-detail" ? firms.find((f) => f.id === view.firmId) ?? null : null),
    [view, firms],
  );

  const headerTitle =
    view.type === "dashboard"
      ? "Dashboard"
      : view.type === "firms"
        ? "Firm Registry"
        : view.type === "firm-detail"
          ? (activeFirm?.name ?? "Firm details")
          : "Account Settings";

  /* ------------------------------ handlers ------------------------------ */

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const result = await logoutAction();
      toast.success(result.message ?? "Signed out.");
      router.refresh();
    } catch {
      toast.error("Sign out failed. Please try again.");
      setSigningOut(false);
    }
  }

  async function handleToggleStatus(firm: FirmDto) {
    const nextStatus = firm.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setBusyFirmId(firm.id);
    try {
      const result = await setFirmStatusAction(firm.id, nextStatus);
      if (result.ok && result.data) {
        toast.success(result.message ?? "Status updated.");
        setFirms(result.data.firms);
        setStats(result.data.stats);
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("The request failed. Please retry.");
    } finally {
      setBusyFirmId(null);
    }
  }

  function handleFirmSaved(payload: { firms: FirmDto[]; stats: DashboardStats }) {
    setFirms(payload.firms);
    setStats(payload.stats);
  }

  function handleFirmDeleted() {
    setView((current) =>
      current.type === "firm-detail" && deleteDialog.firm && current.firmId === deleteDialog.firm.id
        ? { type: "firms" }
        : current,
    );
    // Registry data refresh is handled by the delete dialog's caller payload.
    void getFirmsAction()
      .then((result) => {
        if (result.ok && result.data) {
          setFirms(result.data.firms);
          setStats(result.data.stats);
        }
      })
      .catch(() => undefined);
  }

  /* ------------------------------- render -------------------------------- */

  const navProps = {
    view,
    onNavigate: navigate,
    user,
    onSignOut: handleSignOut,
    signingOut,
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[260px] border-r bg-card lg:block">
        <AppNav {...navProps} />
      </aside>

      {/* Mobile navigation drawer */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          className="w-[280px] border-r bg-card p-0 [&>button]:hidden"
          aria-describedby={undefined}
        >
          <SheetTitle className="sr-only">Application navigation</SheetTitle>
          <AppNav {...navProps} />
        </SheetContent>
      </Sheet>

      <div className="flex min-h-screen flex-col lg:pl-[260px]">
        {/* Header */}
        <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/90">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:h-[60px] lg:px-8">
            <Button
              variant="ghost"
              size="icon"
              className="size-9 lg:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
            >
              <Menu className="size-5" aria-hidden="true" />
            </Button>

            <div className="flex min-w-0 items-baseline gap-2 lg:hidden">
              <span className="text-[15px] font-semibold tracking-tight text-navy">Niyojan</span>
              <span className="text-[8px] font-medium uppercase tracking-[0.3em] text-gold">Corporation</span>
            </div>

            <h1 className="hidden truncate text-[15px] font-semibold tracking-tight lg:block">{headerTitle}</h1>

            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-[11px] font-medium tracking-wide text-muted-foreground md:inline">
                {BRAND.tagline}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex cursor-pointer items-center gap-2 rounded-md p-1 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    aria-label="Account menu"
                  >
                    <Avatar className="size-8 border">
                      <AvatarFallback className="bg-navy text-[11px] font-semibold text-white">
                        {initials(user.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="hidden max-w-[160px] truncate text-[13px] font-medium sm:inline">
                      {user.name}
                    </span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="font-normal">
                    <p className="text-sm font-medium text-foreground">{user.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate({ type: "settings" })}>
                    <Settings className="size-4" aria-hidden="true" />
                    Account settings
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleSignOut} disabled={signingOut}>
                    <LogOut className="size-4" aria-hidden="true" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8" id="main">
          <div className="mx-auto w-full max-w-[1440px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={view.type + (view.type === "firm-detail" ? view.firmId : "")}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
              >
                {view.type === "dashboard" ? (
                  <DashboardView
                    user={user}
                    firms={firms}
                    stats={stats}
                    busyFirmId={busyFirmId}
                    onOpenFirm={(firm) => navigate({ type: "firm-detail", firmId: firm.id })}
                    onEditFirm={(firm) => setFormDialog({ open: true, firm })}
                    onToggleStatus={handleToggleStatus}
                    onDeleteFirm={(firm) => setDeleteDialog({ open: true, firm })}
                    onAddFirm={() => setFormDialog({ open: true, firm: null })}
                    onGoToFirms={() => navigate({ type: "firms" })}
                    onGoToSettings={() => navigate({ type: "settings" })}
                  />
                ) : view.type === "firms" ? (
                  <FirmsView
                    firms={firms}
                    busyFirmId={busyFirmId}
                    onOpenFirm={(firm) => navigate({ type: "firm-detail", firmId: firm.id })}
                    onEditFirm={(firm) => setFormDialog({ open: true, firm })}
                    onToggleStatus={handleToggleStatus}
                    onDeleteFirm={(firm) => setDeleteDialog({ open: true, firm })}
                    onAddFirm={() => setFormDialog({ open: true, firm: null })}
                  />
                ) : view.type === "firm-detail" ? (
                  <FirmDetailView
                    firm={activeFirm}
                    busy={busyFirmId === view.firmId}
                    onBack={() => navigate({ type: "firms" })}
                    onEdit={(firm) => setFormDialog({ open: true, firm })}
                    onToggleStatus={handleToggleStatus}
                    onDelete={(firm) => setDeleteDialog({ open: true, firm })}
                  />
                ) : (
                  <SettingsView
                    user={user}
                    smtpConfigured={smtpConfigured}
                    onUserUpdated={(updated) => setUser((prev) => ({ ...prev, ...updated }))}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>

        {/* Footer */}
        <footer className="border-t bg-card px-4 py-3 sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-1 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>© {new Date().getFullYear()} {BRAND.name}. All rights reserved.</span>
            <span>{BRAND.tagline}</span>
          </div>
        </footer>
      </div>

      {/* Firm create / edit dialog */}
      <FirmFormDialog
        open={formDialog.open}
        onOpenChange={(open) => setFormDialog((s) => ({ ...s, open }))}
        firm={formDialog.firm}
        onSaved={(payload) => handleFirmSaved(payload)}
      />

      {/* Firm delete confirmation */}
      <FirmDeleteDialog
        open={deleteDialog.open}
        onOpenChange={(open) => setDeleteDialog((s) => ({ ...s, open }))}
        firm={deleteDialog.firm}
        onDeleted={handleFirmDeleted}
      />
    </div>
  );
}
