"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import Link from "next/link"
import { t } from "@/lib/i18n"
import { backendUrl } from "@/lib/backend"

// ---------------------------------------------------------------------------
// Web Speech API — minimal type declarations (avoids lib.dom version conflicts)
// ---------------------------------------------------------------------------

interface SpeechRecognitionInstance {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { results: { [i: number]: { [i: number]: { transcript: string } } } }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === "undefined") return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

// ---------------------------------------------------------------------------
// TTS helper — shared Chinese voice picker
// ---------------------------------------------------------------------------

function getChineseVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null
  const voices = window.speechSynthesis.getVoices()
  return (
    voices.find((v) => v.lang === "zh-TW") ??
    voices.find((v) => v.lang === "zh-CN") ??
    voices.find((v) => v.lang.startsWith("zh")) ??
    null
  )
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M19 10a7 7 0 0 1-14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="9" y1="22" x2="15" y2="22" />
    </svg>
  )
}

function SpeakerSmIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round"
         className={`w-4 h-4 ${active ? "animate-pulse" : ""}`} aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Source = {
  step_number: number | null
  title: string
  type: "sop" | "faq"
  sop_id?: string | null  // present in general chat SOP sources (for /train/[sop_id] links)
}
type Message = { role: "user" | "assistant"; text: string; sources?: Source[] }

interface ChatPanelProps {
  employeeId: string
  ownerId: string
  // SOP-mode props (required when mode="sop", unused in mode="general")
  sopId?: string
  stepNumber?: number
  // Mode — "sop" (default) uses /api/chat; "general" uses /api/chat/general
  mode?: "sop" | "general"
  // When provided, a close button appears in the header (used by general chat overlay)
  onClose?: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ChatPanel({
  employeeId,
  ownerId,
  sopId,
  stepNumber,
  mode = "sop",
  onClose,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)

  // STT
  const [recording, setRecording] = useState(false)
  const [recError, setRecError] = useState("")
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)

