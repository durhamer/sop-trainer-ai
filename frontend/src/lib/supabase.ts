import { createBrowserClient } from "@supabase/ssr"
import { Database } from "./types"

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

/**
 * Supabase client for employee-facing pages (/train/**).
 *
 * Employee pages use PIN auth (no Supabase session). When an admin is also
 * logged in on the same browser, supabase-js would normally send their auth
 * cookie, causing queries to run as `authenticated` role and hitting the
 * owner-scoped RLS policies instead of the anon policies. This client opts
 * out of session persistence entirely so it always queries as `anon`,
 * regardless of any admin session that may exist in the browser.
 */
export function createAnonClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  )
}
