import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  Building2,
  Database,
  KeyRound,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FieldRow, PageHeader } from "@/components/common/ui-blocks";
import { LocalTime } from "@/components/common/local-time";
import { LogoMark } from "@/components/brand/brand-logo";
import { CorporationProfileCard } from "@/components/settings/corporation-profile-card";
import { PasswordChangeForm } from "@/components/settings/password-change-form";
import { getSessionContext } from "@/lib/auth/server/context";
import { getAccountOverview, type AccountOverview } from "@/lib/account/service";
import { BRAND, COOKIE_NAMES } from "@/lib/constants";
import type { SessionContext } from "@/lib/auth/types";

/**
 * PROTECTED ROUTE — Account Settings (Phase 3).
 *
 *   * ACCOUNT OVERVIEW — premium read-only identity card: corporation name,
 *     official corporation logo (custom upload or the bundled brand asset),
 *     administrator name/email (from the authenticated account), the actual
 *     last successful login from the database rendered in the reader's local
 *     timezone, and account information.
 *   * CORPORATION PROFILE — editable corporation name, corporation logo,
 *     administrator display name and (verification-gated) administrator
 *     email. Stored separately from authentication configuration.
 *   * PASSWORD CHANGE — database-backed credential update: current-password
 *     verification, Argon2id hashing, strong 12-character policy, revocation
 *     of every other session.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Account Settings",
};

/** The corporation logo: the uploaded custom asset or the official brand mark. */
function CorporationLogo({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  if (logoUrl) {
    return (
      <span
        className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-secondary/60"
        title={`${name} logo`}
      >
        <img src={logoUrl} alt={`${name} logo`} className="h-full w-full object-contain p-1.5" />
      </span>
    );
  }
  return <LogoMark size={64} className="rounded-md" />;
}

export default async function AccountSettingsPage() {
  let session: SessionContext | null = null;
  try {
    session = await getSessionContext();
  } catch {
    session = null;
  }
  if (!session) {
    redirect("/");
  }

  const csrfToken = (await cookies()).get(COOKIE_NAMES.csrf)?.value ?? "";

  let overview: AccountOverview | null = null;
  let loadFailed = false;
  try {
    overview = await getAccountOverview(session.adminId);
    if (!overview) loadFailed = true;
  } catch {
    // Database unreachable — explicit error state, no detail exposed.
    loadFailed = true;
  }

  const admin = overview?.admin;
  const corporation = overview?.corporation;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account settings"
        description="Administrator identity, corporation profile and credential management."
      />

      {loadFailed ? (
        <div
          role="alert"
          className="flex gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3.5 text-sm text-destructive"
        >
          <Database className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="leading-relaxed">
            Account information could not be loaded right now. Please refresh the page in a moment —
            if the problem persists, contact your operator.
          </p>
        </div>
      ) : null}

      {overview && admin && corporation ? (
        <>
          {/* ============ ACCOUNT OVERVIEW (read-only identity) ============ */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Account overview</CardTitle>
              <CardDescription>
                Rendered from the authenticated account configuration and the corporation profile in
                the database — times shown in your local timezone.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-6 lg:flex-row">
                {/* Identity block — corporation logo + names */}
                <div className="flex items-start gap-4 lg:w-[46%] lg:shrink-0">
                  <CorporationLogo logoUrl={corporation.logoUrl} name={corporation.corporationName} />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                      Corporation
                    </p>
                    <h3 className="mt-0.5 text-lg font-semibold leading-snug tracking-tight text-foreground">
                      {corporation.corporationName}
                    </h3>
                    <p className="mt-1 text-[12.5px] text-muted-foreground">{BRAND.tagline}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-gold/40 bg-accent font-medium text-foreground">
                        <UserRound className="mr-1 size-3 text-gold" aria-hidden="true" />
                        Administrator
                      </Badge>
                      <Badge variant="outline" className="bg-muted text-muted-foreground">
                        Internal system
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Account information rows */}
                <dl className="min-w-0 flex-1">
                  <FieldRow label="Administrator name">{admin.displayName}</FieldRow>
                  <FieldRow label="Administrator email">
                    <span className="break-all font-mono text-[13px]">{admin.email}</span>
                  </FieldRow>
                  <FieldRow label="Username">
                    <span className="font-mono text-[13px]">{admin.username}</span>
                  </FieldRow>
                  <FieldRow label="Last successful login">
                    <LocalTime value={admin.lastLoginAt} withZone className="tnum text-[13px]" />
                  </FieldRow>
                  <FieldRow label="Member since">
                    <LocalTime value={admin.createdAt} className="tnum text-[13px]" />
                  </FieldRow>
                  <FieldRow label="Credential source">
                    {admin.credentialsSource === "database" ? (
                      <span className="inline-flex items-center gap-1.5">
                        <ShieldCheck className="size-3.5 text-gold" aria-hidden="true" />
                        Database — set through Account Settings
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <KeyRound className="size-3.5 text-muted-foreground" aria-hidden="true" />
                        Environment bootstrap (one-time)
                      </span>
                    )}
                  </FieldRow>
                  <FieldRow label="Password last updated">
                    <LocalTime value={admin.passwordUpdatedAt} className="tnum text-[13px]" />
                  </FieldRow>
                  <FieldRow label="Current session expires">
                    <LocalTime value={session.expiresAt} className="tnum text-[13px]" />
                  </FieldRow>
                </dl>
              </div>
            </CardContent>
          </Card>

          {/* ============ CORPORATION PROFILE (editable) ============ */}
          <CorporationProfileCard
            csrfToken={csrfToken}
            corporationName={corporation.corporationName}
            logoUrl={corporation.logoUrl}
            displayName={admin.displayName}
            currentEmail={admin.email}
            initialPendingEmail={
              overview.pendingEmailChange
                ? {
                    newEmailMasked: overview.pendingEmailChange.newEmailMasked,
                    expiresAt: overview.pendingEmailChange.expiresAt,
                    resendCooldownSeconds: overview.pendingEmailChange.resendCooldownSeconds,
                  }
                : null
            }
          />

          {/* ============ PASSWORD CHANGE ============ */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Change password</CardTitle>
              <CardDescription>
                Requires your current password. The new credential is stored only as an Argon2id
                hash (minimum 12 characters with mixed case, a number and a symbol). After a
                change, every other signed-in session is revoked and the environment credentials
                stop applying.
              </CardDescription>
            </CardHeader>
            <CardContent className="max-w-xl">
              <PasswordChangeForm csrfToken={csrfToken} />
            </CardContent>
          </Card>
        </>
      ) : null}

      {!loadFailed && !overview ? (
        <div
          role="alert"
          className="flex gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3.5 text-sm text-destructive"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="leading-relaxed">
            This administrator account is no longer available. Please sign in again.
          </p>
        </div>
      ) : null}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Building2 className="size-3" aria-hidden="true" />
        {BRAND.name} · {BRAND.systemName} · Internal system
      </p>
    </div>
  );
}
