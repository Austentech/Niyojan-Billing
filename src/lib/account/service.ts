import { getSupabaseServiceClient, dbSystemError } from "@/lib/auth/server/db";
import { verifyPassword, hashPassword } from "@/lib/auth/server/password";
import { generateOtpCode, hashOtpCode } from "@/lib/auth/server/otp";
import { sendEmailChangeCode } from "@/lib/auth/server/email";
import { enforceRateLimit } from "@/lib/auth/server/rate-limit";
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
 *     (atomic RPC account_consume_email_change) can activate the address.
 *   * The password change verifies the current credential, stores the new one
 *     as an Argon2id hash, flips credentials_source to 'database' (the
 *     environment bootstrap can never overwrite it again) and revokes every
 *     OTHER session.
 *
 * SECURITY INVARIANTS
 *   * Only the HMAC-SHA256 hash of a verification code is ever stored.
 *   * Verification codes appear only in the outgoing email and in memory —
 *     never in responses, logs or client state.
 *   * Parameterized queries only (PostgREST); error surfaces carry safe
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

interface CorporationProfileRow {
  id: string;
  corporation_name: string;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
}

const CORPORATION_PROFILE_ID = "CORPORATION";
const CORPORATION_SELECT = "id, corporation_name, logo_url, created_at, updated_at";

/**
 * Read the corporation profile, seeding the single row from the brand
 * defaults on first access (idempotent INSERT ... ON CONFLICT DO NOTHING).
 * The bundled official logo asset is used while logo_url is null.
 */
export async function getCorporationProfile(): Promise<CorporationProfileView> {
  const db = getSupabaseServiceClient();

  const { data: existing, error: selectError } = await db
    .from("corporation_profile")
    .select(CORPORATION_SELECT)
    .eq("id", CORPORATION_PROFILE_ID)
    .maybeSingle<CorporationProfileRow>();
  if (selectError) {
    throw new SystemAccountError(`corporation_profile.select failed (${selectError.code ?? ""})`);
  }
  if (existing) {
    return {
      corporationName: existing.corporation_name,
      logoUrl: existing.logo_url ?? null,
      updatedAt: existing.updated_at,
    };
  }

  // First access — seed the row with the brand defaults.
  const { data: seeded, error: insertError } = await db
    .from("corporation_profile")
    .upsert(
      { id: CORPORATION_PROFILE_ID, corporation_name: BRAND.name, logo_url: null },
      { onConflict: "id", ignoreDuplicates: false },
    )
    .select(CORPORATION_SELECT)
    .single<CorporationProfileRow>();
  if (insertError || !seeded) {
    // Lost an insert race — re-read whatever the winner stored.
    const { data: reread } = await db
      .from("corporation_profile")
      .select(CORPORATION_SELECT)
      .eq("id", CORPORATION_PROFILE_ID)
      .maybeSingle<CorporationProfileRow>();
    if (reread) {
      return {
        corporationName: reread.corporation_name,
        logoUrl: reread.logo_url ?? null,
        updatedAt: reread.updated_at,
      };
    }
    throw new SystemAccountError(`corporation_profile.upsert failed (${insertError?.code ?? "no row"})`);
  }

  logAccountEvent("corporation_profile_seeded", {});
  return {
    corporationName: seeded.corporation_name,
    logoUrl: seeded.logo_url ?? null,
    updatedAt: seeded.updated_at,
  };
}

export type UpdateCorporationProfileResult =
  | { status: "updated"; profile: CorporationProfileView }
  | { status: "invalid"; fieldErrors: Record<string, string> };

/**
 * Update the corporation profile (name and/or logo URL). `logoUrl` semantics:
 *   * undefined — keep the current logo untouched,
 *   * null       — remove the custom logo (fall back to the official asset),
 *   * string     — newly stored logo public URL.
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

  const patch: Record<string, string | null> = { corporation_name: parsed.data };
  if (input.logoUrl !== undefined) {
    patch.logo_url = input.logoUrl;
  }

  const { data, error } = await getSupabaseServiceClient()
    .from("corporation_profile")
    .update(patch)
    .eq("id", CORPORATION_PROFILE_ID)
    .select(CORPORATION_SELECT)
    .single<CorporationProfileRow>();
  if (error || !data) {
    throw new SystemAccountError(`corporation_profile.update failed (${error?.code ?? "no row"})`);
  }

  logAccountEvent("corporation_profile_updated", { has_custom_logo: data.logo_url !== null });
  return {
    status: "updated",
    profile: {
      corporationName: data.corporation_name,
      logoUrl: data.logo_url ?? null,
      updatedAt: data.updated_at,
    },
  };
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

  const { data, error } = await getSupabaseServiceClient()
    .from("admin_accounts")
    .update({ display_name: parsed.data })
    .eq("id", input.adminId)
    .select("id, display_name")
    .maybeSingle<{ id: string; display_name: string }>();
  if (error) {
    throw new SystemAccountError(`admin_accounts.update failed (${error.code ?? ""})`);
  }
  if (!data) {
    return { status: "not_found" };
  }

  logAccountEvent("display_name_updated", { admin_id: data.id });
  return { status: "updated", displayName: data.display_name };
}

/* ============================================================================
 * EMAIL CHANGE — verification-gated activation
 * ==========================================================================*/

interface EmailChangeRequestRow {
  id: string;
  admin_id: string;
  new_email: string;
  expires_at: string;
  attempts: number;
  max_attempts: number;
  consumed_at: string | null;
  created_at: string;
}

export interface PendingEmailChange {
  newEmailMasked: string;
  expiresAt: string;
  resendCooldownSeconds: number;
}

