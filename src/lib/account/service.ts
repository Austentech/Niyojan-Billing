import { and, desc, eq, ilike, ne, sql } from "drizzle-orm";

import { getDb, getSql } from "@/lib/db";
import { adminAccounts, adminSessions, corporationProfile, emailChangeRequests } from "@/lib/db/schema";
import { dbSystemError } from "@/lib/auth/server/db";
import { verifyPassword, hashPassword } from "@/lib/auth/server/password";
import { generateOtpCode, hashOtpCode } from "@/lib/auth/server/otp";
import { sendEmailChangeCode } from "@/lib/auth/server/email";
import { enforceRateLimit } from "@/lib/auth/server/rate-limit";
import { logSecurityEvent } from "@/lib/auth/server/audit";
import { getAdminById } from "@/lib/auth/service";
import { BRAND, EMAIL_CHANGE_POLICY, RATE_LIMITS } from "@/lib/constants";
import { maskEmail, type AdminAccountRow } from "@/lib/auth/types";
import {
  corporationNameSchema,
  displayNameSchema,
  adminEmailSchema,
  emailChangeCodeSchema,
} from "@/lib/account/validation";
import {
  PublicAccountError,
  SystemAccountError,
  logAccountEvent,
  logAccountError,
} from "@/lib/account/errors";

/**
 * Account Settings service layer (framework-independent — explicit inputs, no
 * request context, fully integration-testable). Mirrors the Phase 1 auth flow
 * engine and the Phase 2 firm service.
 *
 * ARCHITECTURE
 *   * The corporation profile (name + logo) lives in corporation_profile,
 *     COMPLETELY SEPARATE from the authentication configuration in
 *     admin_accounts.
 *   * Administrator email changes are verification-gated: requestEmailChange
 *     emails an 8-character code to the NEW address; only confirmEmailChange
 *     (atomic account_consume_email_change) can activate the address.
 *   * The password change verifies the current credential, stores the new one
 *     as an Argon2id hash, flips credentials_source to 'database' (the
 *     environment bootstrap can never overwrite it again) and revokes every
 *     OTHER session.
 *
 * SECURITY INVARIANTS
 *   * Only the HMAC-SHA256 hash of a verification code is ever stored.
 *   * Verification codes appear only in the outgoing email and in memory —
 *     never in responses, logs or client state.
 *   * Parameterized Drizzle statements only; error surfaces carry safe
 *     public messages, system detail goes to the server log.
 */

/* ============================================================================
 * CORPORATION PROFILE (separate table from authentication)
 * ==========================================================================*/

export interface CorporationProfileView {
  corporationName: string;
  logoUrl: string | null;
  updatedAt: string;
}

const CORPORATION_PROFILE_ID = "CORPORATION";

interface CorporationRow {
  corporationName: string;
  logoUrl: string | null;
  updatedAt: Date;
}

