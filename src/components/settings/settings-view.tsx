"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Check,
  Loader2,
  LogIn,
  Mail,
  MonitorSmartphone,
  ShieldCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { PasswordInput } from "@/components/auth/password-input";
import { PageHeader } from "@/components/common/ui-blocks";
import { describeDevice, formatDateTime, initials, relativeTime } from "@/lib/format";
import {
  changePasswordSchema,
  profileSchema,
  type ChangePasswordInput,
  type ProfileInput,
} from "@/lib/validators";
import {
  changePasswordAction,
  getAccountDataAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  updateProfileAction,
} from "@/server/actions/account-actions";
import type { AccountData } from "@/server/queries";
import type { AdminUserDto } from "@/types/app";

const PASSWORD_REQUIREMENTS = [
  { key: "length", label: "At least 10 characters", test: (v: string) => v.length >= 10 },
  { key: "lower", label: "One lowercase letter", test: (v: string) => /[a-z]/.test(v) },
  { key: "upper", label: "One uppercase letter", test: (v: string) => /[A-Z]/.test(v) },
  { key: "digit", label: "One number", test: (v: string) => /[0-9]/.test(v) },
  { key: "symbol", label: "One symbol (e.g. ! @ # $)", test: (v: string) => /[^A-Za-z0-9]/.test(v) },
] as const;

/** Account settings: profile, password, active sessions, environment info. */
export function SettingsView({
  user,
  smtpConfigured,
  onUserUpdated,
}: {
  user: AdminUserDto;
  smtpConfigured: boolean;
  onUserUpdated: (user: AdminUserDto) => void;
}) {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const handleAccountSaved = useCallback(
    (data: AccountData) => {
      setAccount(data);
      onUserUpdated(data.user);
    },
    [onUserUpdated],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await getAccountDataAction();
      if (result.ok) {
        if (result.data) {
          setAccount(result.data);
          onUserUpdated(result.data.user);
        } else {
          setLoadError("Account data could not be loaded. Please retry.");
        }
      } else {
        setLoadError(result.message);
      }
    } catch {
      setLoadError("Account data could not be loaded. Please retry.");
    } finally {
      setLoading(false);
    }
  }, [onUserUpdated]);

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account Settings"
        description="Administrator profile, credentials and active sessions."
      />

      {loadError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load settings</AlertTitle>
          <AlertDescription className="flex items-center gap-2">
            {loadError}
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
        <ProfileCard user={account?.user ?? user} onSaved={handleAccountSaved} />
        <PasswordCard onSaved={handleAccountSaved} />
      </div>

      <SessionsCard account={account} loading={loading} onChanged={reload} />

      <section className="rounded-lg border bg-card">
        <h2 className="border-b p-5 text-sm font-semibold">Environment</h2>
        <dl className="divide-y">
          <div className="grid grid-cols-[180px_1fr] gap-4 p-5">
            <dt className="text-[13px] font-medium text-muted-foreground">Email delivery (SMTP)</dt>
            <dd className="text-sm">
              {smtpConfigured ? (
                <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                  <Check className="mr-1 size-3" aria-hidden="true" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-muted text-muted-foreground">
                  <X className="mr-1 size-3" aria-hidden="true" />
                  Not configured
                </Badge>
              )}
              <p className="mt-2 text-[13px] text-muted-foreground">
                {smtpConfigured
                  ? "Password-reset emails are delivered through the configured SMTP server."
                  : "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM_EMAIL to enable email delivery. Until then, reset links are written to the server log."}
              </p>
            </dd>
          </div>
          <div className="grid grid-cols-[180px_1fr] gap-4 p-5">
            <dt className="text-[13px] font-medium text-muted-foreground">Session policy</dt>
            <dd className="text-sm text-foreground">
              8 hours, httpOnly cookie, server-side revocation
              <p className="mt-1 text-[13px] text-muted-foreground">
                Signing out on one device does not affect other sessions.
              </p>
            </dd>
          </div>
          <div className="grid grid-cols-[180px_1fr] gap-4 p-5">
            <dt className="text-[13px] font-medium text-muted-foreground">Data layer</dt>
            <dd className="text-sm text-foreground">
              Prisma ORM — SQLite in this environment, Supabase PostgreSQL-ready schema
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

/* ------------------------------- Profile -------------------------------- */

function ProfileCard({ user, onSaved }: { user: AdminUserDto; onSaved: (data: AccountData) => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<ProfileInput>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: user.name, email: user.email, currentPassword: "" },
  });

  useEffect(() => {
    form.reset({ name: user.name, email: user.email, currentPassword: "" });
  }, [user.id, user.name, user.email]);

  async function onSubmit(values: ProfileInput) {
    setServerError(null);
    setSubmitting(true);
    try {
      const result = await updateProfileAction(values);
      if (result.ok) {
        toast.success(result.message ?? "Profile updated.");
        if (result.data) onSaved(result.data);
        form.setValue("currentPassword", "");
      } else {
        setServerError(result.message);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            form.setError(field as keyof ProfileInput, { message: messages[0] });
          }
        }
      }
    } catch {
      setServerError("The form could not be submitted due to a network or server error.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b p-5">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Profile</h2>
      </div>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 p-5" noValidate>
          {serverError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Could not save profile</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full name</FormLabel>
                <FormControl>
                  <Input placeholder="Administrator name" className="h-10" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email address (sign-in ID)</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" className="h-10" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="currentPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Current password</FormLabel>
                <FormControl>
                  <PasswordInput
                    autoComplete="current-password"
                    placeholder="Required only when changing the email"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "Save profile"
              )}
            </Button>
          </div>
        </form>
      </Form>
    </section>
  );
}

