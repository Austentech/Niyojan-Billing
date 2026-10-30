import { AuthScreen } from "@/components/auth/auth-screen";
import { AppShell } from "@/components/app/app-shell";
import { ensureSeeded } from "@/server/seed";
import { getSessionUser } from "@/server/auth/session";
import { getAuthEnvironmentInfo, getDashboardStats, listFirms, toAdminUserDto } from "@/server/queries";

// Session state is read per request — the application is always dynamic.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Single entry route: server-side session gate. Unauthenticated visitors get
 * the auth screen (sign-in / forgot / reset via ?reset=<token>); authenticated
 * administrators get the management shell.
 */
export default async function Page({ searchParams }: PageProps) {
  await ensureSeeded();

  const params = await searchParams;
  const resetToken = typeof params.reset === "string" && params.reset.trim() !== "" ? params.reset.trim() : undefined;

  const auth = await getSessionUser();
  const envInfo = getAuthEnvironmentInfo();

  if (!auth) {
    return <AuthScreen envInfo={envInfo} initialResetToken={resetToken} />;
  }

  const [firms, stats] = await Promise.all([listFirms(), getDashboardStats()]);

  return (
    <AppShell
      user={toAdminUserDto(auth.user)}
      firms={firms}
      stats={stats}
      smtpConfigured={envInfo.smtpConfigured}
    />
  );
}
