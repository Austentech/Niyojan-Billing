"use server";

import { revalidatePath } from "next/cache";

import { EnvConfigError } from "@/lib/config/env";
import { PublicAuthError, RequestBlockedError, SystemAuthError, logAuthError } from "@/lib/auth/errors";
import { assertTrustedMutation } from "@/lib/auth/server/request-guard";
import { enforceRateLimit } from "@/lib/auth/server/rate-limit";
import { getSessionContext } from "@/lib/auth/server/context";
import { PublicAccountError, SystemAccountError, logAccountError } from "@/lib/account/errors";
import { storeCorporationLogo } from "@/lib/account/storage";
import {
  confirmEmailChange,
  changeAdminPassword,
  requestEmailChange,
  resendEmailChangeCode,
  updateCorporationProfile,
  updateDisplayName,
} from "@/lib/account/service";
import { corporationProfileSchema } from "@/lib/account/validation";
import { passwordChangeSchema } from "@/lib/auth/validation";
import { RATE_LIMITS } from "@/lib/constants";
import type { EmailChangeActionState, PasswordActionState, ProfileActionState } from "@/types/account";

/**
 * Server Actions — the ONLY state-changing account-settings endpoints.
 *
 * Every action, in order:
 *   1. server-side session authorization (only the authenticated
 *      administrator may touch account settings),
 *   2. origin + CSRF double-submit validation,
 *   3. distributed rate limiting on the write operation,
 *   4. server-authoritative field validation (Zod),
 *   5. delegation to the pure service layer (src/lib/account/service.ts),
 *   6. revalidation of every surface that renders account data.
 *
 * Errors are mapped to safe client states — no internal detail, no hashes,
 * no verification codes, no storage paths ever reach the browser.
 */

function unavailableAccount(): { status: "unavailable"; message: string } {
  return {
    status: "unavailable",
    message: "Account settings are temporarily unavailable. Please try again shortly.",
  };
}

function mapProfileError(err: unknown): ProfileActionState {
  if (err instanceof EnvConfigError) {
    return { status: "config_error", message: "Server configuration is incomplete. Please contact your operator." };
  }
  if (err instanceof RequestBlockedError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof PublicAuthError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof PublicAccountError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof SystemAuthError || err instanceof SystemAccountError) {
    return { status: "unavailable", message: err.message };
  }
  logAccountError("profile_action_unexpected_error", err);
  return unavailableAccount();
}

function mapEmailChangeError(err: unknown): EmailChangeActionState {
  if (err instanceof EnvConfigError) {
    return { status: "config_error", message: "Server configuration is incomplete. Please contact your operator." };
  }
  if (err instanceof RequestBlockedError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof PublicAuthError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof PublicAccountError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof SystemAuthError || err instanceof SystemAccountError) {
    return { status: "unavailable", message: err.message };
  }
  logAccountError("email_change_action_unexpected_error", err);
  return { status: "unavailable", message: unavailableAccount().message };
}