/** Latest unconsumed, unexpired email-change request for an administrator. */
async function getActiveEmailChangeRequest(adminId: string): Promise<EmailChangeRequestRow | null> {
  const { data, error } = await getSupabaseServiceClient()
    .from("email_change_requests")
    .select("id, admin_id, new_email, expires_at, attempts, max_attempts, consumed_at, created_at")
    .eq("admin_id", adminId)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<EmailChangeRequestRow>();
  if (error) {
    throw new SystemAccountError(`email_change_requests.select failed (${error.code ?? ""})`);
  }
  if (!data) return null;
  if (Date.parse(data.expires_at) <= Date.now()) return null;
  return data;
}

/** Public view of a pending request for UI rendering (masked address only). */
export async function getPendingEmailChange(adminId: string): Promise<PendingEmailChange | null> {
  const active = await getActiveEmailChangeRequest(adminId);
  if (!active) return null;
  return {
    newEmailMasked: maskEmail(active.new_email),
    expiresAt: active.expires_at,
    resendCooldownSeconds: EMAIL_CHANGE_POLICY.resendCooldownSeconds,
  };
}

async function issueEmailChangeRequest(admin: AdminAccountRow, newEmail: string): Promise<PendingEmailChange> {
  const db = getSupabaseServiceClient();

  // Hard cap of verification emails per rolling hour.
  await enforceRateLimit(
    "account:email-change-request",
    RATE_LIMITS.emailChangeRequest.limit,
    RATE_LIMITS.emailChangeRequest.windowSeconds,
  );

  // Controlled cooldown between consecutive requests (resend protection).
  const { data: lastRequest, error: lastError } = await db
    .from("email_change_requests")
    .select("id, created_at")
    .eq("admin_id", admin.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; created_at: string }>();
  if (lastError) {
    throw new SystemAccountError(`email_change_requests.select failed (${lastError.code ?? ""})`);
  }
  if (lastRequest) {
    const elapsed = (Date.now() - Date.parse(lastRequest.created_at)) / 1000;
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
  await db.rpc("account_invalidate_pending_email_changes", { p_admin_id: admin.id });

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_POLICY.ttlSeconds * 1000).toISOString();

  const { data: request, error: insertError } = await db
    .from("email_change_requests")
    .insert({
      admin_id: admin.id,
      new_email: newEmail,
      code_hash: hashOtpCode(code),
      expires_at: expiresAt,
      max_attempts: EMAIL_CHANGE_POLICY.maxAttempts,
    })
    .select("id, expires_at")
    .single<{ id: string; expires_at: string }>();
  if (insertError || !request) {
    throw new SystemAccountError("email_change_requests.insert failed");
  }

  try {
    await sendEmailChangeCode(newEmail, code);
  } catch (err) {
    // Fail CLOSED: an undeliverable code must not remain active.
    await db.from("email_change_requests").delete().eq("id", request.id);
    throw err;
  }

  logAccountEvent("email_change_requested", { admin_id: admin.id, request_id: request.id });
  return {
    newEmailMasked: maskEmail(newEmail),
    expiresAt: request.expires_at,
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
  const { data: clash, error: clashError } = await getSupabaseServiceClient()
    .from("admin_accounts")
    .select("id")
    .ilike("email", newEmail)
    .neq("id", admin.id)
    .limit(1);
  if (clashError) {
    throw new SystemAccountError(`admin_accounts.select failed (${clashError.code ?? ""})`);
  }
  if (clash && clash.length > 0) {
    return {
      status: "invalid",
      fieldErrors: { email: "This email address is already in use by an administrator account." },
    };
  }

  // Idempotency: re-submitting the SAME pending address must not burn the
  // resend cooldown or email a second code — the active request is returned.
  const active = await getActiveEmailChangeRequest(admin.id);
  if (active && active.new_email.toLowerCase() === newEmail) {
    return {
      status: "requested",
      pending: {
        newEmailMasked: maskEmail(active.new_email),
        expiresAt: active.expires_at,
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

  const { data, error } = await getSupabaseServiceClient().rpc("account_consume_email_change", {
    p_admin_id: input.adminId,
    p_code_hash: hashOtpCode(parsed.data),
  });
  if (error) {
    throw new SystemAccountError(`account_consume_email_change failed (${error.code ?? ""})`);
  }
  const raw = (data ?? {}) as { status?: string; new_email?: string };
  switch (raw.status) {
    case "verified":
      logAccountEvent("email_change_confirmed", { admin_id: input.adminId });
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
  const db = getSupabaseServiceClient();

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

  const pending = await issueEmailChangeRequest(admin, active.new_email);
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
  const db = getSupabaseServiceClient();
  const { error: updateError } = await db
    .from("admin_accounts")
    .update({
      password_hash: passwordHash,
      credentials_source: "database",
      password_updated_at: new Date().toISOString(),
    })
    .eq("id", input.adminId);
  if (updateError) {
    throw new SystemAccountError(`admin_accounts.update failed (${updateError.code ?? ""})`);
  }

  // Revoke every OTHER session (best-effort: the credential is already
  // updated; a revoke failure is logged and does not fail the change).
  const revokeFilter = db
    .from("admin_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("admin_id", input.adminId)
    .is("revoked_at", null);
  const { error: revokeError } =
    input.keepSessionId !== undefined
      ? await revokeFilter.neq("id", input.keepSessionId)
      : await revokeFilter;
  if (revokeError) {
    logAccountError(
      "password_change_session_revoke_failed",
      dbSystemError("admin_sessions.update", revokeError),
      { admin_id: input.adminId },
    );
  }

  logAccountEvent("password_changed", { admin_id: input.adminId });
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
  const db = getSupabaseServiceClient();
  await db.from("email_change_requests").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await db.from("corporation_profile").delete().eq("id", CORPORATION_PROFILE_ID);
  await db.from("rate_limits").delete().like("key", "account:%");
}
