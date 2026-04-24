"use client"

import { useState, useEffect, useRef } from "react"
import { createClient } from "@/lib/supabase"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { t } from "@/lib/i18n"
import { backendUrl } from "@/lib/backend"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Suggestion = {
  id: string
  question: string
  answer: string
  source_context: string
  possibly_duplicate: boolean
  duplicate_of: { id: string; question: string; similarity: number } | null
  selected: boolean
}

type Step = 1 | 2 | 3

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 1 * 1024 * 1024 // 1 MB
const LARGE_FILE_THRESHOLD = 100 * 1024 // 100 KB
const POLL_INTERVAL_MS = 3000
const JOB_TIMEOUT_MS = 20 * 60 * 1000 // 20 min safety ceiling

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Props = {
  open: boolean
  onClose: () => void
  onImported: () => void
}

export default function FaqImportModal({ open, onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>(1)
  const [file, setFile] = useState<File | null>(null)
  const [isLargeFile, setIsLargeFile] = useState(false)
  const [roleContext, setRoleContext] = useState("")
  const [fileError, setFileError] = useState("")
  const [formError, setFormError] = useState("")
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobStage, setJobStage] = useState("")
  const [jobCurrentChunk, setJobCurrentChunk] = useState(0)
  const [jobTotalChunks, setJobTotalChunks] = useState(1)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [submitting, setSubmitting] = useState(false)
  const jobStartTimeRef = useRef<number>(0)
  const supabase = createClient()

  // Reset state each time modal opens
  useEffect(() => {
    if (open) {
      setStep(1)
      setFile(null)
      setIsLargeFile(false)
      setRoleContext("")
      setFileError("")
      setFormError("")
      setJobId(null)
      setJobStage("")
      setJobCurrentChunk(0)
      setJobTotalChunks(1)
      setSuggestions([])
      setSubmitting(false)
    }
  }, [open])

  // Poll the job status while on step 2
  useEffect(() => {
    if (step !== 2 || !jobId) return

    jobStartTimeRef.current = Date.now()

    const poll = setInterval(async () => {
      if (Date.now() - jobStartTimeRef.current > JOB_TIMEOUT_MS) {
        clearInterval(poll)
        setFormError(t("faqImport.error.timeout"))
        setStep(1)
        return
      }

      try {
        const res = await fetch(`${backendUrl}/api/faq/import-jobs/${jobId}`)
        if (!res.ok) return
        const job = await res.json()
        console.log("[faq-import] poll:", job.status, "stage:", job.stage, "chunks:", job.current_chunk, "/", job.total_chunks)

        if (job.stage) setJobStage(job.stage)
        if (job.current_chunk != null) setJobCurrentChunk(job.current_chunk)
        if (job.total_chunks != null) setJobTotalChunks(job.total_chunks)

        if (job.status === "done") {
          clearInterval(poll)
          // job.result is JSONB: {"suggestions": [...]} or null
          const raw = job.result
          console.log("[faq-import] job done — raw result:", raw)
          const rawSuggestions: unknown[] = Array.isArray(raw?.suggestions)
            ? (raw.suggestions as unknown[])
            : []
          console.log("[faq-import] suggestions to map:", rawSuggestions.length, rawSuggestions)
          const items: Suggestion[] = rawSuggestions.map((s, i) => ({
            ...(s as Omit<Suggestion, "id" | "selected">),
            id: `s-${i}`,
            selected: true,
          }))
          setSuggestions(items)
          setStep(3)
        } else if (job.status === "failed") {
          clearInterval(poll)
          setFormError(job.error_message || t("faqImport.error.network"))
          setStep(1)
        }
      } catch {
        // network hiccup — keep polling
      }
    }, POLL_INTERVAL_MS)

    return () => clearInterval(poll)
  }, [step, jobId])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError("")
    const f = e.target.files?.[0] ?? null
    if (!f) { setFile(null); return }
    if (!f.name.toLowerCase().endsWith(".txt")) {
      setFileError(t("faqImport.step1.errorNotTxt"))
      setFile(null)
      return
    }
    if (f.size > MAX_FILE_SIZE) {
      setFileError(t("faqImport.step1.errorTooLarge"))
      setFile(null)
      return
    }
    setFile(f)
    setIsLargeFile(f.size > LARGE_FILE_THRESHOLD)
  }

  async function handleAnalyze() {
    if (!file) { setFileError(t("faqImport.step1.errorNoFile")); return }
    if (!roleContext.trim()) { setFormError(t("faqImport.step1.errorNoRole")); return }
    setFormError("")

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error(t("faqImport.error.network"))

      const formData = new FormData()
      formData.append("file", file)
      formData.append("role_context", roleContext.trim())
      formData.append("owner_id", user.id)

      const res = await fetch(`${backendUrl}/api/faq/import-from-chat`, {
        method: "POST",
        body: formData,
      })

      if (!res.ok) {
        const detail: string = await res.json().then((d) => d.detail ?? "").catch(() => "")
        if (detail === "FILE_TOO_LARGE") throw new Error(t("faqImport.step1.errorTooLarge"))
        if (detail === "FILE_TOO_LARGE_CHUNKED") throw new Error(t("faqImport.step1.errorTooLargeChunked"))
        if (detail === "FILE_TYPE_INVALID") throw new Error(t("faqImport.step1.errorNotTxt"))
        if (detail === "FILE_EMPTY") throw new Error(t("faqImport.step1.errorEmpty"))
        throw new Error(t("faqImport.error.network"))
      }

      const { job_id } = await res.json()
      setJobId(job_id)
      setJobStage(t("faqImport.step2.stage1"))
      setStep(2)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("faqImport.error.network"))
    }
  }

  function toggleAll(val: boolean) {
    setSuggestions((prev) => {
      console.log("[faq-import] toggleAll — prev:", prev?.length, Array.isArray(prev))
      return (prev ?? []).map((s) => ({ ...s, selected: val }))
    })
  }

  function toggleOne(id: string) {
    setSuggestions((prev) => {
      console.log("[faq-import] toggleOne — prev:", prev?.length, Array.isArray(prev))
      return (prev ?? []).map((s) => (s.id === id ? { ...s, selected: !s.selected } : s))
    })
  }

  function removeSuggestion(id: string) {
    setSuggestions((prev) => (prev ?? []).filter((s) => s.id !== id))
  }

  function updateField(id: string, field: "question" | "answer", value: string) {
    setSuggestions((prev) => {
      console.log("[faq-import] updateField — prev:", prev?.length, Array.isArray(prev))
      return (prev ?? []).map((s) => (s.id === id ? { ...s, [field]: value } : s))
    })
  }

  async function handleImport() {
    const selected = (suggestions ?? []).filter((s) => s.selected)
    if (!selected.length) return
    setSubmitting(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error(t("faqImport.error.network"))

      console.log("[faq-import] handleImport — selected:", selected.length, Array.isArray(selected))
      const rows = selected.map((s) => ({ question: s.question.trim(), answer: s.answer.trim() }))
      const { error: insertError } = await supabase.from("faq").insert(rows)
      if (insertError) throw insertError

      // Trigger background re-embedding (fire and forget — not critical to await)
      fetch(`${backendUrl}/api/faq/reembed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_id: user.id }),
      }).catch(() => {})

      toast.success(t("faqImport.step3.success", { n: String(selected.length) }))
      onImported()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("faqImport.error.network"))
    } finally {
      setSubmitting(false)
    }
  }

  const selectedCount = (Array.isArray(suggestions) ? suggestions : []).filter((s) => s.selected).length

  function handleOpenChange(open: boolean) {
    // Prevent closing during analysis
    if (!open && step !== 2) onClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle>
            {step === 1 && t("faqImport.step1.title")}
            {step === 2 && t("faqImport.step2.title")}
            {step === 3 && t("faqImport.step3.title")}
          </DialogTitle>
        </DialogHeader>

        {/* ── Step 1: upload + context ─────────────────────────────────────── */}
        {step === 1 && (
          <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4">
            <div className="space-y-1">
              <Label>{t("faqImport.step1.fileLabel")}</Label>
              <Input type="file" accept=".txt" onChange={handleFileChange} className="cursor-pointer" />
              <p className="text-xs text-zinc-400">{t("faqImport.step1.fileHint")}</p>
              {fileError && <p className="text-sm text-red-500">{fileError}</p>}
            </div>
            <div className="space-y-1">
              <Label>{t("faqImport.step1.roleLabel")}</Label>
              <Textarea
                value={roleContext}
                onChange={(e) => setRoleContext(e.target.value)}
                placeholder={t("faqImport.step1.rolePlaceholder")}
                rows={3}
              />
              <p className="text-xs text-zinc-400">{t("faqImport.step1.roleHint")}</p>
            </div>
            {formError && <p className="text-sm text-red-500">{formError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onClose}>
                {t("faqImport.step3.cancel")}
              </Button>
              <Button onClick={handleAnalyze} disabled={!file || !roleContext.trim()}>
                {t("faqImport.step1.submit")}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 2: loading ───────────────────────────────────────────────── */}
        {step === 2 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6 pb-10">
            <div className="w-12 h-12 rounded-full border-4 border-zinc-200 border-t-zinc-800 animate-spin" />
            <div className="space-y-2 text-center">
              <p className="text-sm text-zinc-900 font-medium">
                {jobStage || t("faqImport.step2.stage1")}
              </p>
              {jobTotalChunks > 1 && (
                <p className="text-xs text-zinc-500">
                  {t("faqImport.step2.chunkProgress", {
                    current: String(jobCurrentChunk),
                    total: String(jobTotalChunks),
                  })}
                </p>
              )}
              {(isLargeFile || jobTotalChunks > 1) && (
                <p className="text-xs text-amber-600 mt-2 pt-2 border-t border-zinc-100">
                  {t("faqImport.step2.longAnalysis")}
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── Step 3: review ───────────────────────────────────────────────── */}
        {step === 3 && (
          <>
            {suggestions.length === 0 ? (
              <div className="flex-1 flex items-center justify-center px-6 pb-10">
                <p className="text-zinc-400 text-sm">{t("faqImport.step3.empty")}</p>
              </div>
            ) : (
              <>
                {/* Bulk actions bar */}
                <div className="flex items-center gap-2 px-6 py-3 border-b shrink-0">
                  <Button variant="outline" size="sm" onClick={() => toggleAll(true)}>
                    {t("faqImport.step3.selectAll")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggleAll(false)}>
                    {t("faqImport.step3.selectNone")}
                  </Button>
                  <span className="text-sm text-zinc-500 ml-auto">
                    {t("faqImport.step3.counter", {
                      n: String(selectedCount),
                      total: String(suggestions.length),
                    })}
                  </span>
                </div>

                {/* Suggestion cards */}
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
                  {(() => { console.log("[faq-import] render suggestions:", suggestions?.length, Array.isArray(suggestions)); return null })()}
                  {(Array.isArray(suggestions) ? suggestions : []).map((s) => (
                    <div
                      key={s.id}
                      className={`border-2 rounded-xl p-4 space-y-3 transition-all ${
                        s.selected
                          ? "border-zinc-300 bg-white"
                          : "border-zinc-100 bg-zinc-50 opacity-60"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={s.selected}
                          onChange={() => toggleOne(s.id)}
                          className="mt-1 w-4 h-4 shrink-0 cursor-pointer"
                        />
                        <div className="flex-1 space-y-2 min-w-0">
                          <div className="space-y-1">
                            <Label className="text-xs font-semibold text-zinc-500">
                              {t("faqImport.step3.questionLabel")}
                            </Label>
                            <Input
                              value={s.question}
                              onChange={(e) => updateField(s.id, "question", e.target.value)}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs font-semibold text-zinc-500">
                              {t("faqImport.step3.answerLabel")}
                            </Label>
                            <Textarea
                              value={s.answer}
                              onChange={(e) => updateField(s.id, "answer", e.target.value)}
                              rows={3}
                            />
                          </div>
                          {s.possibly_duplicate && s.duplicate_of && (
                            <div className="rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2 space-y-0.5">
                              <p className="text-xs font-semibold text-yellow-700">
                                {t("faqImport.step3.duplicateWarning")}
                              </p>
                              <p className="text-xs text-yellow-600">
                                {t("faqImport.step3.duplicateSimilarity", {
                                  q: s.duplicate_of.question,
                                  pct: String(Math.round(s.duplicate_of.similarity * 100)),
                                })}
                              </p>
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => removeSuggestion(s.id)}
                          className="shrink-0 text-zinc-300 hover:text-red-400 transition-colors text-xl leading-none mt-0.5"
                          title="移除"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Bottom action bar */}
            <div className="flex justify-between gap-2 px-6 py-4 border-t shrink-0">
              <Button variant="outline" onClick={onClose}>
                {t("faqImport.step3.cancel")}
              </Button>
              <Button
                onClick={handleImport}
                disabled={selectedCount === 0 || submitting}
              >
                {submitting ? t("faqImport.step3.submitting") : t("faqImport.step3.submit")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
