import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Niyojan Corporation — complete database schema (Drizzle ORM).
 *
 *   * Every table has a UUID primary key (or the documented fixed single-row
 *     key) and UTC timestamptz created_at/updated_at columns.
 *   * `updated_at` is maintained by the set_updated_at() trigger created in
 *     migration 0000 — the database, not the application, owns it.
 *   * CHECK constraints mirror the application-level Zod validation
 *     (defense in depth).
 *   * The atomic SECURITY DEFINER functions (lockout counting, OTP
 *     consumption, rate limiting, email-change confirmation) are created in
 *     migration 0000 and invoked through parameterized SQL — they are the
 *     race-free heart of the security engine.
 *
 * Timestamps are read as JS Date objects and converted to ISO strings at the
 * data-access layer, so every service type keeps speaking ISO 8601 UTC.
 */

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/* ============================================================================
 * 1. admin_accounts — the single administrator identity.
 *    Bootstrapped once from environment variables (credentials_source =
 *    'env_bootstrap'); after any password change from Account Settings the
 *    row becomes 'database'-sourced and is never overwritten again. Only
 *    Argon2id hashes are ever stored.
 * ==========================================================================*/

export const adminAccounts = pgTable(
  "admin_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    username: text("username").notNull().unique(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    credentialsSource: text("credentials_source").notNull().default("env_bootstrap"),
    passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    check("admin_accounts_credentials_source_check", sql`${t.credentialsSource} in ('env_bootstrap', 'database')`),
  ],
);

/* ============================================================================
 * 2. auth_attempts — append-only audit log of every authentication attempt.
 *    NEVER stores passwords, OTP codes or hashes.
 * ==========================================================================*/

export const authAttempts = pgTable(
  "auth_attempts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    attemptType: text("attempt_type").notNull(),
    outcome: text("outcome").notNull(),
    adminId: uuid("admin_id").references(() => adminAccounts.id, { onDelete: "set null" }),
    usernameAttempted: text("username_attempted"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt,
  },
  (t) => [
    check("auth_attempts_attempt_type_check", sql`${t.attemptType} in ('credential', 'otp')`),
    check("auth_attempts_outcome_check", sql`${t.outcome} in ('failure', 'success')`),
    index("idx_auth_attempts_created").on(t.createdAt.desc()),
    index("idx_auth_attempts_admin").on(t.adminId, t.createdAt.desc()),
  ],
);

/* ============================================================================
 * 3. security_audit_logs — append-only audit trail of significant security
 *    EVENTS (successful logins, lockouts, password changes, profile writes).
 *    Complements auth_attempts (raw attempt outcomes) with sanitized event
 *    metadata. Never stores secrets, codes, hashes or credentials.
 * ==========================================================================*/

export const securityAuditLogs = pgTable(
  "security_audit_logs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    event: text("event").notNull(),
    actorAdminId: uuid("actor_admin_id").references(() => adminAccounts.id, { onDelete: "set null" }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Sanitized scalar metadata only — enforced by the writing layer. */
    detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>(),
    createdAt,
  },
  (t) => [
    index("idx_security_audit_logs_created").on(t.createdAt.desc()),
    index("idx_security_audit_logs_actor").on(t.actorAdminId, t.createdAt.desc()),
  ],
);

/* ============================================================================
 * 4. auth_otp_challenges — one row per issued verification code.
 *    code_hash is HMAC-SHA256(code, OTP_SECRET); single-use via consumed_at;
 *    issuing a new OTP marks previous ones consumed.
 * ==========================================================================*/

export const authOtpChallenges = pgTable(
  "auth_otp_challenges",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => adminAccounts.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    check("auth_otp_challenges_code_hash_check", sql`char_length(${t.codeHash}) = 64`),
    check("auth_otp_challenges_attempts_check", sql`${t.attempts} >= 0`),
    check("auth_otp_challenges_max_attempts_check", sql`${t.maxAttempts} between 1 and 10`),
    index("idx_otp_challenges_admin").on(t.adminId, t.createdAt.desc()),
    index("idx_otp_challenges_active").on(t.adminId).where(sql`consumed_at is null`),
  ],
);

/* ============================================================================
 * 5. admin_sessions — opaque server-side sessions. The cookie carries a
 *    256-bit random token; only its SHA-256 hash is persisted.
 * ==========================================================================*/

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => adminAccounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt,
    updatedAt,
  },
  (t) => [
    check("admin_sessions_token_hash_check", sql`char_length(${t.tokenHash}) = 64`),
    index("idx_admin_sessions_admin").on(t.adminId),
    index("idx_admin_sessions_expires").on(t.expiresAt),
  ],
);

