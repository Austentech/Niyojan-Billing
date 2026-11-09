/**
 * Client-visible server-action states (Phase 3 — account settings).
 * Serialized across the server/client boundary — must stay free of any
 * server-only imports. Contains ONLY safe display information.
 */

export type ProfileActionState =
  | { status: "idle" }
  /** Server-side validation rejected one or more fields (field -> message). */
  | { status: "invalid"; fieldErrors: Record<string, string> }
  /**
   * Profile saved. When an email change was requested, `pendingEmail`
   * carries the masked new address and code expiry for the confirmation UI.
   */
  | {
      status: "saved";
      message: string;
      pendingEmail?: {
        newEmailMasked: string;
        expiresAt: string;
        resendCooldownSeconds: number;
      };
    }
  /** No valid administrator session. */
  | { status: "unauthorized"; message: string }
  /** Origin/CSRF/rate-limit/cooldown rejection. */
  | { status: "blocked"; message: string; retryAfterSeconds?: number }
  /** Transient system failure (database/storage unreachable). */
  | { status: "unavailable"; message: string }
  /** Server environment not yet configured. */
  | { status: "config_error"; message: string };

export type EmailChangeActionState =
  | { status: "idle" }
  /** Wrong / expired / exhausted confirmation code. */
  | { status: "error"; message: string }
  /** Code verified — the new email is now active. */
  | { status: "verified"; message: string; newEmail: string }
  /** A new code was sent (resend). */
  | {
      status: "sent";
      message: string;
      pendingEmail: { newEmailMasked: string; expiresAt: string; resendCooldownSeconds: number };
    }
  | { status: "unauthorized"; message: string }
  | { status: "blocked"; message: string; retryAfterSeconds?: number }
  | { status: "unavailable"; message: string }
  | { status: "config_error"; message: string };

export type PasswordActionState =
  | { status: "idle" }
  /** Validation rejection or wrong current password. */
  | { status: "error"; message: string }
  /** Password updated (other sessions revoked). */
  | { status: "success"; message: string }
  | { status: "unauthorized"; message: string }
  | { status: "blocked"; message: string; retryAfterSeconds?: number }
  | { status: "unavailable"; message: string }
  | { status: "config_error"; message: string };