function toProfileView(row: CorporationRow): CorporationProfileView {
  return {
    corporationName: row.corporationName,
    logoUrl: row.logoUrl ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Read the corporation profile, seeding the single row from the brand
 * defaults on first access (idempotent INSERT ... ON CONFLICT DO NOTHING).
 * The bundled official logo asset is used while logo_url is null.
 */
export async function getCorporationProfile(): Promise<CorporationProfileView> {
  const db = getDb();

  let existing: CorporationRow | undefined;
  try {
    const rows = await db
      .select({ corporationName: corporationProfile.corporationName, logoUrl: corporationProfile.logoUrl, updatedAt: corporationProfile.updatedAt })
      .from(corporationProfile)
      .where(eq(corporationProfile.id, CORPORATION_PROFILE_ID))
      .limit(1);
    existing = rows[0];
  } catch (err) {
    throw dbSystemError("corporation_profile.select", err);
  }
  if (existing) return toProfileView(existing);

  // First access — seed the row with the brand defaults (race-safe).
  try {
    const rows = await db
      .insert(corporationProfile)
      .values({ id: CORPORATION_PROFILE_ID, corporationName: BRAND.name, logoUrl: null })
      .onConflictDoNothing({ target: corporationProfile.id })
      .returning({ corporationName: corporationProfile.corporationName, logoUrl: corporationProfile.logoUrl, updatedAt: corporationProfile.updatedAt });
    if (rows[0]) {
      logAccountEvent("corporation_profile_seeded", {});
      return toProfileView(rows[0]);
    }
  } catch (err) {
    // Lost an insert race — fall through and re-read the winner's row.
    logAccountError("corporation_profile_seed_race", err);
  }

  try {
    const rows = await db
      .select({ corporationName: corporationProfile.corporationName, logoUrl: corporationProfile.logoUrl, updatedAt: corporationProfile.updatedAt })
      .from(corporationProfile)
      .where(eq(corporationProfile.id, CORPORATION_PROFILE_ID))
      .limit(1);
    if (rows[0]) return toProfileView(rows[0]);
  } catch (err) {
    // fall through to the error below
  }
  throw new SystemAccountError("corporation_profile.upsert failed (no row)");
}

export type UpdateCorporationProfileResult =
  | { status: "updated"; profile: CorporationProfileView }
  | { status: "invalid"; fieldErrors: Record<string, string> };

/**
 * Update the corporation profile (name and/or logo URL). `logoUrl` semantics:
 *   * undefined — keep the current logo untouched,
 *   * null       — remove the custom logo (fall back to the official asset),
 *   * string     — newly stored logo public URL (upload or validated URL).
 */
export async function updateCorporationProfile(input: {
  corporationName: string;
  logoUrl?: string | null;
}): Promise<UpdateCorporationProfileResult> {
  const parsed = corporationNameSchema.safeParse(input.corporationName);
  if (!parsed.success) {
    return { status: "invalid", fieldErrors: { corporationName: parsed.error.issues[0]?.message ?? "Enter a valid corporation name." } };
  }

  await getCorporationProfile(); // guarantees the row exists

  const patch: { corporationName: string; logoUrl?: string | null } = { corporationName: parsed.data };
  if (input.logoUrl !== undefined) {
    patch.logoUrl = input.logoUrl;
  }

  let row: CorporationRow | undefined;
  try {
    const rows = await getDb()
      .update(corporationProfile)
      .set(patch)
      .where(eq(corporationProfile.id, CORPORATION_PROFILE_ID))
      .returning({ corporationName: corporationProfile.corporationName, logoUrl: corporationProfile.logoUrl, updatedAt: corporationProfile.updatedAt });
    row = rows[0];
  } catch (err) {
    throw dbSystemError("corporation_profile.update", err);
  }
  if (!row) {
    throw dbSystemError("corporation_profile.update", null);
  }

  logAccountEvent("corporation_profile_updated", { has_custom_logo: row.logoUrl !== null });
  return { status: "updated", profile: toProfileView(row) };
}

/* ============================================================================
 * ADMINISTRATOR DISPLAY NAME (admin_accounts, non-credential field)
 * ==========================================================================*/

export type UpdateDisplayNameResult =
  | { status: "updated"; displayName: string }
  | { status: "invalid"; fieldErrors: Record<string, string> }
  | { status: "not_found" };

export async function updateDisplayName(input: {
  adminId: string;
  displayName: string;
}): Promise<UpdateDisplayNameResult> {
  const parsed = displayNameSchema.safeParse(input.displayName);
  if (!parsed.success) {
    return {
      status: "invalid",
      fieldErrors: { displayName: parsed.error.issues[0]?.message ?? "Enter a valid administrator name." },
    };
  }

  let row: { id: string; displayName: string } | undefined;
  try {
    const rows = await getDb()
      .update(adminAccounts)
      .set({ displayName: parsed.data })
      .where(eq(adminAccounts.id, input.adminId))
      .returning({ id: adminAccounts.id, displayName: adminAccounts.displayName });
    row = rows[0];
  } catch (err) {
    throw dbSystemError("admin_accounts.update", err);
  }
  if (!row) {
    return { status: "not_found" };
  }

  logAccountEvent("display_name_updated", { admin_id: row.id });
  return { status: "updated", displayName: row.displayName };
}

/* ============================================================================
 * EMAIL CHANGE — verification-gated activation
 * ==========================================================================*/

interface EmailChangeRequestRow {
  id: string;
  newEmail: string;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface PendingEmailChange {
  newEmailMasked: string;
  expiresAt: string;
  resendCooldownSeconds: number;
}

/** Latest unconsumed, unexpired email-change request for an administrator. */
async function getActiveEmailChangeRequest(adminId: string): Promise<EmailChangeRequestRow | null> {
  let row: EmailChangeRequestRow | undefined;
  try {
    const rows = await getDb()
      .select({
        id: emailChangeRequests.id,
        newEmail: emailChangeRequests.newEmail,
        expiresAt: emailChangeRequests.expiresAt,
        attempts: emailChangeRequests.attempts,
        maxAttempts: emailChangeRequests.maxAttempts,
        consumedAt: emailChangeRequests.consumedAt,
        createdAt: emailChangeRequests.createdAt,
      })
      .from(emailChangeRequests)
      .where(and(eq(emailChangeRequests.adminId, adminId), sql`consumed_at is null`))
      .orderBy(desc(emailChangeRequests.createdAt))
      .limit(1);
    row = rows[0];
  } catch (err) {
    throw dbSystemError("email_change_requests.select", err);
  }
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

/** Public view of a pending request for UI rendering (masked address only). */
export async function getPendingEmailChange(adminId: string): Promise<PendingEmailChange | null> {
  const active = await getActiveEmailChangeRequest(adminId);
  if (!active) return null;
  return {
    newEmailMasked: maskEmail(active.newEmail),
    expiresAt: active.expiresAt.toISOString(),
    resendCooldownSeconds: EMAIL_CHANGE_POLICY.resendCooldownSeconds,
  };
}

async function issueEmailChangeRequest(admin: AdminAccountRow, newEmail: string): Promise<PendingEmailChange> {
  const db = getDb();

  // Hard cap of verification emails per rolling hour.
  await enforceRateLimit(
    "account:email-change-request",
    RATE_LIMITS.emailChangeRequest.limit,
    RATE_LIMITS.emailChangeRequest.windowSeconds,
  );

  // Controlled cooldown between consecutive requests (resend protection).
  let lastRequest: { createdAt: Date } | undefined;
  try {
    const rows = await db
      .select({ createdAt: emailChangeRequests.createdAt })
      .from(emailChangeRequests)
      .where(eq(emailChangeRequests.adminId, admin.id))
      .orderBy(desc(emailChangeRequests.createdAt))
      .limit(1);
    lastRequest = rows[0];
  } catch (err) {
    throw dbSystemError("email_change_requests.select", err);
  }
  if (lastRequest) {
    const elapsed = (Date.now() - lastRequest.createdAt.getTime()) / 1000;
    const wait = Math.ceil(EMAIL_CHANGE_POLICY.resendCooldownSeconds - elapsed);
    if (wait > 0) {
      throw new PublicAccountError(
        `Please wait ${wait} second${wait === 1 ? "" : "s"} before requesting a new confirmation code.`,
        "email_change_cooldown",
        wait,
      );
    }
  }

  // Issuing a new request retires every previous unconsumed one.
  try {
    await getSql()`select account_invalidate_pending_email_changes(${admin.id}::uuid)`;
  } catch (err) {
    throw dbSystemError("account_invalidate_pending_email_changes", err);
  }

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_POLICY.ttlSeconds * 1000);

  let request: { id: string; expiresAt: Date } | undefined;
  try {
    const rows = await db
      .insert(emailChangeRequests)
      .values({
        adminId: admin.id,
        newEmail,
        codeHash: hashOtpCode(code),
        expiresAt,
        maxAttempts: EMAIL_CHANGE_POLICY.maxAttempts,
      })
      .returning({ id: emailChangeRequests.id, expiresAt: emailChangeRequests.expiresAt });
    request = rows[0];
  } catch (err) {
    throw dbSystemError("email_change_requests.insert", err);
  }
  if (!request) {
    throw new SystemAccountError("email_change_requests.insert failed");
  }

  try {
    await sendEmailChangeCode(newEmail, code);
  } catch (err) {
    // Fail CLOSED: an undeliverable code must not remain active.
    await db.delete(emailChangeRequests).where(eq(emailChangeRequests.id, request.id)).catch(() => undefined);
    throw err;
  }

  logAccountEvent("email_change_requested", { admin_id: admin.id, request_id: request.id });
  return {
    newEmailMasked: maskEmail(newEmail),
    expiresAt: request.expiresAt.toISOString(),
    resendCooldownSeconds: EMAIL_CHANGE_POLICY.resendCooldownSeconds,
  };
}

export type RequestEmailChangeResult =
  | { status: "requested"; pending: PendingEmailChange }
  | { status: "invalid"; fieldErrors: Record<string, string> }
  | { status: "not_found" };

/**
 * Start an email change: validate the new address (format, difference from
 * the current one, uniqueness across administrators), then email a
 * verification code to the NEW address. The current email stays active until
 * the code is confirmed.
 */
export async function requestEmailChange(input: {
  adminId: string;
  newEmail: string;
}): Promise<RequestEmailChangeResult> {
  const parsed = adminEmailSchema.safeParse(input.newEmail);
  if (!parsed.success) {
    return { status: "invalid", fieldErrors: { email: parsed.error.issues[0]?.message ?? "Enter a valid email address." } };
  }
  const newEmail = parsed.data;

  const admin = await getAdminById(input.adminId);
  if (!admin || !admin.is_active) {
    return { status: "not_found" };
  }
  if (admin.email.toLowerCase() === newEmail) {
    return {
      status: "invalid",
      fieldErrors: { email: "This is already your administrator email." },
    };
  }

  // Uniqueness: the address must not belong to any administrator account.
  let clash: { id: string } | undefined;
  try {
    const rows = await getDb()
      .select({ id: adminAccounts.id })
      .from(adminAccounts)
      .where(and(ilike(adminAccounts.email, newEmail), ne(adminAccounts.id, admin.id)))
      .limit(1);
    clash = rows[0];
  } catch (err) {
    throw dbSystemError("admin_accounts.select", err);
  }
  if (clash) {
    return {
      status: "invalid",
      fieldErrors: { email: "This email address is already in use by an administrator account." },
    };
  }

  // Idempotency: re-submitting the SAME pending address must not burn the
  // resend cooldown or email a second code — the active request is returned.
  const active = await getActiveEmailChangeRequest(admin.id);
  if (active && active.newEmail.toLowerCase() === newEmail) {
    return {
      status: "requested",
      pending: {
        newEmailMasked: maskEmail(active.newEmail),
        expiresAt: active.expiresAt.toISOString(),
        resendCooldownSeconds: EMAIL_CHANGE_POLICY.resendCooldownSeconds,
      },
    };
  }

  const pending = await issueEmailChangeRequest(admin, newEmail);
  return { status: "requested", pending };
}

export type ConfirmEmailChangeResult =
  | { status: "verified"; newEmail: string }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "too_many_attempts" }
  | { status: "not_found" };

/** Verify the confirmation code — on success the new email is ACTIVE. */
export async function confirmEmailChange(input: {
  adminId: string;
  code: string;
}): Promise<ConfirmEmailChangeResult> {
  // Verification attempts are rate-limited (brute-force protection on top of
  // the per-request attempt counter).
  await enforceRateLimit(
    "account:email-change-verify",
    RATE_LIMITS.emailChangeVerify.limit,
    RATE_LIMITS.emailChangeVerify.windowSeconds,
  );

  const parsed = emailChangeCodeSchema.safeParse(input.code);
  if (!parsed.success) {
    // Malformed input — same treatment as a wrong code, but the database
    // never sees it (no attempt slot burned).
    return { status: "invalid" };
  }

  let raw: { status?: string; new_email?: string } | undefined;
  try {
    const sql = getSql();
    const rows = await sql<{ result: { status?: string; new_email?: string } }[]>`
      select account_consume_email_change(${input.adminId}::uuid, ${hashOtpCode(parsed.data)}::text) as result
    `;
    raw = rows[0]?.result;
  } catch (err) {
    throw dbSystemError("account_consume_email_change", err);
  }

  switch (raw?.status) {
    case "verified":
      logAccountEvent("email_change_confirmed", { admin_id: input.adminId });
      await logSecurityEvent("admin_email_changed", { adminId: input.adminId, detail: {} });
      return { status: "verified", newEmail: raw.new_email ?? "" };
    case "expired":
      return { status: "expired" };
    case "too_many_attempts":
      return { status: "too_many_attempts" };
    case "not_found":
      return { status: "not_found" };
    case "invalid":
    default:
      return { status: "invalid" };
  }
}

export type ResendEmailChangeResult =
  | { status: "requested"; pending: PendingEmailChange }
  | { status: "not_found" };

/** Re-issue the confirmation code for the CURRENT pending request (if any). */
export async function resendEmailChangeCode(input: { adminId: string }): Promise<ResendEmailChangeResult> {
  const active = await getActiveEmailChangeRequest(input.adminId);
  if (!active) {
    return { status: "not_found" };
  }

  // Cooldown + hourly cap enforced inside issueEmailChangeRequest; the
  // cooldown is measured from the LAST request (active or consumed).
  const admin = await getAdminById(input.adminId);
  if (!admin || !admin.is_active) {
    return { status: "not_found" };
  }

  const pending = await issueEmailChangeRequest(admin, active.newEmail);
  return { status: "requested", pending };
}

/* ============================================================================
 * PASSWORD CHANGE (database-backed credential)
 * ==========================================================================*/

export type ChangePasswordResult =
  | { status: "changed" }
  | { status: "invalid"; message: string }
  | { status: "wrong_current" }
  | { status: "not_found" };

/**
 * Change the administrator password:
 *   1. the CURRENT password is verified against the stored Argon2id hash,
 *   2. the new password is validated against the strong policy and hashed
 *      with Argon2id (plaintext never touches the database, logs, responses),
 *   3. credentials_source flips to 'database' — the environment bootstrap
 *      can never overwrite the credential again,
 *   4. every OTHER session is revoked (keepSessionId is retained so the
 *      administrator is not signed out mid-flow).
 */
export async function changeAdminPassword(input: {
  adminId: string;
  currentPassword: string;
  newPassword: string;
  keepSessionId?: string;
}): Promise<ChangePasswordResult> {
  const admin = await getAdminById(input.adminId);
  if (!admin || !admin.is_active) {
    return { status: "not_found" };
  }

  const currentOk = await verifyPassword(input.currentPassword, admin.password_hash);
  if (!currentOk) {
    logAccountEvent("password_change_rejected_wrong_current", { admin_id: input.adminId });
    return { status: "wrong_current" };
  }
  if (input.newPassword === input.currentPassword) {
    return { status: "invalid", message: "The new password must be different from your current password." };
  }

  const passwordHash = await hashPassword(input.newPassword);
  const db = getDb();
  try {
    await db
      .update(adminAccounts)
      .set({
        passwordHash,
        credentialsSource: "database",
        passwordUpdatedAt: new Date(),
      })
      .where(eq(adminAccounts.id, input.adminId));
  } catch (err) {
    throw dbSystemError("admin_accounts.update", err);
  }

  // Revoke every OTHER session (best-effort: the credential is already
  // updated; a revoke failure is logged and does not fail the change).
  try {
    const revokeFilter =
      input.keepSessionId !== undefined
        ? and(
            eq(adminSessions.adminId, input.adminId),
            sql`revoked_at is null`,
            ne(adminSessions.id, input.keepSessionId),
          )
        : and(eq(adminSessions.adminId, input.adminId), sql`revoked_at is null`);
    await db.update(adminSessions).set({ revokedAt: new Date() }).where(revokeFilter);
  } catch (err) {
    logAccountError(
      "password_change_session_revoke_failed",
      dbSystemError("admin_sessions.update", err),
      { admin_id: input.adminId },
    );
  }

  logAccountEvent("password_changed", { admin_id: input.adminId });
  await logSecurityEvent("admin_password_changed", {
    adminId: input.adminId,
    detail: { other_sessions_revoked: true },
  });
  return { status: "changed" };
}

/* ============================================================================
 * ACCOUNT OVERVIEW (page assembly)
 * ==========================================================================*/

export interface AccountOverview {
  admin: {
    displayName: string;
    username: string;
    email: string;
    credentialsSource: "env_bootstrap" | "database";
    passwordUpdatedAt: string;
    lastLoginAt: string | null;
    createdAt: string;
  };
  corporation: CorporationProfileView;
  pendingEmailChange: PendingEmailChange | null;
}

/** Everything the Account Settings page renders, from the two sources. */
export async function getAccountOverview(adminId: string): Promise<AccountOverview | null> {
  const admin = await getAdminById(adminId);
  if (!admin || !admin.is_active) {
    return null;
  }
  const [corporation, pendingEmailChange] = await Promise.all([
    getCorporationProfile(),
    getPendingEmailChange(adminId).catch(() => null),
  ]);

  return {
    admin: {
      displayName: admin.display_name,
      username: admin.username,
      email: admin.email,
      credentialsSource: admin.credentials_source,
      passwordUpdatedAt: admin.password_updated_at,
      lastLoginAt: admin.last_login_at,
      createdAt: admin.created_at,
    },
    corporation,
    pendingEmailChange,
  };
}

/* ============================================================================
 * Test/operations hooks (NEVER exposed through any HTTP route)
 * ==========================================================================*/

/** Destructive reset of account-settings state. Staging test suite ONLY. */
export async function resetAccountDataForTests(): Promise<void> {
  const db = getDb();
  await db.execute(sql`delete from public.email_change_requests`);
  await db.execute(sql`delete from public.corporation_profile where id = 'CORPORATION'`);
  await db.execute(sql`delete from public.rate_limits where key like 'account:%'`);
}