function mapPasswordError(err: unknown): PasswordActionState {
  if (err instanceof EnvConfigError) {
    return { status: "config_error", message: "Server configuration is incomplete. Please contact your operator." };
  }
  if (err instanceof RequestBlockedError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof PublicAuthError) {
    return { status: "blocked", message: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof SystemAuthError || err instanceof SystemAccountError) {
    return { status: "unavailable", message: err.message };
  }
  logAuthError("password_change_unexpected_error", err);
  return unavailableAccount();
}

/* ============================================================================
 * CORPORATION PROFILE — name, logo, administrator display name
 * ==========================================================================*/

export async function updateCorporationProfileAction(
  _prev: ProfileActionState,
  formData: FormData,
): Promise<ProfileActionState> {
  try {
    /* --- 1. Authorization ---------------------------------------------------- */
    const session = await getSessionContext();
    if (!session) {
      return { status: "unauthorized", message: "Your session has expired. Please sign in again to continue." };
    }

    /* --- 2. Origin + CSRF ------------------------------------------------------ */
    await assertTrustedMutation(formData);

    /* --- 3. Rate limit (write operation) ---------------------------------------- */
    await enforceRateLimit(
      "account:profile-update",
      RATE_LIMITS.profileUpdate.limit,
      RATE_LIMITS.profileUpdate.windowSeconds,
    );

    /* --- 4. Authoritative field validation ---------------------------------------- */
    const parsed = corporationProfileSchema.safeParse({
      corporationName: String(formData.get("corporationName") ?? ""),
      displayName: String(formData.get("displayName") ?? ""),
      email: String(formData.get("email") ?? session.email),
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0]?.toString() ?? "form";
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return { status: "invalid", fieldErrors };
    }

    /* --- 5. Optional logo: harden + upload (before any write) ------------------- */
    const logoEntry = formData.get("logo");
    const removeLogo = formData.get("removeLogo") === "true";
    let logoUrl: string | null | undefined;
    if (logoEntry instanceof File && logoEntry.size > 0) {
      const bytes = Buffer.from(await logoEntry.arrayBuffer());
      logoUrl = await storeCorporationLogo(bytes); // throws PublicAccountError on rejection
    } else if (removeLogo) {
      logoUrl = null;
    }

    /* --- 6. Persist via the service layer ------------------------------------------ */
    const profileResult = await updateCorporationProfile({
      corporationName: parsed.data.corporationName,
      logoUrl,
    });
    if (profileResult.status === "invalid") {
      return { status: "invalid", fieldErrors: profileResult.fieldErrors };
    }

    const nameResult = await updateDisplayName({
      adminId: session.adminId,
      displayName: parsed.data.displayName,
    });
    if (nameResult.status === "invalid") {
      return { status: "invalid", fieldErrors: nameResult.fieldErrors };
    }
    if (nameResult.status === "not_found") {
      return unavailableAccount();
    }

    /* --- 7. Refresh every account-driven surface ------------------------------------- */
    revalidatePath("/settings/account");
    revalidatePath("/dashboard");
    revalidatePath("/settings/firms");

    return {
      status: "saved",
      message:
        logoUrl !== undefined
          ? removeLogo
            ? "Corporation profile updated — the default logo is restored."
            : "Corporation profile and logo updated."
          : "Corporation profile updated.",
    };
  } catch (err) {
    return mapProfileError(err);
  }
}

/* ============================================================================
 * EMAIL CHANGE — request code / confirm code / resend code
 * ==========================================================================*/

export async function requestEmailChangeAction(
  _prev: EmailChangeActionState,
  formData: FormData,
): Promise<EmailChangeActionState> {
  try {
    const session = await getSessionContext();
    if (!session) {
      return { status: "unauthorized", message: "Your session has expired. Please sign in again to continue." };
    }

    await assertTrustedMutation(formData);
    // Rate limiting for code issuance happens inside the service (hourly cap).

    const result = await requestEmailChange({
      adminId: session.adminId,
      newEmail: String(formData.get("newEmail") ?? ""),
    });

    switch (result.status) {
      case "requested":
        revalidatePath("/settings/account");
        return {
          status: "sent",
          message: `A confirmation code was sent to ${result.pending.newEmailMasked}. Enter it below to activate the new email.`,
          pendingEmail: result.pending,
        };
      case "invalid":
        return { status: "error", message: result.fieldErrors.email ?? "Enter a valid email address." };
      case "not_found":
        return unavailableAccount();
    }
  } catch (err) {
    return mapEmailChangeError(err);
  }
}

export async function confirmEmailChangeAction(
  _prev: EmailChangeActionState,
  formData: FormData,
): Promise<EmailChangeActionState> {
  try {
    const session = await getSessionContext();
    if (!session) {
      return { status: "unauthorized", message: "Your session has expired. Please sign in again to continue." };
    }

    await assertTrustedMutation(formData);
    // Verification-attempt rate limiting happens inside the service.

    const result = await confirmEmailChange({
      adminId: session.adminId,
      code: String(formData.get("code") ?? ""),
    });

    switch (result.status) {
      case "verified":
        revalidatePath("/settings/account");
        revalidatePath("/dashboard");
        revalidatePath("/settings/firms");
        return {
          status: "verified",
          message: `Your administrator email is now ${result.newEmail}.`,
          newEmail: result.newEmail,
        };
      case "expired":
        return {
          status: "error",
          message: "That confirmation code has expired. Request a new one and try again.",
        };
      case "too_many_attempts":
        return {
          status: "error",
          message: "Too many incorrect attempts for this code. Request a new one to continue.",
        };
      case "not_found":
        return {
          status: "error",
          message: "No pending email change was found. Start a new one by entering the new address above.",
        };
      case "invalid":
      default:
        return {
          status: "error",
          message: "Incorrect confirmation code. Check the email sent to the new address and try again.",
        };
    }
  } catch (err) {
    return mapEmailChangeError(err);
  }
}

export async function resendEmailChangeCodeAction(
  _prev: EmailChangeActionState,
  _formData: FormData,
): Promise<EmailChangeActionState> {
  try {
    const session = await getSessionContext();
    if (!session) {
      return { status: "unauthorized", message: "Your session has expired. Please sign in again to continue." };
    }

    await assertTrustedMutation(_formData);

    const result = await resendEmailChangeCode({ adminId: session.adminId });
    switch (result.status) {
      case "requested":
        revalidatePath("/settings/account");
        return {
          status: "sent",
          message: `A new confirmation code was sent to ${result.pending.newEmailMasked}.`,
          pendingEmail: result.pending,
        };
      case "not_found":
        return {
          status: "error",
          message: "No pending email change was found. Enter the new address above to start one.",
        };
    }
  } catch (err) {
    return mapEmailChangeError(err);
  }
}

/* ============================================================================
 * PASSWORD CHANGE
 * ==========================================================================*/

export async function changePasswordAction(
  _prev: PasswordActionState,
  formData: FormData,
): Promise<PasswordActionState> {
  try {
    /* --- Authorization ------------------------------------------------------ */
    const session = await getSessionContext();
    if (!session) {
      return { status: "unauthorized", message: "Your session has expired. Please sign in again." };
    }

    /* --- Origin + CSRF -------------------------------------------------------- */
    await assertTrustedMutation(formData);

    /* --- Rate limit ------------------------------------------------------------- */
    await enforceRateLimit(
      "account:password-change",
      RATE_LIMITS.passwordChange.limit,
      RATE_LIMITS.passwordChange.windowSeconds,
    );

    /* --- Validation ---------------------------------------------------------------- */
    const input = {
      currentPassword: String(formData.get("currentPassword") ?? ""),
      newPassword: String(formData.get("newPassword") ?? ""),
    };
    const confirmPassword = String(formData.get("confirmPassword") ?? "");
    const parsed = passwordChangeSchema.safeParse(input);
    if (!parsed.success) {
      return { status: "error", message: parsed.error.issues[0]?.message ?? "Enter a valid new password." };
    }
    if (confirmPassword !== parsed.data.newPassword) {
      return { status: "error", message: "The new password and the confirmation do not match." };
    }

    /* --- Delegate to the service layer (verify current, Argon2id, revoke others) ---- */
    const result = await changeAdminPassword({
      adminId: session.adminId,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      keepSessionId: session.sessionId,
    });

    switch (result.status) {
      case "changed":
        revalidatePath("/settings/account");
        return {
          status: "success",
          message: "Password updated. All other sessions have been signed out.",
        };
      case "wrong_current":
        return { status: "error", message: "Your current password is incorrect." };
      case "invalid":
        return { status: "error", message: result.message };
      case "not_found":
        return unavailableAccount();
    }
  } catch (err) {
    return mapPasswordError(err);
  }
}
