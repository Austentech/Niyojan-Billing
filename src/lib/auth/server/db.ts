import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/config/env";
import { SystemAuthError } from "@/lib/auth/errors";

/**
 * Supabase service-role client — SERVER SIDE ONLY.
 *
 * The service role key bypasses Row Level Security; it must never reach the
 * browser (no NEXT_PUBLIC_ prefix, never serialized into client props).
 * Every query in this application goes through this client or the SECURITY
 * DEFINER RPC functions, which are executable by service_role alone.
 *
 * Instantiated lazily so `next build` never requires live credentials.
 */

let serviceClient: SupabaseClient | null = null;
let clientKey = "";

export function getSupabaseServiceClient(): SupabaseClient {
  const env = getServerEnv();
  // Rebuild when the connection inputs change (env reload after a harness
  // key re-mint) — never serve a client built from stale credentials.
  const key = `${env.NEXT_PUBLIC_SUPABASE_URL}|${env.SUPABASE_SERVICE_ROLE_KEY}`;
  if (serviceClient && clientKey === key) return serviceClient;

  serviceClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // Server-side data access only — no user/session persistence.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "X-Client-Info": "niyojan-admin-auth/1.0" },
    },
  });

  return serviceClient;
}

/** Map a Supabase/PostgREST error to a SystemAuthError without leaking detail. */
export function dbSystemError(operation: string, error: { message?: string; code?: string } | null): SystemAuthError {
  return new SystemAuthError(
    `supabase ${operation} failed${error?.code ? ` (code ${error.code})` : ""}`,
  );
}
