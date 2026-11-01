import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { KeyRound, ShieldCheck, UserRound } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldRow } from "@/components/common/ui-blocks";
import { PasswordChangeForm } from "@/components/settings/password-change-form";
import { getSessionContext } from "@/lib/auth/server/context";
import { getAdminById } from "@/lib/auth/service";
import { formatDateTime } from "@/lib/format";
import { COOKIE_NAMES } from "@/lib/constants";
import type { SessionContext } from "@/lib/auth/types";

/**
 * PROTECTED ROUTE — Account Settings.
 *
 * Administrator profile maintenance and the database-backed password change:
 * updating the password here hashes the new credential with Argon2id, flips
 * the credential source to 'database' (the environment bootstrap can never
 * overwrite it again) and revokes every other session.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Account Settings",
};

function formatUtc(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
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

  const admin = await getAdminById(session.adminId).catch(() => null);
  const csrfToken = (await cookies()).get(COOKIE_NAMES.csrf)?.value ?? "";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2.5">
        <UserRound className="size-5 text-gold" aria-hidden="true" />
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Account settings</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Administrator identity and credential management.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Administrator profile</CardTitle>
          <CardDescription>
            Read from the authenticated account configuration in the database.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl>
            <FieldRow label="Display name">{session.displayName}</FieldRow>
            <FieldRow label="Username">
              <span className="font-mono text-[13px]">{session.username}</span>
            </FieldRow>
            <FieldRow label="Email">
              <span className="break-all">{session.email}</span>
            </FieldRow>
            <FieldRow label="Credential source">
              {admin?.credentials_source === "database" ? (
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
              <span className="tnum text-[13px]">{formatUtc(admin?.password_updated_at)}</span>
            </FieldRow>
            <FieldRow label="Last sign-in">
              <span className="tnum text-[13px]">{formatUtc(admin?.last_login_at)}</span>
            </FieldRow>
            <FieldRow label="Current session expires">
              <span className="tnum text-[13px]">{formatUtc(session.expiresAt)}</span>
            </FieldRow>
            <FieldRow label="Session issued">
              <span className="tnum text-[13px]">{formatDateTime(session.createdAt)}</span>
            </FieldRow>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Change password</CardTitle>
          <CardDescription>
            Your new password is stored only as an Argon2id hash. After a change, every other
            signed-in session is revoked and the environment credentials stop applying.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-w-xl">
          <PasswordChangeForm csrfToken={csrfToken} />
        </CardContent>
      </Card>
    </div>
  );
}
