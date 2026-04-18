import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { NextResponse, type NextRequest } from "next/server"

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get("code")
  const next = searchParams.get("next") ?? "/admin/videos"

  // Use request.nextUrl as the base — Next.js resolves this to the
  // public-facing host, avoiding the internal localhost address that
  // request.url can expose behind proxies (Vercel, Railway, etc.)
  const base = request.nextUrl

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          },
        },
      }
    )
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Upsert owner record so the first Google login auto-provisions the tenant.
      // Non-fatal: if it fails the user is still logged in; they can retry later.
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          await supabase.from("owners").upsert(
            {
              id: user.id,
              email: user.email ?? "",
              name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? "",
            },
            { onConflict: "id" }
          )
        }
      } catch {
        // ignore — owner row creation is best-effort
      }

      const redirectUrl = base.clone()
      redirectUrl.pathname = next
      redirectUrl.search = ""
      return NextResponse.redirect(redirectUrl)
    }
  }

  const errorUrl = base.clone()
  errorUrl.pathname = "/login"
  errorUrl.search = "?error=auth_failed"
  return NextResponse.redirect(errorUrl)
}
