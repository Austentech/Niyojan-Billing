/**
 * Client-visible server-action states (Phase 2 — firm management and account
 * settings). Serialized across the server/client boundary — must stay free of
 * any server-only imports. Contains ONLY safe display information.
 */

export type FirmActionState =
  | { status: "idle" }
  /** Server-side validation rejected one or more fields (field -> message). */
  | { status: "invalid"; fieldErrors: Record<string, string> }
  /** Firm created successfully — the lists refresh via revalidation. */
  | { status: "created"; firmName: string }
  /** No valid administrator session. */
  | { status: "unauthorized"; message: string }
  /** Origin/CSRF/rate-limit rejection. */
  | { status: "blocked"; message: string; retryAfterSeconds?: number }
  /** Transient system failure (database/storage unreachable). */
  | { status: "unavailable"; message: string }
  /** Server environment not yet configured. */
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