/* ------------------------------- Password -------------------------------- */

function PasswordCard({ onSaved }: { onSaved: (data: AccountData) => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const newPassword = form.watch("newPassword");
  const states = useMemo(
    () => PASSWORD_REQUIREMENTS.map((r) => ({ ...r, met: r.test(newPassword ?? "") })),
    [newPassword],
  );

  async function onSubmit(values: ChangePasswordInput) {
    setServerError(null);
    setSubmitting(true);
    try {
      const result = await changePasswordAction(values);
      if (result.ok) {
        toast.success(result.message ?? "Password changed.");
        if (result.data) onSaved(result.data);
        form.reset({ currentPassword: "", newPassword: "", confirmPassword: "" });
      } else {
        setServerError(result.message);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            form.setError(field as keyof ChangePasswordInput, { message: messages[0] });
          }
        }
      }
    } catch {
      setServerError("The form could not be submitted due to a network or server error.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b p-5">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Password</h2>
      </div>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 p-5" noValidate>
          {serverError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Could not change password</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}

          <FormField
            control={form.control}
            name="currentPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Current password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="current-password" placeholder="Current password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="newPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" placeholder="New password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <ul aria-label="Password requirements" className="space-y-1.5">
            {states.map((r) => (
              <li
                key={r.key}
                className={
                  "flex items-center gap-1.5 text-xs transition-colors " +
                  (r.met ? "text-foreground" : "text-muted-foreground")
                }
              >
                {r.met ? (
                  <Check className="size-3.5 shrink-0 text-gold" aria-hidden="true" />
                ) : (
                  <X className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                {r.label}
              </li>
            ))}
          </ul>
          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm new password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" placeholder="Repeat the new password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Updating…
                </>
              ) : (
                "Change password"
              )}
            </Button>
          </div>
        </form>
      </Form>
    </section>
  );
}

/* ------------------------------- Sessions -------------------------------- */

function SessionsCard({
  account,
  loading,
  onChanged,
}: {
  account: AccountData | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  async function revoke(sessionId: string) {
    setBusyId(sessionId);
    try {
      const result = await revokeSessionAction(sessionId);
      if (result.ok) {
        toast.success(result.message ?? "Session signed out.");
        onChanged();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("The request failed. Please retry.");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeOthers() {
    setRevokingAll(true);
    try {
      const result = await revokeOtherSessionsAction();
      if (result.ok) {
        toast.success(result.message ?? "Other sessions signed out.");
        onChanged();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("The request failed. Please retry.");
    } finally {
      setRevokingAll(false);
    }
  }

  const otherCount = account ? account.sessions.filter((s) => !s.isCurrent).length : 0;

  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-col gap-3 border-b p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Active sessions</h2>
        </div>
        {otherCount > 0 ? (
          <Button variant="outline" size="sm" onClick={revokeOthers} disabled={revokingAll}>
            {revokingAll ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <LogIn className="size-3.5 rotate-180" aria-hidden="true" />
            )}
            Sign out other sessions ({otherCount})
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="space-y-3 p-5">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : !account || account.sessions.length === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">No active sessions found.</p>
      ) : (
        <ul className="divide-y">
          {account.sessions.map((session) => (
            <li key={session.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <MonitorSmartphone className="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {describeDevice(session.userAgent)}
                    {session.isCurrent ? (
                      <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                        This device
                      </Badge>
                    ) : null}
                  </p>
                  <p className="tnum mt-0.5 truncate text-xs text-muted-foreground">
                    IP {session.ipAddress ?? "unknown"} · active {relativeTime(session.lastSeenAt)} · started{" "}
                    {formatDateTime(session.createdAt)} · expires {formatDateTime(session.expiresAt)}
                  </p>
                </div>
              </div>
              {session.isCurrent ? (
                <span className="text-xs text-muted-foreground sm:mr-1">Managed via sign out</span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void revoke(session.id)}
                  disabled={busyId === session.id}
                >
                  {busyId === session.id ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    "Sign out"
                  )}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Separator />
      <p className="p-5 text-[13px] text-muted-foreground">
        <Mail className="mr-1.5 inline size-3.5" aria-hidden="true" />
        Password changes and resets sign out every session automatically.
      </p>
    </section>
  );
}
