-- ============================================================================
-- Niyojan Corporation — Centralized Financial & Billing Management System
-- Migration 0003 — PHASE 3: Account Settings
-- ----------------------------------------------------------------------------
-- Tables   : corporation_profile, email_change_requests
-- Storage  : corporation-logos bucket (Supabase Storage, created only when the
--            storage schema exists — skipped by the local verification harness)
-- Functions: account_consume_email_change, account_invalidate_pending_email_changes
--
-- ARCHITECTURE
--   * The corporation profile (name, logo) is stored COMPLETELY SEPARATELY
--     from the authentication configuration in admin_accounts. The only
--     identity fields that remain on admin_accounts are the sign-in identity
--     (username, password, email) and the administrator display name — none
--     of them corporation-branding data.
--   * Administrator email changes are VERIFICATION-GATED: a new address only
--     becomes active after an 8-character code emailed to that address is
--     consumed atomically by account_consume_email_change(). The function
--     verifies the code AND swaps the email in one transaction — the address
--     can never flip without a fully verified request.
--
-- SECURITY MODEL (mirrors 0001/0002)
--   * Row Level Security ENABLED, ZERO policies -> anon/authenticated get
--     nothing. All access flows through the service role (trusted server
--     code only).
--   * SECURITY DEFINER functions pin their search_path, are revoked from
--     PUBLIC / anon / authenticated and granted only to service_role.
--   * Only the HMAC-SHA256 hash of a verification code is stored — never the
--     plaintext (identical guarantee to auth_otp_challenges).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. corporation_profile — the single corporation profile row (id 'CORPORATION').
--    Seeded lazily by the application from the brand defaults; every surface
--    that shows the corporation name/logo renders from this row.
-- ----------------------------------------------------------------------------
create table if not exists public.corporation_profile (
  id                text primary key default 'CORPORATION' check (id = 'CORPORATION'),
  corporation_name  text not null
                      check (char_length(btrim(corporation_name)) between 2 and 120),
  logo_url          text
                      check (logo_url is null or (char_length(logo_url) between 1 and 2048)),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. email_change_requests — one row per issued email-verification code.
--    The code is emailed to the NEW address; only a successful
--    account_consume_email_change() swaps admin_accounts.email. Issuing a new
--    request invalidates every previous unconsumed one.
-- ----------------------------------------------------------------------------
create table if not exists public.email_change_requests (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null references public.admin_accounts (id) on delete cascade,
  new_email     text not null
                  check (char_length(btrim(new_email)) between 3 and 254),
  code_hash     text not null check (char_length(code_hash) = 64),
  expires_at    timestamptz not null,
  attempts      integer not null default 0 check (attempts >= 0),
  max_attempts  integer not null default 5 check (max_attempts between 1 and 10),
  consumed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_email_change_admin on public.email_change_requests (admin_id, created_at desc);
create index if not exists idx_email_change_active on public.email_change_requests (admin_id)
  where consumed_at is null;

-- ----------------------------------------------------------------------------
-- 3. updated_at maintenance (trigger function was created by migration 0001).
-- ----------------------------------------------------------------------------
drop trigger if exists trg_corporation_profile_updated on public.corporation_profile;
create trigger trg_corporation_profile_updated before update on public.corporation_profile
  for each row execute function public.set_updated_at();

drop trigger if exists trg_email_change_requests_updated on public.email_change_requests;
create trigger trg_email_change_requests_updated before update on public.email_change_requests
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. account_consume_email_change(p_admin_id, p_code_hash) — atomic, single-use
--    verification of an administrator email change. Operates on the LATEST
--    unconsumed request for that administrator. The FOR UPDATE row lock
--    serializes concurrent verifications; the first correct code consumes the
--    request AND activates the new email inside the SAME transaction. Wrong
--    codes atomically burn an attempt; after max_attempts the request is dead.
-- ----------------------------------------------------------------------------
create or replace function public.account_consume_email_change(
  p_admin_id uuid,
  p_code_hash text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_rec public.email_change_requests%rowtype;
begin
  if p_code_hash is null or char_length(p_code_hash) <> 64 then
    return jsonb_build_object('status', 'invalid');
  end if;

  select * into v_rec
    from public.email_change_requests
    where admin_id = p_admin_id
      and consumed_at is null
    order by created_at desc
    limit 1
    for update;

  if v_rec.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_rec.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  if v_rec.attempts >= v_rec.max_attempts then
    return jsonb_build_object('status', 'too_many_attempts');
  end if;

  if v_rec.code_hash <> p_code_hash then
    update public.email_change_requests
      set attempts = attempts + 1
      where id = v_rec.id;
    return jsonb_build_object('status', 'invalid', 'attempts_used', v_rec.attempts + 1);
  end if;

  -- Correct code: consume the request, retire every other pending request and
  -- activate the new email — one atomic transaction.
  update public.email_change_requests
    set consumed_at = now(),
        attempts = attempts + 1
    where id = v_rec.id and consumed_at is null;

  if not found then
    return jsonb_build_object('status', 'already_used');
  end if;

  update public.email_change_requests
    set consumed_at = now()
    where admin_id = p_admin_id
      and consumed_at is null
      and id <> v_rec.id;

  update public.admin_accounts
    set email = v_rec.new_email,
        updated_at = now()
    where id = p_admin_id;

  return jsonb_build_object('status', 'verified', 'new_email', v_rec.new_email);
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. account_invalidate_pending_email_changes(p_admin_id) — issuing a new
--    email-verification request immediately retires every previous unconsumed
--    request for that administrator.
-- ----------------------------------------------------------------------------
create or replace function public.account_invalidate_pending_email_changes(
  p_admin_id uuid
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  update public.email_change_requests
    set consumed_at = now()
    where admin_id = p_admin_id and consumed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. corporation-logos storage bucket (Supabase only).
--    Public read (brand asset served from public URLs); writes are performed
--    exclusively by the service role from server-side code, with MIME-type and
--    size limits enforced at the bucket level as well as in the application
--    (magic-byte sniffing) — belt and braces.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'corporation-logos',
      'corporation-logos',
      true,
      2097152, -- 2 MiB
      array['image/png', 'image/jpeg', 'image/webp']::text[]
    )
    on conflict (id) do nothing;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Row Level Security + privileges — service role only.
-- ----------------------------------------------------------------------------
alter table public.corporation_profile    enable row level security;
alter table public.email_change_requests  enable row level security;

-- No RLS policies are created on purpose: anon/authenticated get nothing.

grant select, insert, update, delete on public.corporation_profile   to service_role;
grant select, insert, update, delete on public.email_change_requests to service_role;

revoke all privileges on public.corporation_profile   from anon, authenticated;
revoke all privileges on public.email_change_requests from anon, authenticated;

-- Function EXECUTE: critical — without these revokes any anonymous API
-- request could invoke the security-definer functions.
revoke execute on function public.account_consume_email_change(uuid, text)          from public, anon, authenticated;
revoke execute on function public.account_invalidate_pending_email_changes(uuid)   from public, anon, authenticated;

grant execute on function public.account_consume_email_change(uuid, text)          to service_role;
grant execute on function public.account_invalidate_pending_email_changes(uuid)   to service_role;
