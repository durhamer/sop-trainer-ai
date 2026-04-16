"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  clearEmployeeSession,
  EmployeeSession,
  getEmployeeSession,
} from "@/lib/employee-session"
import { createClient } from "@/lib/supabase"
import { Sop } from "@/lib/types"
import { t } from "@/lib/i18n"
import { backendUrl } from "@/lib/backend"

type SopWithSteps = Sop & { sop_steps: { id: string }[] }

type ProgressRecord = {
  sop_id: string
  current_step: number
  completed_steps: number[]
  completed_at: string | null
}

function estimatedMinutes(stepCount: number): number {
  return Math.max(5, Math.ceil(stepCount * 2))
}

function ProgressBadge({
  progress,
  totalSteps,
}: {
  progress: ProgressRecord | undefined
  totalSteps: number
}) {
  if (!progress) {
    return (
      <span className="text-base text-slate-400">{t("progress.notStarted")}</span>
    )
  }
  if (progress.completed_at) {
    return (
      <span className="text-base font-medium text-emerald-600">
        {t("progress.completed")}
      </span>
    )
  }
  return (
    <span className="text-base text-amber-600">
      {t("progress.inProgress", {
        done: String(progress.completed_steps?.length ?? 0),
        total: String(totalSteps),
      })}
    </span>
  )
}

export default function TrainContent() {
  const [session, setSession] = useState<EmployeeSession | null>(null)
  const [sops, setSops] = useState<SopWithSteps[]>([])
  const [progressMap, setProgressMap] = useState<Map<string, ProgressRecord>>(new Map())
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const emp = getEmployeeSession()
    if (!emp) {
      router.replace("/train/login")
      return
    }
    setSession(emp)

    Promise.all([
      supabase
        .from("sops")
        .select("*, sop_steps(id)")
        .eq("published", true)
        .order("created_at", { ascending: false }),
      fetch(`${backendUrl}/api/progress/${emp.id}`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [] as ProgressRecord[]),
    ]).then(([{ data }, progressList]) => {
      setSops((data ?? []) as SopWithSteps[])
      const map = new Map<string, ProgressRecord>(
        (progressList as ProgressRecord[]).map((p) => [p.sop_id, p])
      )
      setProgressMap(map)
      setLoading(false)
    })
  }, [])

  function handleLogout() {
    clearEmployeeSession()
    router.push("/train/login")
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-3xl text-slate-400">{t("train.loading")}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-4 sm:px-10 sm:py-6 bg-white border-b border-slate-200">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t("train.pageTitle")}</h1>
          <p className="text-base sm:text-xl text-slate-500 mt-0.5 sm:mt-1">
            {t("train.greeting", { name: session?.name ?? "" })}
          </p>
        </div>
        <button
          onClick={handleLogout}
          className="min-h-[44px] px-4 py-2 sm:px-6 sm:py-3 rounded-2xl
                     text-base sm:text-xl text-slate-500 hover:bg-slate-100 transition-colors"
        >
          {t("train.logout")}
        </button>
      </header>

      {/* Module grid */}
      <main className="flex-1 p-4 sm:p-10">
        {sops.length === 0 ? (
          <div className="flex items-center justify-center h-full min-h-[50vh]">
            <p className="text-2xl sm:text-3xl text-slate-400">{t("train.empty")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-6">
            {sops.map((sop) => {
              const stepCount = sop.sop_steps.length
              const minutes = estimatedMinutes(stepCount)
              const progress = progressMap.get(sop.id)
              const isCompleted = !!progress?.completed_at
              return (
                <button
                  key={sop.id}
                  onClick={() => router.push(`/train/${sop.id}`)}
                  className={[
                    "text-left p-5 sm:p-8 rounded-3xl bg-white shadow-sm border-2 transition-all",
                    "hover:shadow-md active:scale-[0.98] cursor-pointer w-full",
                    isCompleted
                      ? "border-emerald-200 hover:border-emerald-300"
                      : "border-transparent hover:border-slate-300",
                  ].join(" ")}
                >
                  <h2 className="text-xl sm:text-2xl font-bold leading-snug mb-2 sm:mb-3">
                    {sop.title}
                  </h2>
                  <div className="flex items-center gap-2 sm:gap-3 text-base sm:text-lg text-slate-500 mb-2 sm:mb-3">
                    <span>{t("train.stepCount", { count: stepCount })}</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />
                    <span>{t("train.estimatedTime", { minutes })}</span>
                  </div>
                  <ProgressBadge progress={progress} totalSteps={stepCount} />
                </button>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
