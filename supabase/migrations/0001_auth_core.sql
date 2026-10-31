-- ============================================================================
-- Niyojan Corporation — Centralized Financial & Billing Management System
-- Migration 0001 — PHASE 1: Secure Admin Authentication
-- ----------------------------------------------------------------------------
-- Tables   : admin_accounts, auth_attempts, auth_otp_challenges,
--            admin_sessions, security_lockouts, rate_limits
-- Functions: auth_lockout_state, auth_register_failure, auth_register_success,
--            auth_consume_otp, auth_invalidate_pending_otps,
--            auth_check_rate_limit, auth_cleanup_auth_data
--
-- SECURITY MODEL
--   * Row Level Security is ENABLED on every table and NO policies exist for
--     anon/authenticated — anonymous clients can never read or write
--     authentication data.
--   * All access flows through the service role (trusted server code only),
--     which bypasses RLS.
--   * All functions are SECURITY DEFINER with a pinned search_path and
--     EXECUTE revoked from PUBLIC / anon / authenticated, granted only to
--     service_role. Without the revokes, any anonymous API request could
--     invoke them.
--   * The global lockout counter and rate-limit counters are maintained with
--     single atomic UPSERT statements — concurrent requests cannot race past
--     the thresholds.
--   * All timestamps are TIMESTAMPTZ evaluated in UTC by the database server.
--
-- Apply via: Supabase SQL Editor (whole file) or `supabase db push`.
-- The file is idempotent and safe to re-run.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. admin_accounts — the single administrator identity.
--    Bootstrapped once from environment variables (credentials_source =
--    'env_bootstrap'); after any future password change from Account Settings
--    the row becomes 'database'-sourced and is never overwritten by the
--    environment again. Only Argon2id hashes are ever stored.
-- ----------------------------------------------------------------------------
create table if not exists public.admin_accounts (
  id                  uuid primary key default gen_random_uuid(),
  username            text not null unique,
  email               text not null unique,
  display_name        text not null,
  password_hash       text not null,
  credentials_source  text not null default 'env_bootstrap'
                        check (credentials_source in ('env_bootstrap', 'database')),
  password_updated_at timestamptz not null default now(),
  is_active           boolean not null default true,
  last_login_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. auth_attempts — append-only audit log of every authentication attempt.
--    NEVER stores passwords, OTP codes or hashes. Failed requests with an
--    unknown username keep admin_id NULL.
-- ----------------------------------------------------------------------------
create table if not exists public.auth_attempts (
  id                uuid primary key default gen_random_uuid(),
  attempt_type      text not null check (attempt_type in ('credential', 'otp')),
  outcome           text not null check (outcome in ('failure', 'success')),
  admin_id          uuid references public.admin_accounts (id) on delete set null,
  username_attempted text,
  ip_address        inet,
  user_agent        text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_auth_attempts_created on public.auth_attempts (created_at desc);
create index if not exists idx_auth_attempts_admin on public.auth_attempts (admin_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 3. auth_otp_challenges — one row per issued verification code.
--    code_hash is HMAC-SHA256(code, OTP_SECRET) — the plaintext code exists
--    only in the outgoing email and in memory. Single-use via consumed_at;
--    issuing a new OTP marks previous ones consumed.
-- ----------------------------------------------------------------------------
create table if not exists public.auth_otp_challenges (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid not null references public.admin_accounts (id) on delete cascade,
  code_hash    text not null check (char_length(code_hash) = 64),
  expires_at   timestamptz not null,
  attempts     integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_otp_challenges_admin on public.auth_otp_challenges (admin_id, created_at desc);
create index if not exists idx_otp_challenges_active on public.auth_otp_challenges (admin_id)
  where consumed_at is null;

-- ----------------------------------------------------------------------------
-- 4. admin_sessions — opaque server-side sessions. The cookie carries a
--    256-bit random token; only its SHA-256 hash is persisted, so a database
--    leak cannot be replayed as valid cookies.
-- ----------------------------------------------------------------------------
create table if not exists public.admin_sessions (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid not null references public.admin_accounts (id) on delete cascade,
  token_hash   text not null unique check (char_length(token_hash) = 64),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  ip_address   inet,
  user_agent   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_admin_sessions_admin on public.admin_sessions (admin_id);
create index if not exists idx_admin_sessions_expires on public.admin_sessions (expires_at);

-- ----------------------------------------------------------------------------
-- 5. security_lockouts — the GLOBAL authentication lockout state.
--    id 'GLOBAL' is the single row: the lockout applies to every device,
--    browser and IP address. Survives restarts and redeployments because it
--    lives in the database, not memory.
--    Policy (business rule, enforced in auth_register_failure):
--      * 4th CONSECUTIVE failed authentication attempt  -> 24h lockout
--      * only a COMPLETE successful authentication resets the counter
--      * failed requests can never extend or reset an active lockout timer
-- ----------------------------------------------------------------------------
create table if not exists public.security_lockouts (
  id                        text primary key default 'GLOBAL' check (id = 'GLOBAL'),
  consecutive_failures      integer not null default 0 check (consecutive_failures >= 0),
  locked_until              timestamptz,
  locked_at                 timestamptz,
  activated_by_failure_count integer,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 6. rate_limits — server-side distributed rate limiting (atomic counters).
--    Fixed-window counters keyed by action scope; shared across all server
--    instances through PostgreSQL, so limiting never depends on one process.
-- ----------------------------------------------------------------------------
create table if not exists public.rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  count        integer not null default 0 check (count >= 0),
  updated_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- updated_at maintenance trigger
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_admin_accounts_updated on public.admin_accounts;
create trigger trg_admin_accounts_updated before update on public.admin_accounts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_auth_otp_challenges_updated on public.auth_otp_challenges;
create trigger trg_auth_otp_challenges_updated before update on public.auth_otp_challenges
  for each row execute function public.set_updated_at();

drop trigger if exists trg_admin_sessions_updated on public.admin_sessions;
create trigger trg_admin_sessions_updated before update on public.admin_sessions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_security_lockouts_updated on public.security_lockouts;
create trigger trg_security_lockouts_updated before update on public.security_lockouts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_rate_limits_updated on public.rate_limits;
create trigger trg_rate_limits_updated before update on public.rate_limits
  for each row execute function public.set_updated_at();

-- ============================================================================
-- SECURITY DEFINER FUNCTIONS
-- Every function below:
--   * pins its search_path (prevents search_path hijacking),
--   * is revoked from PUBLIC / anon / authenticated at the end of this file,
--   * is granted ONLY to service_role (trusted server-side code).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- auth_lockout_state() — current GLOBAL lockout state (read).
-- ----------------------------------------------------------------------------
create or replace function public.auth_lockout_state()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_failures integer := 0;
  v_locked_until timestamptz;
begin
  select sl.consecutive_failures, sl.locked_until
    into v_failures, v_locked_until
    from public.security_lockouts as sl
    where sl.id = 'GLOBAL';

  return jsonb_build_object(
    'consecutive_failures', v_failures,
    'locked_until', to_jsonb(v_locked_until),
    'is_locked', v_locked_until is not null and v_locked_until > now()
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- auth_register_failure() — atomically count one failed authentication attempt
-- (credential OR OTP failure) and activate the 24h GLOBAL lockout on the 4th
-- consecutive failure. The UPSERT increment is a single atomic statement:
-- concurrent requests can never race past the threshold. While a lockout is
-- active the timer is neither extended nor reset — extra failures cannot
-- manipulate it.
-- ----------------------------------------------------------------------------
create or replace function public.auth_register_failure()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_failures   integer;
  v_locked_until timestamptz;
  v_was_locked boolean;
  v_activated  boolean := false;
begin
  insert into public.security_lockouts as sl
      (id, consecutive_failures, locked_until, created_at, updated_at)
  values ('GLOBAL', 1, null, now(), now())
  on conflict (id) do update
    set consecutive_failures = sl.consecutive_failures + 1,
        updated_at = now()
  returning sl.consecutive_failures, sl.locked_until
  into v_failures, v_locked_until;

  v_was_locked := v_locked_until is not null and v_locked_until > now();

  if v_failures >= 4 and not v_was_locked then
    update public.security_lockouts
      set locked_until = now() + interval '24 hours',
          locked_at = now(),
          activated_by_failure_count = v_failures,
          updated_at = now()
      where id = 'GLOBAL';
    v_locked_until := now() + interval '24 hours';
    v_activated := true;
  end if;

  return jsonb_build_object(
    'consecutive_failures', v_failures,
    'locked_until', to_jsonb(v_locked_until),
    'is_locked', v_locked_until is not null and v_locked_until > now(),
    'lockout_activated', v_activated
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- auth_register_success() — a COMPLETE successful authentication (valid
-- credentials AND valid OTP). Resets the consecutive-failure counter.
-- It deliberately NEVER touches locked_until: a locked system stays locked.
-- ----------------------------------------------------------------------------
create or replace function public.auth_register_success()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.security_lockouts as sl
      (id, consecutive_failures, locked_until, created_at, updated_at)
  values ('GLOBAL', 0, null, now(), now())
  on conflict (id) do update
    set consecutive_failures = 0,
        updated_at = now();

  return jsonb_build_object('consecutive_failures', 0, 'is_locked', false);
end;
$$;

-- ----------------------------------------------------------------------------
-- auth_consume_otp(p_challenge_id, p_admin_id, p_code_hash) — single-use,
-- atomic OTP verification. The challenge must belong to the administrator
-- bound into the signed pre-OTP cookie. The FOR UPDATE row lock serializes
-- concurrent verifications of the same challenge: the first correct code
-- consumes it and any racing request observes 'already_used'. Wrong codes
-- atomically increment the per-challenge attempt counter; after max_attempts
-- the challenge is dead.
-- ----------------------------------------------------------------------------
create or replace function public.auth_consume_otp(
  p_challenge_id uuid,
  p_admin_id uuid,
  p_code_hash text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rec public.auth_otp_challenges%rowtype;
begin
  if p_code_hash is null or char_length(p_code_hash) <> 64 then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into v_rec
    from public.auth_otp_challenges
    where id = p_challenge_id
      and admin_id = p_admin_id
    for update;

  if v_rec.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_rec.consumed_at is not null then
    return jsonb_build_object('status', 'already_used');
  end if;

  if v_rec.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  if v_rec.attempts >= v_rec.max_attempts then
    return jsonb_build_object('status', 'too_many_attempts');
  end if;

  if v_rec.code_hash <> p_code_hash then
    update public.auth_otp_challenges
      set attempts = attempts + 1
      where id = v_rec.id;
    return jsonb_build_object('status', 'invalid', 'attempts_used', v_rec.attempts + 1);
  end if;

  update public.auth_otp_challenges
    set consumed_at = now(),
        attempts = attempts + 1
    where id = v_rec.id and consumed_at is null;

  if not found then
    return jsonb_build_object('status', 'already_used');
  end if;

  return jsonb_build_object('status', 'verified');
end;
$$;

-- ----------------------------------------------------------------------------
-- auth_invalidate_pending_otps(p_admin_id) — issuing a new OTP immediately
-- invalidates every previous unconsumed challenge for that administrator.
-- ----------------------------------------------------------------------------
create or replace function public.auth_invalidate_pending_otps(
  p_admin_id uuid
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  update public.auth_otp_challenges
    set consumed_at = now()
    where admin_id = p_admin_id and consumed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ----------------------------------------------------------------------------
-- auth_check_rate_limit(p_key, p_limit, p_window_seconds) — atomic fixed-window
-- counter. A single UPSERT increments (or resets the window), so the decision
-- is race-free across processes and instances. Returns allowed=false with
-- retry_after_seconds once the limit is exceeded.
-- ----------------------------------------------------------------------------
create or replace function public.auth_check_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count        integer;
  v_window_start timestamptz;
begin
  if p_key is null or char_length(p_key) = 0 or char_length(p_key) > 128
     or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'invalid rate limit parameters';
  end if;

  insert into public.rate_limits as rl (key, window_start, count, updated_at)
  values (p_key, now(), 1, now())
  on conflict (key) do update
    set count = case
          when rl.window_start <= now() - make_interval(secs => p_window_seconds) then 1
          else rl.count + 1
        end,
        window_start = case
          when rl.window_start <= now() - make_interval(secs => p_window_seconds) then now()
          else rl.window_start
        end,
        updated_at = now()
  returning rl.count, rl.window_start
  into v_count, v_window_start;

  if v_count <= p_limit then
    return jsonb_build_object('allowed', true, 'count', v_count, 'retry_after_seconds', 0);
  end if;

  return jsonb_build_object(
    'allowed', false,
    'count', v_count,
    'retry_after_seconds',
    greatest(1, ceil(extract(epoch from (v_window_start + make_interval(secs => p_window_seconds) - now())))::integer)
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- auth_cleanup_auth_data(...) — operations housekeeping: purge revoked/expired
-- sessions, consumed/expired OTP challenges and old audit rows. Safe to run
-- repeatedly (e.g. via pg_cron: select auth_cleanup_auth_data(168, 720, 48)).
-- ----------------------------------------------------------------------------
create or replace function public.auth_cleanup_auth_data(
  p_session_retention_hours integer default 168,
  p_attempt_retention_hours integer default 720,
  p_challenge_retention_hours integer default 48
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_sessions integer := 0;
  v_attempts integer := 0;
  v_challenges integer := 0;
begin
  delete from public.admin_sessions
    where expires_at < now() - make_interval(secs => p_session_retention_hours * 3600)
       or (revoked_at is not null and revoked_at < now() - make_interval(secs => p_session_retention_hours * 3600));
  get diagnostics v_sessions = row_count;

  delete from public.auth_otp_challenges
    where (consumed_at is not null or expires_at < now())
      and updated_at < now() - make_interval(secs => p_challenge_retention_hours * 3600);
  get diagnostics v_challenges = row_count;

  delete from public.auth_attempts
    where created_at < now() - make_interval(secs => p_attempt_retention_hours * 3600);
  get diagnostics v_attempts = row_count;

  return jsonb_build_object(
    'sessions_deleted', v_sessions,
    'attempts_deleted', v_attempts,
    'challenges_deleted', v_challenges
  );
end;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY + PRIVILEGES
--   * RLS enabled, ZERO policies -> anon/authenticated are fully blocked.
--   * Only the service role (server-side trusted code) can touch these tables
--     and call the functions above.
-- ============================================================================

alter table public.admin_accounts      enable row level security;
alter table public.auth_attempts       enable row level security;
alter table public.auth_otp_challenges enable row level security;
alter table public.admin_sessions      enable row level security;
alter table public.security_lockouts   enable row level security;
alter table public.rate_limits         enable row level security;

-- No RLS policies are created on purpose.

-- Table privileges: service_role only.
grant select, insert, update, delete on public.admin_accounts      to service_role;
grant select, insert, delete          on public.auth_attempts      to service_role;
grant select, insert, update, delete on public.auth_otp_challenges to service_role;
grant select, insert, update, delete on public.admin_sessions      to service_role;
grant select, insert, update, delete on public.security_lockouts   to service_role;
grant select, insert, update, delete on public.rate_limits         to service_role;

revoke all privileges on public.admin_accounts      from anon, authenticated;
revoke all privileges on public.auth_attempts       from anon, authenticated;
revoke all privileges on public.auth_otp_challenges from anon, authenticated;
revoke all privileges on public.admin_sessions      from anon, authenticated;
revoke all privileges on public.security_lockouts   from anon, authenticated;
revoke all privileges on public.rate_limits         from anon, authenticated;

-- Function EXECUTE: critical — Postgres grants EXECUTE to PUBLIC by default,
-- which on Supabase would let ANY anonymous request invoke these functions.
revoke execute on function public.set_updated_at()                                from public, anon, authenticated;
revoke execute on function public.auth_lockout_state()                            from public, anon, authenticated;
revoke execute on function public.auth_register_failure()                         from public, anon, authenticated;
revoke execute on function public.auth_register_success()                         from public, anon, authenticated;
revoke execute on function public.auth_consume_otp(uuid, uuid, text)              from public, anon, authenticated;
revoke execute on function public.auth_invalidate_pending_otps(uuid)              from public, anon, authenticated;
revoke execute on function public.auth_check_rate_limit(text, integer, integer)   from public, anon, authenticated;
revoke execute on function public.auth_cleanup_auth_data(integer, integer, integer) from public, anon, authenticated;

grant execute on function public.auth_lockout_state()                            to service_role;
grant execute on function public.auth_register_failure()                         to service_role;
grant execute on function public.auth_register_success()                         to service_role;
grant execute on function public.auth_consume_otp(uuid, uuid, text)              to service_role;
grant execute on function public.auth_invalidate_pending_otps(uuid)              to service_role;
grant execute on function public.auth_check_rate_limit(text, integer, integer)   to service_role;
grant execute on function public.auth_cleanup_auth_data(integer, integer, integer) to service_role;
