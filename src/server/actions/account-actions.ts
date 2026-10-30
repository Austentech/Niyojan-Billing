"use server";

/**
 * Account settings server actions — profile updates, password change and
 * session revocation. Every action re-checks the session server-side.
 */
import { db } from "@/lib/db";
import { profileSchema, changePasswordSchema } from "@/lib/validators";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { getSessionUser, revokeAllSessions, revokeSessionById } from "@/server/auth/session";
import { getAccountData, type AccountData } from "@/server/queries";
import type { ActionResult } from "@/types/app";

function zodFieldErrors(error: { issues: { path: PropertyKey[]; message: string }[] }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export async function getAccountDataAction(): Promise<ActionResult<AccountData>> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };
  return { ok: true, data: await getAccountData(auth) };
}

export async function updateProfileAction(input: unknown): Promise<ActionResult<AccountData>> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };

  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Please correct the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { name, email, currentPassword } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const emailChanged = normalizedEmail !== auth.user.email;

  if (emailChanged) {
    if (!currentPassword) {
      return {
        ok: false,
        message: "Enter your current password to change the email address.",
        fieldErrors: { currentPassword: ["Enter your current password to change the email address"] },
      };
    }
    const record = await db.adminUser.findUnique({ where: { id: auth.user.id } });
    if (!record || !(await verifyPassword(currentPassword, record.passwordHash))) {
      return {
        ok: false,
        message: "Current password is incorrect.",
        fieldErrors: { currentPassword: ["Current password is incorrect"] },
      };
    }
    const clash = await db.adminUser.findUnique({ where: { email: normalizedEmail } });
    if (clash) {
      return {
        ok: false,
        message: "That email address is already in use.",
        fieldErrors: { email: ["That email address is already in use"] },
      };
    }
  }

  await db.adminUser.update({
    where: { id: auth.user.id },
    data: { name, ...(emailChanged ? { email: normalizedEmail } : {}) },
  });

  const refreshed = await getSessionUser();
  if (!refreshed) return { ok: false, message: "Your session has expired. Please sign in again." };
  return { ok: true, message: "Profile updated.", data: await getAccountData(refreshed) };
}

export async function changePasswordAction(input: unknown): Promise<ActionResult<AccountData>> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };

  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Please correct the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { currentPassword, newPassword } = parsed.data;

  const record = await db.adminUser.findUnique({ where: { id: auth.user.id } });
  if (!record) return { ok: false, message: "Account not found." };

  if (!(await verifyPassword(currentPassword, record.passwordHash))) {
    return {
      ok: false,
      message: "Current password is incorrect.",
      fieldErrors: { currentPassword: ["Current password is incorrect"] },
    };
  }
  if (currentPassword === newPassword) {
    return {
      ok: false,
      message: "The new password must be different from the current one.",
      fieldErrors: { newPassword: ["Choose a password you have not used here before"] },
    };
  }

  await db.adminUser.update({
    where: { id: auth.user.id },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
  });
  // Keep this device signed in; sign out everywhere else.
  const revoked = await revokeAllSessions(auth.user.id, auth.sessionId);

  const refreshed = await getSessionUser();
  if (!refreshed) return { ok: false, message: "Your session has expired. Please sign in again." };
  return {
    ok: true,
    message: revoked > 0 ? `Password changed. ${revoked} other session(s) signed out.` : "Password changed.",
    data: await getAccountData(refreshed),
  };
}

export async function revokeSessionAction(sessionId: string): Promise<ActionResult> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { ok: false, message: "Invalid session reference." };
  }
  if (sessionId === auth.sessionId) {
    return { ok: false, message: "Use sign out to end the current session." };
  }
  const revoked = await revokeSessionById(auth.user.id, sessionId);
  if (!revoked) return { ok: false, message: "That session is no longer active." };
  return { ok: true, message: "Session signed out." };
}

export async function revokeOtherSessionsAction(): Promise<ActionResult> {
  const auth = await getSessionUser();
  if (!auth) return { ok: false, message: "Your session has expired. Please sign in again." };
  const revoked = await revokeAllSessions(auth.user.id, auth.sessionId);
  return {
    ok: true,
    message: revoked > 0 ? `${revoked} other session(s) signed out.` : "No other active sessions.",
  };
}
