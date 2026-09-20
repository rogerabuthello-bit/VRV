import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

let cached: SupabaseClient | null = null;

/**
 * Service-role client. It bypasses RLS, so it must never be reachable from the
 * browser: every call is made from /api/rpc after the caller's JWT is checked.
 */
export function db(): SupabaseClient {
  if (!cached) {
    cached = createClient(env.supabaseUrl, env.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return cached;
}
