-- ============================================================================
-- Niyojan Corporation — Centralized Financial & Billing Management System
-- Migration 0002 — PHASE 2: Dashboard & Firm Management
-- ----------------------------------------------------------------------------
-- Tables   : firms
-- Storage  : firm-logos bucket (Supabase Storage, created only when the
--            storage schema exists — i.e. on Supabase; skipped by the local
--            verification harness, which uses its filesystem adapter)
--
-- FUTURE-READY ARCHITECTURE
--   * Every firm is identified by a stable UUID primary key. Future modules
--     (billing, invoicing, GST, income & expenses, transactions, reports,
--     firm-wise accounting) will reference firms(id) — they are NOT part of
--     this migration and are deliberately not implemented in this phase.
--
-- SECURITY MODEL (mirrors 0001_auth_core.sql)
--   * Row Level Security is ENABLED with NO policies for anon/authenticated —
--     anonymous clients can never read or write firm data. All access flows
--     through the service role (trusted server-side code only).
--   * Column CHECK constraints mirror the application-level Zod validation
--     (defense in depth): name/address lengths, holding range, URL scheme.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. firms — the business entities operating under Niyojan Corporation.
--    All firm cards on the dashboard and the firm-management list are rendered
--    exclusively from this table (never from frontend code).
-- ----------------------------------------------------------------------------
create table if not exists public.firms (
  id                  uuid primary key default gen_random_uuid(),
  firm_name           text not null
                        check (char_length(btrim(firm_name)) between 2 and 120),
  logo_url            text
                        check (logo_url is null or (char_length(logo_url) between 1 and 2048)),
  website_url         text
                        check (website_url is null or (website_url ~ '^https?://')),
  holding_percentage  numeric(5, 2) not null
                        check (holding_percentage >= 0 and holding_percentage <= 100),
  address             text not null
                        check (char_length(btrim(address)) between 5 and 200),
  description         text
                        check (description is null or char_length(description) <= 1000),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Listing order (creation order) + name lookups for future modules.
create index if not exists idx_firms_created_at on public.firms (created_at asc);
create index if not exists idx_firms_firm_name on public.firms (firm_name);

-- updated_at maintenance (trigger function was created by migration 0001).
drop trigger if exists trg_firms_updated on public.firms;
create trigger trg_firms_updated before update on public.firms
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. firm-logos storage bucket (Supabase only).
--    Public read (logos are brand assets served from public URLs); writes are
--    performed exclusively by the service role from server-side code, with
--    MIME-type and size limits enforced at the bucket level as well as in the
--    application (magic-byte sniffing) — belt and braces.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'firm-logos',
      'firm-logos',
      true,
      2097152, -- 2 MiB
      array['image/png', 'image/jpeg', 'image/webp']::text[]
    )
    on conflict (id) do nothing;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Row Level Security + privileges — service role only.
-- ----------------------------------------------------------------------------
alter table public.firms enable row level security;

-- No RLS policies are created on purpose: anon/authenticated get nothing.

grant select, insert, update, delete on public.firms to service_role;
revoke all privileges on public.firms from anon, authenticated;
