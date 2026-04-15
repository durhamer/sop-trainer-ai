"use client"

import { useState, useRef, useEffect } from "react"
import { t } from "@/lib/i18n"
import { backendUrl } from "@/lib/backend"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Source = {
  step_number: number | null
  title: string
  type: "sop" | "faq"
}

type Message = {
  role: "user" | "assistant"
  text: string
  sources?: Source[]
}

interface ChatPanelProps {
  employeeId: string
  sopId: string
  stepNumber: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ChatPanel({ employeeId, sopId, stepNumber }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Scroll to bottom whenever messages or loading state changes
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, loading])

  async function handleSend() {
    const q = input.trim()
    if (!q || loading) return

    setInput("")
    setMessages((prev) => [...prev, { role: "user", text: q }])
    setLoading(true)

    try {
      const res = await fetch(`${backendUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employee_id: employeeId,
          sop_id: sopId,
          step_number: stepNumber,
          question: q,
        }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()

      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.answer, sources: data.sources ?? [] },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: t("chat.error") },
      ])
    } finally {
      setLoading(false)
      // Return focus to input after response arrives
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-5 py-4 bg-white border-b border-slate-200">
        <p className="text-lg font-semibold text-slate-800">{t("chat.title")}</p>
        <p className="text-sm text-slate-400 mt-0.5">{t("chat.subtitle")}</p>
      </div>

      {/* ── Message thread ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-5">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400 text-center mt-10 px-4 leading-relaxed">
            {t("chat.empty")}
          </p>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
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

              {/* Source references (assistant only) */}
              {msg.sources && msg.sources.length > 0 && (
                <div className="px-1 space-y-1.5">
                  <p className="text-xs text-slate-400 font-medium">{t("chat.sources")}</p>
                  {msg.sources.map((src, j) => (
                    <p
                      key={j}
                      className="text-xs text-slate-500 bg-white border border-slate-200
                                 rounded-lg px-3 py-1.5 leading-snug"
                    >
                      {src.type === "faq"
                        ? `FAQ：${src.title}`
                        : t("chat.sourceRef", {
                            step: String(src.step_number ?? ""),
                            title: src.title,
                          })}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Thinking indicator */}
        {loading && (
          <div className="flex justify-start">
            <div
              className="bg-white border border-slate-200 rounded-2xl rounded-bl-sm
                         px-4 py-3 text-slate-400 text-base shadow-sm"
            >
              {t("chat.thinking")}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input ────────────────────────────────────────────────────────── */}
      <div className="shrink-0 p-4 bg-white border-t border-slate-200">
        <div className="flex gap-3 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("chat.placeholder")}
            rows={2}
            className="flex-1 resize-none rounded-2xl border border-slate-200 px-4 py-3
                       text-base leading-snug focus:outline-none focus:ring-2
                       focus:ring-slate-300 bg-slate-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="shrink-0 px-5 py-3 rounded-2xl bg-slate-800 text-white text-base
                       font-semibold hover:bg-slate-700 active:scale-95 transition-all
                       disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {t("chat.send")}
          </button>
        </div>
      </div>
    </div>
  )
}
