"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { setEmployeeSession } from "@/lib/employee-session"
import { t } from "@/lib/i18n"
import { backendUrl } from "@/lib/backend"

// Keypad layout: 1–9 row-by-row, then backspace / 0 / confirm
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"] as const
const MAX_PIN = 6
const MIN_PIN = 4

export default function TrainLoginPage() {
  const [pin, setPin] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const router = useRouter()

  async function submit(currentPin: string) {
    if (currentPin.length < MIN_PIN || loading) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch(`${backendUrl}/auth/employee`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: currentPin }),
      })
      if (!res.ok) {
        setError(t("train.login.error"))
        setPin("")
        return
      }
      const data = await res.json()
      setEmployeeSession({ id: data.id, name: data.name })
      router.replace("/train")
    } catch {
      setError(t("train.login.networkError"))
    } finally {
      setLoading(false)
    }
  }

  function handleKey(key: string) {
    if (loading) return
    if (key === "⌫") {
      setPin((p) => p.slice(0, -1))
      setError("")
    } else if (key === "✓") {
      submit(pin)
    } else if (pin.length < MAX_PIN) {
      const next = pin + key
      setPin(next)
      // Auto-submit when max length reached
      if (next.length === MAX_PIN) submit(next)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-10 px-6">
      {/* Title */}
      <div className="text-center space-y-2">
        <h1 className="text-5xl font-bold tracking-tight">{t("train.login.title")}</h1>
        <p className="text-2xl text-slate-500">{t("train.login.subtitle")}</p>
      </div>

      {/* PIN dots */}
      <div className="flex gap-4">
        {Array.from({ length: MAX_PIN }).map((_, i) => (
          <div
            key={i}
            className={`w-14 h-16 rounded-2xl border-2 flex items-center justify-center transition-all ${
              i < pin.length
                ? "border-slate-700 bg-slate-700"
                : "border-slate-200 bg-white"
            }`}
          >
            {i < pin.length && (
              <span className="text-white text-2xl leading-none">●</span>
            )}
          </div>
        ))}
      </div>

      {/* Error */}
      <div className="h-8 flex items-center">
        {error && (
          <p className="text-red-500 text-xl font-medium">{error}</p>
        )}
      </div>

      {/* Keypad */}
      <div className="grid grid-cols-3 gap-4 w-80">
        {KEYS.map((key) => {
          const isConfirm = key === "✓"
          const isBackspace = key === "⌫"
          const disabled =
            loading ||
            (isConfirm && pin.length < MIN_PIN)

          return (
            <button
              key={key}
              onClick={() => handleKey(key)}
              disabled={disabled}
              className={[
                "h-24 rounded-3xl text-3xl font-semibold select-none",
                "transition-all active:scale-95 disabled:opacity-40",
                isConfirm
                  ? "bg-slate-800 text-white"
                  : isBackspace
                  ? "bg-slate-200 text-slate-600 hover:bg-slate-300"
                  : "bg-white shadow border border-slate-200 text-slate-800 hover:bg-slate-50 active:bg-slate-100",
              ].join(" ")}
            >
              {loading && isConfirm ? "…" : key}
            </button>
          )
        })}
      </div>
    </div>
  )
}