  // TTS — track which message text is currently being spoken
  const [speaking, setSpeaking] = useState<string | null>(null)
  const [autoRead, setAutoRead] = useState(true)
  const autoReadRef = useRef(true)   // mirror for async callbacks
  const ttsRef = useRef<SpeechSynthesisUtterance | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, loading])

  // ── TTS ──────────────────────────────────────────────────────────────────

  const stopTts = useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    ttsRef.current = null
    setSpeaking(null)
  }, [])

  function speakText(text: string) {
    stopTts()
    if (typeof window === "undefined" || !window.speechSynthesis) return
    const utt = new SpeechSynthesisUtterance(text)
    utt.lang = "zh-TW"
    const voice = getChineseVoice()
    if (voice) utt.voice = voice
    utt.rate = 0.9
    utt.onstart = () => setSpeaking(text)
    utt.onend   = () => { ttsRef.current = null; setSpeaking(null) }
    utt.onerror = () => { ttsRef.current = null; setSpeaking(null) }
    ttsRef.current = utt
    window.speechSynthesis.speak(utt)
  }

  function toggleAutoRead() {
    const next = !autoRead
    setAutoRead(next)
    autoReadRef.current = next
    if (!next) stopTts()
  }

  // ── STT ──────────────────────────────────────────────────────────────────

  function startRecording() {
    const SR = getSpeechRecognitionCtor()
    if (!SR) {
      setRecError(t("chat.mic.error.notSupported"))
      setTimeout(() => setRecError(""), 3000)
      return
    }
    setRecError("")
    stopTts() // don't let TTS and mic overlap

    const rec = new SR()
    rec.lang = "zh-TW"
    rec.interimResults = false
    rec.continuous = false

    rec.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript?.trim() ?? ""
      setRecording(false)
      recognitionRef.current = null
      if (transcript) {
        setInput("")
        setMessages((prev) => [...prev, { role: "user", text: transcript }])
        sendQuestion(transcript)
      }
    }

    rec.onerror = (e) => {
      setRecording(false)
      recognitionRef.current = null
      const msg = e.error === "not-allowed"
        ? t("chat.mic.error.permission")
        : t("chat.mic.error.generic")
      setRecError(msg)
      setTimeout(() => setRecError(""), 3000)
    }

    rec.onend = () => {
      setRecording(false)
      recognitionRef.current = null
    }

    recognitionRef.current = rec
    rec.start()
    setRecording(true)
  }

  function stopRecording() {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setRecording(false)
  }

  // ── API ──────────────────────────────────────────────────────────────────

  async function sendQuestion(question: string) {
    if (!question.trim()) return
    setLoading(true)
    try {
      const url = mode === "general"
        ? `${backendUrl}/api/chat/general`
        : `${backendUrl}/api/chat`
      const body = mode === "general"
        ? { employee_id: employeeId, owner_id: ownerId, question }
        : { employee_id: employeeId, sop_id: sopId, step_number: stepNumber, question, owner_id: ownerId }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const answer: string = data.answer
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: answer, sources: data.sources ?? [] },
      ])
      if (autoReadRef.current) speakText(answer)
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", text: t("chat.error") }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  async function handleSend() {
    const q = input.trim()
    if (!q || loading) return
    setInput("")
    setMessages((prev) => [...prev, { role: "user", text: q }])
    await sendQuestion(q)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-slate-50">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-5 py-4 bg-white border-b border-slate-200
                      flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-semibold text-slate-800">
            {mode === "general" ? t("generalChat.title") : t("chat.title")}
          </p>
          <p className="text-sm text-slate-400 mt-0.5">
            {mode === "general" ? t("generalChat.subtitle") : t("chat.subtitle")}
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          {/* Auto-read toggle */}
          <button
            onClick={toggleAutoRead}
            title={t("chat.tts.autoRead")}
            className={[
              "flex items-center gap-1.5 px-3 py-1.5 rounded-xl",
              "text-xs font-medium border transition-all",
              autoRead
                ? "bg-slate-700 border-slate-700 text-white"
                : "bg-white border-slate-200 text-slate-400 hover:border-slate-300",
            ].join(" ")}
          >
            <SpeakerSmIcon active={false} />
            {t("chat.tts.autoRead")}
          </button>

          {/* Close button — only shown when onClose is provided (general chat overlay) */}
          {onClose && (
            <button
              onClick={onClose}
              className="flex items-center justify-center min-w-[36px] min-h-[36px]
                         rounded-xl border border-slate-200 text-slate-500 text-sm
                         hover:bg-slate-50 transition-colors"
              aria-label={t("generalChat.close")}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* ── Message thread ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-5">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400 text-center mt-10 px-4 leading-relaxed">
            {mode === "general" ? t("generalChat.empty") : t("chat.empty")}
          </p>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className="max-w-[88%] space-y-2">
              {/* Bubble */}
              <div
                className={[
                  "px-4 py-3 rounded-2xl text-base leading-relaxed whitespace-pre-wrap break-words",
                  msg.role === "user"
                    ? "bg-slate-800 text-white rounded-br-sm"
                    : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm shadow-sm",
                ].join(" ")}
              >
                {msg.text}
              </div>

              {/* Assistant extras: replay + sources */}
              {msg.role === "assistant" && (
                <div className="px-1 space-y-2">
                  {/* Replay TTS button */}
                  <button
                    onClick={() => speaking === msg.text ? stopTts() : speakText(msg.text)}
                    aria-label={t("chat.tts.replay")}
                    title={t("chat.tts.replay")}
                    className={[
                      "flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs",
                      "border transition-all active:scale-95",
                      speaking === msg.text
                        ? "border-slate-400 text-slate-700 bg-slate-100"
                        : "border-slate-200 text-slate-400 bg-white hover:text-slate-600 hover:border-slate-300",
                    ].join(" ")}
                  >
                    <SpeakerSmIcon active={speaking === msg.text} />
                    {t("chat.tts.replay")}
                  </button>

                  {/* Source references */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs text-slate-400 font-medium">{t("chat.sources")}</p>
                      {msg.sources.map((src, j) =>
                        src.sop_id ? (
                          // General chat: SOP-level source — clickable link to /train/[sop_id]
                          <Link
                            key={j}
                            href={`/train/${src.sop_id}`}
                            className="block text-xs text-blue-600 bg-blue-50 border border-blue-200
                                       rounded-lg px-3 py-1.5 leading-snug hover:bg-blue-100
                                       transition-colors"
                          >
                            {t("generalChat.sourceLabel")}：{src.title}
                          </Link>
                        ) : src.type === "faq" ? (
                          <p key={j}
                             className="text-xs text-slate-500 bg-white border border-slate-200
                                        rounded-lg px-3 py-1.5 leading-snug">
                            {`FAQ：${src.title}`}
                          </p>
                        ) : (
                          <p key={j}
                             className="text-xs text-slate-500 bg-white border border-slate-200
                                        rounded-lg px-3 py-1.5 leading-snug">
                            {t("chat.sourceRef", {
                              step: String(src.step_number ?? ""),
                              title: src.title,
                            })}
                          </p>
                        )
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Thinking indicator */}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-sm
                            px-4 py-3 text-slate-400 text-base shadow-sm">
              {t("chat.thinking")}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Mic error banner ───────────────────────────────────────────────── */}
      {recError && (
        <div className="shrink-0 mx-4 mb-1 px-4 py-2 rounded-xl bg-red-50 border
                        border-red-200 text-sm text-red-600 text-center">
          {recError}
        </div>
      )}

      {/* ── Recording indicator ────────────────────────────────────────────── */}
      {recording && (
        <p className="shrink-0 py-1.5 text-sm text-red-500 font-medium text-center
                      animate-pulse bg-red-50 border-t border-red-100">
          {t("chat.mic.listening")}
        </p>
      )}

      {/* ── Input area ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 p-4 bg-white border-t border-slate-200">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("chat.placeholder")}
            rows={2}
            disabled={recording}
            className="flex-1 resize-none rounded-2xl border border-slate-200 px-4 py-3
                       text-base leading-snug focus:outline-none focus:ring-2
                       focus:ring-slate-300 bg-slate-50 disabled:opacity-40"
          />

          {/* Mic button */}
          <button
            onClick={recording ? stopRecording : startRecording}
            disabled={loading}
            aria-label={recording ? t("chat.mic.stop") : t("chat.mic.start")}
            title={recording ? t("chat.mic.stop") : t("chat.mic.start")}
            className={[
              "shrink-0 min-w-[48px] min-h-[48px] flex items-center justify-center",
              "rounded-2xl border-2 transition-all active:scale-95 disabled:opacity-30",
              recording
                ? "bg-red-500 border-red-500 text-white animate-pulse"
                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300",
            ].join(" ")}
          >
            <MicIcon />
          </button>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading || recording}
            className="shrink-0 min-w-[48px] min-h-[48px] px-5 rounded-2xl bg-slate-800
                       text-white text-base font-semibold hover:bg-slate-700 active:scale-95
                       transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {t("chat.send")}
          </button>
        </div>
      </div>
    </div>
  )
}
