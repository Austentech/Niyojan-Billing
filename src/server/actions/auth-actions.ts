"use server";

/**
 * Authentication server actions. Every action:
 *  1. rate-limits by client IP,
 *  2. re-validates input with the shared Zod schema,
 *  3. enforces account lockout / generic error semantics,
 *  4. returns a typed ActionResult (never throws secrets to the client).
 */
import { headers } from "next/headers";
import { randomBytes, createHash } from "node:crypto";
import { db } from "@/lib/db";
import { loginSchema, forgotPasswordSchema, resetPasswordSchema } from "@/lib/validators";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import {
  createSession,
  destroyCurrentSession,
  getSessionUser,
  purgeExpiredSessions,
} from "@/server/auth/session";
import { rateLimit } from "@/server/auth/rate-limit";
import { getBaseUrl, isSmtpConfigured, sendPasswordResetEmail } from "@/server/mailer";
import { LOCKOUT_DURATION_MIN, LOCKOUT_THRESHOLD, RESET_TOKEN_TTL_MIN } from "@/lib/constants";
import type { ActionResult } from "@/types/app";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function clientKey(prefix: string): Promise<string> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  return `${prefix}:${ip}`;
}

function zodFieldErrors(error: { issues: { path: PropertyKey[]; message: string }[] }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export async function loginAction(input: unknown): Promise<ActionResult> {
  const limit = rateLimit(await clientKey("login"), 10, 10 * 60 * 1000);
  if (!limit.allowed) {
    return { ok: false, message: `Too many sign-in attempts. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).` };
  }

  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Enter a valid email address and password.", fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  const user = await db.adminUser.findUnique({ where: { email: normalizedEmail } });
  const genericFailure: ActionResult = { ok: false, message: "Invalid email address or password." };

  if (!user) {
    // Equalise response time to avoid user-enumeration timing signals.
    await verifyPassword(password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    return genericFailure;
  }
  if (!user.isActive) {
    return genericFailure;
  }

  const now = Date.now();
  if (user.lockedUntil && user.lockedUntil.getTime() > now) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - now) / 60000);
    return { ok: false, message: `Account is temporarily locked after repeated failed sign-ins. Try again in ${minutes} minute(s).` };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const failedAttempts = user.failedAttempts + 1;
    const shouldLock = failedAttempts >= LOCKOUT_THRESHOLD;
    await db.adminUser.update({
      where: { id: user.id },
      data: {
        failedAttempts,
        ...(shouldLock ? { lockedUntil: new Date(now + LOCKOUT_DURATION_MIN * 60 * 1000) } : {}),
      },
    });
    if (shouldLock) {
      return { ok: false, message: `Too many failed sign-ins. The account is locked for ${LOCKOUT_DURATION_MIN} minutes.` };
    }
    return genericFailure;
  }

  await db.adminUser.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await createSession(user.id);
  void purgeExpiredSessions().catch(() => undefined);

  return { ok: true, message: `Signed in as ${user.name}.` };
}

export async function logoutAction(): Promise<ActionResult> {
  await destroyCurrentSession();
  return { ok: true, message: "You have been signed out." };
}

export interface ForgotPasswordResult {
  resetUrl?: string;
  emailDelivered: boolean;
}

export async function forgotPasswordAction(input: unknown): Promise<ActionResult<ForgotPasswordResult>> {
  const limit = rateLimit(await clientKey("forgot"), 5, 15 * 60 * 1000);
  if (!limit.allowed) {
    return { ok: false, message: `Too many reset requests. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).` };
  }

  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Enter a valid email address.", fieldErrors: zodFieldErrors(parsed.error) };
  }

  // Always succeed with the same message — never reveal whether the account exists.
  const genericOk: ActionResult<ForgotPasswordResult> = {
    ok: true,
    message: "If an administrator account exists for that email, reset instructions have been sent.",
  };

  const user = await db.adminUser.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (!user || !user.isActive) return genericOk;

  // Invalidate any previously issued, still-unused tokens for this account.
  await db.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });

  const token = randomBytes(32).toString("base64url");
  await db.passwordResetToken.create({
    data: {
      tokenHash: sha256(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MIN * 60 * 1000),
    },
  });

  const resetUrl = `${await getBaseUrl()}/?reset=${token}`;

  if (isSmtpConfigured()) {
    const mail = await sendPasswordResetEmail(user.email, resetUrl);
    if (mail.delivered) return genericOk;
    console.error("[auth] password-reset email failed to send:", mail.error);
    return {
      ok: false,
      message: "Reset instructions could not be sent right now (email delivery failed). Please try again shortly.",
    };
  }

  // SMTP not configured: log the link and (optionally, dev-only) surface it.
  console.info(`[auth] SMTP not configured — password-reset link for ${user.email} (valid ${RESET_TOKEN_TTL_MIN} min): ${resetUrl}`);
  if (process.env.EXPOSE_RESET_LINK === "true") {
    return {
      ok: true,
      message: genericOk.message,
      data: { resetUrl, emailDelivered: false },
    };
  }
  return genericOk;
}

export async function resetPasswordAction(input: unknown): Promise<ActionResult> {
  const limit = rateLimit(await clientKey("reset"), 10, 10 * 60 * 1000);
  if (!limit.allowed) {
    return { ok: false, message: "Too many attempts. Please try again in a few minutes." };
  }

  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Please correct the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error) };
  }
  const { token, password } = parsed.data;

  const record = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.usedAt !== null || record.expiresAt.getTime() <= Date.now()) {
    return { ok: false, message: "This reset link is invalid or has expired. Please request a new one." };
  }

  const user = await db.adminUser.findUnique({ where: { id: record.userId } });
  if (!user || !user.isActive) {
    return { ok: false, message: "This reset link is invalid or has expired. Please request a new one." };
  }

  await db.$transaction([
    db.adminUser.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(password),
        failedAttempts: 0,
        lockedUntil: null,
        mustChangePassword: false,
      },
    }),
    db.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    db.adminSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  return { ok: true, message: "Password updated. All active sessions were signed out — sign in with your new password." };
}

export async function checkSessionAction(): Promise<ActionResult<{ authenticated: boolean }>> {
  const session = await getSessionUser();
  return { ok: true, data: { authenticated: Boolean(session) } };
}
