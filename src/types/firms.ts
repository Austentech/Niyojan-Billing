/**
 * Client-visible server-action states (Phase 2 — firm management).
 * Serialized across the server/client boundary — must stay free of any
 * server-only imports. Contains ONLY safe display information.
 *
 * Account-settings action states live in src/types/account.ts (Phase 3).
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
