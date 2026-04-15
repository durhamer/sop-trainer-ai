"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { getEmployeeSession } from "@/lib/employee-session"
import { createClient } from "@/lib/supabase"
import { Sop, SopStep } from "@/lib/types"
import { t } from "@/lib/i18n"
import ChatPanel from "./chat-panel"
import { backendUrl } from "@/lib/backend"

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function WarningBanner({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 px-5 py-4 rounded-2xl bg-red-50 border border-red-200">
      <span className="text-red-500 text-2xl leading-none shrink-0 mt-0.5">⚠</span>
      <p className="text-xl leading-snug text-red-700">{text}</p>
    </div>
  )
}

function NavButton({
  onClick,
  disabled,
  primary,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        "min-h-[56px] px-10 rounded-2xl text-xl font-semibold",
        "transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed",
        primary
          ? "bg-slate-800 text-white hover:bg-slate-700"
          : "bg-white border-2 border-slate-200 text-slate-700 hover:bg-slate-50",
      ].join(" ")}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SopReader() {
  const params = useParams<{ sop_id: string }>()
  const sopId = params.sop_id
  const router = useRouter()
  const supabase = createClient()

  const [employeeId, setEmployeeId] = useState<string>("")
  const [sop, setSop] = useState<Sop | null>(null)
  const [steps, setSteps] = useState<SopStep[]>([])
  const [current, setCurrent] = useState(0)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  // Mobile: whether the chat drawer is open
  const [chatOpen, setChatOpen] = useState(false)

  useEffect(() => {
    const session = getEmployeeSession()
    if (!session) {
      router.replace("/train/login")
      return
    }
    setEmployeeId(session.id)

    async function load() {
      const [{ data: sopData }, { data: stepsData }, progressData] = await Promise.all([
        supabase.from("sops").select("*").eq("id", sopId).single(),
        supabase.from("sop_steps").select("*").eq("sop_id", sopId).order("step_number"),
        fetch(`${backendUrl}/api/progress/${session.id}/${sopId}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ])

      if (!sopData) {
        setNotFound(true)
      } else {
        setSop(sopData)
        const loadedSteps = stepsData ?? []
        setSteps(loadedSteps)

        // Resume from saved position (in-progress SOPs only)
        if (progressData && !progressData.completed_at && progressData.current_step > 1) {
          const idx = loadedSteps.findIndex(
            (s) => s.step_number === progressData.current_step
          )
          if (idx > 0) setCurrent(idx)
        }
      }
      setLoading(false)
    }

    load()
  }, [sopId])

  // ---- derived state -------------------------------------------------------

  const total = steps.length
  const step = steps[current] ?? null
  const isFirst = current === 0
  const isLast = current === total - 1
  const progressPct = total > 0 ? ((current + 1) / total) * 100 : 0

  // ---- handlers ------------------------------------------------------------

  function recordProgress(completedStep: number) {
    if (!employeeId) return
    // Fire-and-forget: don't block navigation on a network call
    fetch(`${backendUrl}/api/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        employee_id: employeeId,
        sop_id: sopId,
        completed_step: completedStep,
        total_steps: total,
      }),
    }).catch(() => {})
  }

  function goNext() {
    if (!step) return
    recordProgress(step.step_number)
    if (isLast) {
      router.push("/train")
    } else {
      setCurrent((c) => c + 1)
    }
  }

  function goPrev() {
    if (!isFirst) setCurrent((c) => c - 1)
  }

  // ---- loading / error states ----------------------------------------------

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-3xl text-slate-400">{t("reader.loading")}</p>
      </div>
    )
  }

  if (notFound || !sop || !step) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6">
        <p className="text-3xl text-slate-400">{t("reader.notFound")}</p>
        <NavButton onClick={() => router.push("/train")} primary>
          {t("reader.back")}
        </NavButton>
      </div>
    )
  }

  // ---- main render ---------------------------------------------------------

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-5 px-8 py-4 bg-white border-b border-slate-200 shrink-0">
        <button
          onClick={() => router.push("/train")}
          className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-lg
                     text-slate-500 hover:bg-slate-100 transition-colors"
        >
          ← {t("reader.back")}
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-xl font-semibold truncate">{sop.title}</p>
          <div className="mt-2 h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-slate-700 rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        <span className="shrink-0 text-lg text-slate-500 tabular-nums">
          {t("reader.progress", { current: current + 1, total })}
        </span>
      </header>

      {/* ── Content row: step viewer (left) + chat panel (right) ───────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: SOP step viewer ──────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto px-10 py-8 max-w-3xl w-full mx-auto">
          {/* Step number */}
          <p className="text-lg font-medium text-slate-400 mb-2 tracking-wide uppercase">
            {t("reader.step.label", { n: step.step_number })}
          </p>

          {/* Step title */}
          <h1 className="text-4xl font-bold leading-tight mb-8">{step.title}</h1>

          {/* Keyframe image */}
          {step.image_url && (
            <div className="mb-8 flex items-center justify-center bg-slate-100 rounded-xl
                            border border-slate-200 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={step.image_url}
                alt={step.title}
                className="max-h-[60vh] w-auto object-contain rounded-lg"
              />
            </div>
          )}

          {/* Description */}
          {step.description && (
            <p className="text-2xl leading-relaxed text-slate-700 mb-8 whitespace-pre-wrap">
              {step.description}
            </p>
          )}

          {/* Warnings */}
          {step.warnings && step.warnings.length > 0 && (
            <div className="space-y-3">
              <p className="text-lg font-semibold text-slate-500 uppercase tracking-wide">
                {t("reader.step.warningsLabel")}
              </p>
              {step.warnings.map((w, i) => (
                <WarningBanner key={i} text={w} />
              ))}
            </div>
          )}
        </main>

        {/* ── Right: chat panel (desktop/tablet only) ─────────────────────── */}
        <aside className="hidden md:flex w-[35%] max-w-sm xl:max-w-md shrink-0
                          flex-col border-l border-slate-200 overflow-hidden">
          <ChatPanel
            employeeId={employeeId}
            sopId={sopId}
            stepNumber={step.step_number}
          />
        </aside>
      </div>

      {/* ── Bottom navigation ──────────────────────────────────────────── */}
      <nav className="flex items-center justify-between px-8 py-5 bg-white border-t
                      border-slate-200 shrink-0">
        <NavButton onClick={goPrev} disabled={isFirst}>
          {t("reader.nav.prev")}
        </NavButton>

        <span className="text-2xl font-medium text-slate-500 tabular-nums">
          {current + 1} / {total}
        </span>

        <NavButton onClick={goNext} primary>
          {isLast ? t("reader.nav.finish") : t("reader.nav.next")}
        </NavButton>
      </nav>

      {/* ── Mobile: full-screen chat overlay ───────────────────────────── */}
      {chatOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white md:hidden">
          <div className="flex items-center gap-4 px-5 py-4 border-b border-slate-200 shrink-0">
            <button
              onClick={() => setChatOpen(false)}
              className="text-lg text-slate-500 hover:text-slate-800 transition-colors"
            >
              ← {t("chat.closeBtn")}
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <ChatPanel
              employeeId={employeeId}
              sopId={sopId}
              stepNumber={step.step_number}
            />
          </div>
        </div>
      )}

      {/* ── Mobile: floating "問問題" button ────────────────────────────── */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fixed bottom-28 right-5 z-40 md:hidden
                     bg-slate-800 text-white px-5 py-3 rounded-2xl shadow-lg
                     text-lg font-semibold active:scale-95 transition-all"
        >
          {t("chat.floatingBtn")}
        </button>
      )}
    </div>
  )
}