/* ============================================================================
 * 6. security_lockouts — the GLOBAL authentication lockout state.
 *    id 'GLOBAL' is the single row: the lockout applies to every device,
 *    browser and IP address and survives redeploys because it lives in the
 *    database. 4th consecutive failure -> 24h lockout (see migration 0000).
 * ==========================================================================*/

export const securityLockouts = pgTable(
  "security_lockouts",
  {
    id: text("id").primaryKey().default("GLOBAL"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    activatedByFailureCount: integer("activated_by_failure_count"),
    createdAt,
    updatedAt,
  },
  (t) => [
    check("security_lockouts_id_check", sql`${t.id} = 'GLOBAL'`),
    check("security_lockouts_consecutive_failures_check", sql`${t.consecutiveFailures} >= 0`),
  ],
);

/* ============================================================================
 * 7. rate_limits — server-side distributed rate limiting (atomic counters).
 *    Fixed-window counters keyed by action scope, shared across all server
 *    instances through PostgreSQL.
 * ==========================================================================*/

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    count: integer("count").notNull().default(0),
    updatedAt,
  },
  (t) => [check("rate_limits_count_check", sql`${t.count} >= 0`)],
);

/* ============================================================================
 * 8. firms — the business entities operating under Niyojan Corporation.
 *    Every firm card renders exclusively from this table. The UUID primary
 *    key is the stable anchor future modules (billing, GST, accounting) will
 *    reference.
 * ==========================================================================*/

export const firms = pgTable(
  "firms",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    firmName: text("firm_name").notNull(),
    logoUrl: text("logo_url"),
    websiteUrl: text("website_url"),
    holdingPercentage: numeric("holding_percentage", { precision: 5, scale: 2 }).notNull(),
    address: text("address").notNull(),
    description: text("description"),
    createdAt,
    updatedAt,
  },
  (t) => [
    check("firms_firm_name_check", sql`char_length(btrim(${t.firmName})) between 2 and 120`),
    check("firms_logo_url_check", sql`${t.logoUrl} is null or (char_length(${t.logoUrl}) between 1 and 2048)`),
    check("firms_website_url_check", sql`${t.websiteUrl} is null or (${t.websiteUrl} ~ '^https?://')`),
    check(
      "firms_holding_percentage_check",
      sql`${t.holdingPercentage} >= 0 and ${t.holdingPercentage} <= 100`,
    ),
    check("firms_address_check", sql`char_length(btrim(${t.address})) between 5 and 200`),
    check("firms_description_check", sql`${t.description} is null or char_length(${t.description}) <= 1000`),
    index("idx_firms_created_at").on(t.createdAt.asc()),
    index("idx_firms_firm_name").on(t.firmName),
  ],
);

/* ============================================================================
 * 9. corporation_profile — the single corporation profile row (id
 *    'CORPORATION'), stored COMPLETELY SEPARATELY from the authentication
 *    configuration. Seeded lazily by the application from brand defaults.
 * ==========================================================================*/

export const corporationProfile = pgTable(
  "corporation_profile",
  {
    id: text("id").primaryKey().default("CORPORATION"),
    corporationName: text("corporation_name").notNull(),
    logoUrl: text("logo_url"),
    createdAt,
    updatedAt,
  },
  (t) => [
    check("corporation_profile_id_check", sql`${t.id} = 'CORPORATION'`),
    check(
      "corporation_profile_name_check",
      sql`char_length(btrim(${t.corporationName})) between 2 and 120`,
    ),
    check(
      "corporation_profile_logo_url_check",
      sql`${t.logoUrl} is null or (char_length(${t.logoUrl}) between 1 and 2048)`,
    ),
  ],
);

/* ============================================================================
 * 10. email_change_requests — one row per issued email-verification code.
 *     Only the HMAC-SHA256 hash is stored; account_consume_email_change()
 *     verifies the code AND swaps admin_accounts.email atomically.
 * ==========================================================================*/

export const emailChangeRequests = pgTable(
  "email_change_requests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => adminAccounts.id, { onDelete: "cascade" }),
    newEmail: text("new_email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    check("email_change_requests_new_email_check", sql`char_length(btrim(${t.newEmail})) between 3 and 254`),
    check("email_change_requests_code_hash_check", sql`char_length(${t.codeHash}) = 64`),
    check("email_change_requests_attempts_check", sql`${t.attempts} >= 0`),
    check("email_change_requests_max_attempts_check", sql`${t.maxAttempts} between 1 and 10`),
    index("idx_email_change_admin").on(t.adminId, t.createdAt.desc()),
    index("idx_email_change_active").on(t.adminId).where(sql`consumed_at is null`),
  ],
);
