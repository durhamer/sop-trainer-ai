"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

const navItems = [
  { href: "/admin/videos", label: "影片管理" },
  { href: "/admin/sops", label: "SOP 列表" },
  { href: "/admin/employees", label: "員工管理" },
  { href: "/admin/faq", label: "FAQ 管理" },
  { href: "/admin/progress", label: "訓練進度" },
]

export function AdminSidebar() {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    toast.success("已登出")
    router.push("/login")
    router.refresh()
  }

  return (
    <aside className="w-56 shrink-0 border-r bg-white flex flex-col">
      <div className="px-6 py-5 border-b">
        <h1 className="text-base font-semibold leading-tight">
          SOP Trainer AI
          <span className="block text-xs font-normal text-zinc-500 mt-0.5">管理後台</span>
        </h1>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "block rounded-md px-3 py-2 text-sm font-medium transition-colors",
              pathname.startsWith(item.href)
                ? "bg-zinc-900 text-white"
                : "text-zinc-700 hover:bg-zinc-100"
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="p-3 border-t">
        <button
          onClick={handleSignOut}
          className="w-full rounded-md px-3 py-2 text-sm font-medium text-zinc-500 hover:bg-zinc-100 text-left transition-colors"
        >
          登出
        </button>
      </div>
    </aside>
  )
}
