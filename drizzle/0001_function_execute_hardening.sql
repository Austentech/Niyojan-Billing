-- ============================================================================
-- Niyojan Corporation — migration 0001 (function EXECUTE hardening)
-- ----------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE on functions to PUBLIC by default. The security
-- engine functions below manipulate authentication state (lockout counters,
-- OTP consumption, rate limiting, email changes) — they must be executable
-- ONLY by the application's database role, never by any unprivileged role.
--
-- Defense in depth for the plain-PostgreSQL architecture (no Supabase roles):
-- the browser never holds database credentials and no public DB surface
-- exists; these revokes ensure that even a future unprivileged role cannot
-- invoke the security engine directly.
-- ============================================================================

revoke execute on function public.set_updated_at() from public;--> statement-breakpoint
revoke execute on function public.auth_lockout_state() from public;--> statement-breakpoint
revoke execute on function public.auth_register_failure() from public;--> statement-breakpoint
revoke execute on function public.auth_register_success() from public;--> statement-breakpoint
revoke execute on function public.auth_consume_otp(uuid, uuid, text) from public;--> statement-breakpoint
revoke execute on function public.auth_invalidate_pending_otps(uuid) from public;--> statement-breakpoint
revoke execute on function public.auth_check_rate_limit(text, integer, integer) from public;--> statement-breakpoint
revoke execute on function public.auth_cleanup_auth_data(integer, integer, integer) from public;--> statement-breakpoint
revoke execute on function public.account_consume_email_change(uuid, text) from public;--> statement-breakpoint
revoke execute on function public.account_invalidate_pending_email_changes(uuid) from public;
