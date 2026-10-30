"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Building2, CheckCircle2, Clock, Plus, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, StatCard } from "@/components/common/ui-blocks";
import { FirmCard } from "@/components/dashboard/firm-card";
import { formatDate } from "@/lib/format";
import type { AdminUserDto, DashboardStats, FirmDto } from "@/types/app";

/** Landing view: firm portfolio stats + latest registrations. */
export function DashboardView({
  user,
  firms,
  stats,
  busyFirmId,
  onOpenFirm,
  onEditFirm,
  onToggleStatus,
  onDeleteFirm,
  onAddFirm,
  onGoToFirms,
  onGoToSettings,
}: {
  user: AdminUserDto;
  firms: FirmDto[];
  stats: DashboardStats;
  busyFirmId: string | null;
  onOpenFirm: (firm: FirmDto) => void;
  onEditFirm: (firm: FirmDto) => void;
  onToggleStatus: (firm: FirmDto) => void;
  onDeleteFirm: (firm: FirmDto) => void;
  onAddFirm: () => void;
  onGoToFirms: () => void;
  onGoToSettings: () => void;
}) {
  const [passwordNoticeDismissed, setPasswordNoticeDismissed] = useState(false);

  const latestFirms = useMemo(
    () => [...firms].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8),
    [firms],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${user.name.split(" ")[0]}`}
        description={
          user.lastLoginAt
            ? `Last signed in ${formatDate(user.lastLoginAt)}. Overview of firms under centralized management.`
            : "Overview of firms under centralized management."
        }
        actions={
          <Button onClick={onAddFirm} className="hidden sm:inline-flex">
            <Plus className="size-4" aria-hidden="true" />
            Register firm
          </Button>
        }
      />

      {/* Initial-password security notice */}
      <AnimatePresence>
        {user.mustChangePassword && !passwordNoticeDismissed ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            role="status"
            className="flex flex-col gap-3 rounded-lg border border-gold/50 bg-accent p-4 sm:flex-row sm:items-center"
          >
            <ShieldAlert className="size-5 shrink-0 text-gold" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Change the initial administrator password</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                This account still uses the password provisioned at first boot. Set a new one now from Account
                Settings.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={onGoToSettings}>
                Change password
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8 text-muted-foreground"
                onClick={() => setPasswordNoticeDismissed(true)}
                aria-label="Dismiss password notice"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Portfolio stats */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Registered firms" value={stats.total} icon={Building2} hint="Total under management" />
        <StatCard label="Active" value={stats.active} icon={CheckCircle2} tone="gold" hint="Currently operational" />
        <StatCard label="Inactive" value={stats.inactive} icon={Clock} tone="muted" hint="Flagged dormant" />
        <StatCard label="Added · 30 days" value={stats.addedLast30Days} icon={Plus} hint="New registrations" />
      </div>

      {/* Latest registrations */}
      <section className="space-y-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Latest registrations</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Most recently registered firms in the portfolio.</p>
          </div>
          {firms.length > 0 ? (
            <Button variant="ghost" size="sm" className="text-navy hover:text-gold" onClick={onGoToFirms}>
              Full registry
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        {latestFirms.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {latestFirms.map((firm) => (
              <FirmCard
                key={firm.id}
                firm={firm}
                busy={busyFirmId === firm.id}
                onOpen={onOpenFirm}
                onEdit={onEditFirm}
                onToggleStatus={onToggleStatus}
                onDelete={onDeleteFirm}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Building2}
            title="No firms registered yet"
            description="Register the first business firm to bring it under centralized Niyojan Corporation management."
            action={
              <Button onClick={onAddFirm}>
                <Plus className="size-4" aria-hidden="true" />
                Register your first firm
              </Button>
            }
          />
        )}
      </section>
    </div>
  );
}
