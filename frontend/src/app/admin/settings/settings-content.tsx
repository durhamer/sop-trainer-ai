"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { t } from "@/lib/i18n"
import { backendUrl } from "@/lib/backend"

function LineIntegrationCard() {
  const [copied, setCopied] = useState(false)
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null)

  // The LINE webhook URL points directly to the backend (not the Next.js proxy)
  const webhookUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL ?? ""}/line/webhook`

  useEffect(() => {
    fetch(`${backendUrl}/line/config`)
      .then((r) => r.json())
      .then((d) => setIsConfigured(d.is_configured ?? false))
      .catch(() => setIsConfigured(false))
  }, [])

  async function handleCopy() {
    await navigator.clipboard.writeText(webhookUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">{t("line.settings.title")}</CardTitle>
          {isConfigured === true && (
            <span className="text-xs font-medium text-green-600 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
              {t("line.settings.statusConnected")}
            </span>
          )}
          {isConfigured === false && (
            <span className="text-xs font-medium text-zinc-400 bg-zinc-100 border border-zinc-200 rounded-full px-2 py-0.5">
              {t("line.settings.statusNotConfigured")}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <p className="text-xs text-zinc-500 font-medium">{t("line.settings.webhookLabel")}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm bg-zinc-100 rounded-lg px-3 py-2 break-all select-all">
              {webhookUrl || "（未設定 NEXT_PUBLIC_BACKEND_URL）"}
            </code>
            <Button variant="outline" size="sm" onClick={handleCopy} disabled={!webhookUrl}>
              {copied ? t("line.settings.webhookCopied") : t("line.settings.webhookCopy")}
            </Button>
          </div>
          <p className="text-xs text-zinc-400">{t("line.settings.webhookHint")}</p>
        </div>
        <p className="text-xs text-zinc-400 border-t pt-3">{t("line.settings.channelNote")}</p>
      </CardContent>
    </Card>
  )
}

function LoginUrlCard() {
  const [loginUrl, setLoginUrl] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setLoginUrl(`${window.location.origin}/train/login/${data.user.id}`)
      }
    })
  }, [])

  async function handleCopy() {
    if (!loginUrl) return
    await navigator.clipboard.writeText(loginUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("settings.loginUrl.title")}</CardTitle>
        <p className="text-sm text-zinc-500 mt-1">{t("settings.loginUrl.subtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="flex-1 text-sm bg-zinc-100 rounded-lg px-3 py-2 break-all select-all">
            {loginUrl || "載入中…"}
          </code>
          <Button variant="outline" size="sm" onClick={handleCopy} disabled={!loginUrl}>
            {copied ? t("settings.loginUrl.copied") : t("settings.loginUrl.copy")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Personality definitions (mirrored from backend PERSONALITY_PROMPTS)
// ---------------------------------------------------------------------------

type Personality = {
  id: string
  name: string
  tagline: string
  description: string
  sample: string
}

const PERSONALITIES: Personality[] = [
  {
    id: "嚴厲學長",
    name: "嚴厲學長",
    tagline: "直接・紀律・幽默",
    description: "說話直接、重視紀律，會提醒員工不要馬虎。語氣像軍訓教官但有幽默感。",
    sample: "「這步驟不能偷懶，上次有人搞錯，我不想再看到第二次。記住了嗎？」",
  },
  {
    id: "溫柔學姊",
    name: "溫柔學姊",
    tagline: "耐心・鼓勵・溫暖",
    description: "有耐心、鼓勵式教學，會稱讚員工做得好。語氣像大姊姊照顧新人。",
    sample: "「這邊要特別小心喔！你上次做得很好呢，繼續加油！」",
  },
  {
    id: "搞笑同事",
    name: "搞笑同事",
    tagline: "幽默・輕鬆・有趣",
    description: "輕鬆幽默、用梗解釋事情，讓學習變有趣。但安全事項會認真說。",
    sample: "「這個步驟就像打遊戲的最終 Boss，搞定它你就過關了！（但是認真，這真的很重要）」",
  },
  {
    id: "專業教練",
    name: "專業教練",
    tagline: "正式・條理・專業",
    description: "正式但親切、條理分明，像企業培訓講師。",
    sample: "「重點整理：第一，確認溫度；第二，檢查時間；第三，記錄結果。」",
  },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SettingsContent() {
  const [selected, setSelected] = useState<string>("溫柔學姊")
  const [settingsId, setSettingsId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const supabase = createClient()

  useEffect(() => {
    supabase
      .from("store_settings")
      .select("id, ai_personality")
      .limit(1)
      .single()
      .then(({ data }) => {
        if (data) {
          setSettingsId(data.id)
          setSelected(data.ai_personality)
        }
        setLoading(false)
      })
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      if (settingsId) {
        const { error } = await supabase
          .from("store_settings")
          .update({ ai_personality: selected })
          .eq("id", settingsId)
        if (error) throw error
      } else {
        // No row exists yet — insert one
        const { data, error } = await supabase
          .from("store_settings")
          .insert({ ai_personality: selected })
          .select("id")
          .single()
        if (error) throw error
        if (data) setSettingsId(data.id)
      }
      toast.success(t("settings.personality.saved"))
    } catch (err) {
      toast.error(
        t("settings.personality.error") +
          (err instanceof Error ? `：${err.message}` : "")
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t("settings.pageTitle")}</h2>
        <p className="text-zinc-500 text-sm mt-1">{t("settings.pageSubtitle")}</p>
      </div>

      {/* Employee login URL */}
      <LoginUrlCard />

      {/* LINE integration */}
      <LineIntegrationCard />

      {/* Personality selector */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.personality.title")}</CardTitle>
          <p className="text-sm text-zinc-500 mt-1">{t("settings.personality.subtitle")}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-sm text-zinc-400 py-4 text-center">載入中...</p>
          ) : (
            PERSONALITIES.map((p) => {
              const isSelected = selected === p.id
              return (
                <button
                  key={p.id}
                  onClick={() => setSelected(p.id)}
                  className={[
                    "w-full text-left rounded-xl border-2 p-4 transition-all",
                    isSelected
                      ? "border-zinc-900 bg-zinc-50"
                      : "border-zinc-200 hover:border-zinc-300 bg-white",
                  ].join(" ")}
                >
                  <div className="flex items-start gap-3">
                    {/* Selection indicator */}
                    <span
                      className={[
                        "mt-0.5 shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center",
                        isSelected ? "border-zinc-900 bg-zinc-900" : "border-zinc-300",
                      ].join(" ")}
                    >
                      {isSelected && (
                        <span className="w-1.5 h-1.5 rounded-full bg-white block" />
                      )}
                    </span>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-semibold text-zinc-900">{p.name}</span>
                        <span className="text-xs text-zinc-400">{p.tagline}</span>
                      </div>
                      <p className="text-sm text-zinc-600 mt-0.5">{p.description}</p>
                      <p className="text-xs text-zinc-400 mt-2 italic leading-snug">
                        {p.sample}
                      </p>
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving || loading}>
          {saving ? t("settings.personality.saving") : "儲存設定"}
        </Button>
      </div>
    </div>
  )
}
