"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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
      <p className="text-base md:text-xl leading-snug text-red-700">{text}</p>
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
        "min-h-[56px] px-5 md:px-10 rounded-2xl text-base md:text-xl font-semibold",
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
// Video modal
// ---------------------------------------------------------------------------

function VideoModal({
  videoUrl,
  seekTo,
  onClose,
}: {
  videoUrl: string
  seekTo: number | null
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const target = seekTo ?? 0
    const doSeek = () => { video.currentTime = target }
    // If metadata is already available, seek immediately; otherwise wait for it
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      doSeek()
    } else {
      video.addEventListener("loadedmetadata", doSeek, { once: true })
      return () => video.removeEventListener("loadedmetadata", doSeek)
    }
  }, [seekTo])

  function handleClose() {
    videoRef.current?.pause()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 flex items-center justify-end px-5 py-4">
        <button
          onClick={handleClose}
          className="min-w-[56px] min-h-[56px] flex items-center justify-center gap-2
                     rounded-2xl border-2 border-white/30 text-white text-lg font-semibold
                     hover:bg-white/10 active:scale-95 transition-all"
        >
          {t("reader.video.close")}
        </button>
      </div>

      {/* Video */}
      <div className="flex-1 flex items-center justify-center px-4 pb-6">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          playsInline
          className="max-h-full max-w-full w-full rounded-2xl shadow-2xl"
          style={{ maxHeight: "calc(100vh - 120px)" }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TTS helpers
// ---------------------------------------------------------------------------

/** Pick the best Chinese voice available, or null to let the browser decide. */
function pickChineseVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null
  const voices = window.speechSynthesis.getVoices()
  return (
    voices.find((v) => v.lang === "zh-TW") ??
    voices.find((v) => v.lang === "zh-CN") ??
    voices.find((v) => v.lang.startsWith("zh")) ??
    null
  )
}

function buildUtterance(step: SopStep): SpeechSynthesisUtterance {
  const parts: string[] = []
  parts.push(step.title)
  if (step.description) parts.push(step.description)
  if (step.warnings && step.warnings.length > 0) {
    step.warnings.forEach((w) => parts.push(t("reader.tts.warningPrefix") + w))
  }

  const utt = new SpeechSynthesisUtterance(parts.join("。"))
  utt.lang = "zh-TW"
  const voice = pickChineseVoice()
  if (voice) utt.voice = voice
  utt.rate = 0.9
  return utt
}

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5" aria-hidden="true">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  )
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
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
  // Video player modal
  const [videoOpen, setVideoOpen] = useState(false)
  // TTS
  const [speaking, setSpeaking] = useState(false)
  const uttRef = useRef<SpeechSynthesisUtterance | null>(null)

  useEffect(() => {
    const session = getEmployeeSession()
    if (!session) {
      router.replace("/train/login")
      return
    }
    const employeeId = session.id
    setEmployeeId(employeeId)

    async function load() {
      const [{ data: sopData }, { data: stepsData }, progressData] = await Promise.all([
        supabase.from("sops").select("*").eq("id", sopId).single(),
        supabase.from("sop_steps").select("*").eq("sop_id", sopId).order("step_number"),
        fetch(`${backendUrl}/api/progress/${employeeId}/${sopId}`)
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
    setVideoOpen(false)
    recordProgress(step.step_number)
    if (isLast) {
      router.push("/train")
    } else {
      setCurrent((c) => c + 1)
    }
  }

  function goPrev() {
    if (!isFirst) {
      setVideoOpen(false)
      setCurrent((c) => c - 1)
    }
  }

  const stopSpeech = useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    uttRef.current = null
    setSpeaking(false)
  }, [])

  function startSpeech() {
    if (!step || typeof window === "undefined" || !window.speechSynthesis) return
    stopSpeech()
    const utt = buildUtterance(step)
    utt.onstart = () => setSpeaking(true)
    utt.onend = () => { uttRef.current = null; setSpeaking(false) }
    utt.onerror = () => { uttRef.current = null; setSpeaking(false) }
    uttRef.current = utt
    window.speechSynthesis.speak(utt)
  }

  // Auto-stop when navigating to a different step or unmounting
  useEffect(() => {
    return () => { stopSpeech() }
  }, [current, stopSpeech])

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
      <header className="flex items-center gap-3 px-4 py-3 md:px-8 md:py-4 bg-white border-b border-slate-200 shrink-0">
        <button
          onClick={() => router.push("/train")}
          className="shrink-0 flex items-center gap-1 min-h-[44px] px-3 py-2 rounded-xl
                     text-sm md:text-lg text-slate-500 hover:bg-slate-100 transition-colors"
        >
          ← {t("reader.back")}
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-base md:text-xl font-semibold truncate">{sop.title}</p>
          <div className="mt-1.5 h-1.5 md:h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-slate-700 rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        <span className="shrink-0 text-sm md:text-lg text-slate-500 tabular-nums">
          {t("reader.progress", { current: current + 1, total })}
        </span>
      </header>

      {/* ── Content row: step viewer (left) + chat panel (right) ───────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: SOP step viewer ──────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto px-5 py-6 md:px-10 md:py-8 max-w-3xl w-full mx-auto">
          {/* Step number */}
          <p className="text-sm md:text-lg font-medium text-slate-400 mb-2 tracking-wide uppercase">
            {t("reader.step.label", { n: step.step_number })}
          </p>

          {/* Step title + TTS button */}
          <div className="flex items-start gap-4 mb-8">
            <h1 className="flex-1 text-2xl md:text-4xl font-bold leading-tight">{step.title}</h1>
            <button
              onClick={speaking ? stopSpeech : startSpeech}
              aria-label={speaking ? t("reader.tts.stop") : t("reader.tts.play")}
              className={[
                "shrink-0 min-w-[48px] min-h-[48px] flex items-center justify-center",
                "rounded-2xl border-2 transition-all active:scale-95",
                speaking
                  ? "bg-red-50 border-red-300 text-red-500 hover:bg-red-100"
                  : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100",
              ].join(" ")}
              title={speaking ? t("reader.tts.stop") : t("reader.tts.play")}
            >
              {speaking ? <StopIcon /> : <SpeakerIcon />}
            </button>
          </div>

          {/* Keyframe image */}
          {step.image_url && (
            <div className="mb-4 flex items-center justify-center bg-slate-100 rounded-xl
                            border border-slate-200 p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={step.image_url}
                alt={step.title}
                className="max-h-[60vh] w-auto object-contain rounded-lg"
              />
            </div>
          )}

          {/* Watch demo video button — only shown when SOP has a source video */}
          {sop.video_url && (
            <div className="mb-8">
              <button
                onClick={() => setVideoOpen(true)}
                className="flex items-center gap-2.5 px-6 min-h-[48px] rounded-2xl
                           bg-slate-100 border-2 border-slate-200 text-slate-700
                           text-lg font-medium hover:bg-slate-200 active:scale-95
                           transition-all"
              >
                <VideoIcon />
                {t("reader.video.btn")}
              </button>
            </div>
          )}

          {/* Description */}
          {step.description && (
            <p className="text-lg md:text-2xl leading-relaxed text-slate-700 mb-8 whitespace-pre-wrap">
              {step.description}
            </p>
          )}

          {/* Warnings */}
          {step.warnings && step.warnings.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm md:text-lg font-semibold text-slate-500 uppercase tracking-wide">
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
      <nav className="flex items-center justify-between px-4 py-4 md:px-8 md:py-5 bg-white border-t
                      border-slate-200 shrink-0">
        <NavButton onClick={goPrev} disabled={isFirst}>
          {t("reader.nav.prev")}
        </NavButton>

        <span className="text-lg md:text-2xl font-medium text-slate-500 tabular-nums">
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

      {/* ── Video player modal ─────────────────────────────────────────── */}
      {videoOpen && sop.video_url && (
        <VideoModal
          videoUrl={sop.video_url}
          seekTo={step.timestamp_start ?? null}
          onClose={() => setVideoOpen(false)}
        />
      )}
    </div>
  )
}
