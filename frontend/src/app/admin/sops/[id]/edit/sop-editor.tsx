"use client"

import { useState } from "react"
import { createClient } from "@/lib/supabase"
import { ReviewFlags, Sop, SopStep } from "@/lib/types"
import { t } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import Link from "next/link"

interface Props {
  sop: Sop
  initialSteps: SopStep[]
}

// -------------------------------------------------------------------------
// Review helpers
// -------------------------------------------------------------------------

function hasActiveFlags(flags: ReviewFlags | null): boolean {
  if (!flags) return false
  return flags.safety_critical || flags.needs_number_verification || flags.order_dependent
}

function stepBorderClass(step: SopStep): string {
  if (!hasActiveFlags(step.review_flags) || step.review_confirmed) return ""
  const f = step.review_flags!
  if (f.safety_critical) return "border-2 border-red-500"
  if (f.order_dependent) return "border-2 border-orange-500"
  if (f.needs_number_verification) return "border-2 border-yellow-400"
  return ""
}

// -------------------------------------------------------------------------
// Component
// -------------------------------------------------------------------------

export function SopEditor({ sop, initialSteps }: Props) {
  const [title, setTitle] = useState(sop.title)
  const [steps, setSteps] = useState<SopStep[]>(initialSteps)
  const [saving, setSaving] = useState(false)
  const supabase = createClient()

  // ---- step helpers -------------------------------------------------------

  function updateStep(id: string, field: keyof SopStep, value: unknown) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)))
  }

  function updateWarning(stepId: string, index: number, value: string) {
    setSteps((prev) =>
      prev.map((s) => {
        if (s.id !== stepId) return s
        const warnings = [...(s.warnings ?? [])]
        warnings[index] = value
        return { ...s, warnings }
      })
    )
  }

  function addWarning(stepId: string) {
    setSteps((prev) =>
      prev.map((s) =>
        s.id === stepId ? { ...s, warnings: [...(s.warnings ?? []), ""] } : s
      )
    )
  }

  function removeWarning(stepId: string, index: number) {
    setSteps((prev) =>
      prev.map((s) => {
        if (s.id !== stepId) return s
        const warnings = (s.warnings ?? []).filter((_, i) => i !== index)
        return { ...s, warnings }
      })
    )
  }

  function moveStep(index: number, direction: "up" | "down") {
    setSteps((prev) => {
      const next = [...prev]
      const swapIndex = direction === "up" ? index - 1 : index + 1
      if (swapIndex < 0 || swapIndex >= next.length) return prev
      ;[next[index], next[swapIndex]] = [next[swapIndex], next[index]]
      return next.map((s, i) => ({ ...s, step_number: i + 1 }))
    })
  }

  function addStep() {
    const newStep: SopStep = {
      id: `new_${Date.now()}`,
      sop_id: sop.id,
      step_number: steps.length + 1,
      title: "",
      description: "",
      warnings: [],
      image_url: null,
      timestamp_start: null,
      review_flags: null,
      review_confirmed: false,
      created_at: new Date().toISOString(),
    }
    setSteps((prev) => [...prev, newStep])
  }

  function removeStep(id: string) {
    setSteps((prev) =>
      prev
        .filter((s) => s.id !== id)
        .map((s, i) => ({ ...s, step_number: i + 1 }))
    )
  }

  // ---- review confirm -----------------------------------------------------

  async function handleConfirmFlag(stepId: string, confirmed: boolean) {
    // Update local state immediately for instant UI feedback
    updateStep(stepId, "review_confirmed", confirmed)

    // Persist to Supabase if the step already exists in DB
    if (!stepId.startsWith("new_")) {
      await supabase
        .from("sop_steps")
        .update({ review_confirmed: confirmed })
        .eq("id", stepId)
    }
  }

  // ---- save ---------------------------------------------------------------

  async function handleSave() {
    setSaving(true)
    try {
      const { error: sopError } = await supabase
        .from("sops")
        .update({ title })
        .eq("id", sop.id)
      if (sopError) throw sopError

      // Delete all existing steps and re-insert (simplest strategy for reorder)
      const { error: deleteError } = await supabase
        .from("sop_steps")
        .delete()
        .eq("sop_id", sop.id)
      if (deleteError) throw deleteError

      if (steps.length > 0) {
        const { error: insertError } = await supabase.from("sop_steps").insert(
          steps.map((s, i) => ({
            sop_id: sop.id,
            step_number: i + 1,
            title: s.title,
            description: s.description,
            warnings: s.warnings,
            image_url: s.image_url,
            review_flags: s.review_flags ?? null,
            review_confirmed: s.review_confirmed ?? false,
          }))
        )
        if (insertError) throw insertError
      }

      toast.success(t("editor.toast.saveSuccess"))
    } catch (err) {
      toast.error(
        t("editor.toast.saveError") +
          (err instanceof Error ? err.message : String(err))
      )
    } finally {
      setSaving(false)
    }
  }

  // ---- render -------------------------------------------------------------

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-zinc-500 mb-1">
            <Link href="/admin/sops" className="hover:underline">
              {t("editor.breadcrumb.sopList")}
            </Link>
            <span>/</span>
            <span>{t("editor.breadcrumb.edit")}</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight">{t("editor.pageTitle")}</h2>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? t("editor.btn.saving") : t("editor.btn.save")}
        </Button>
      </div>

      {/* SOP title */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <Label htmlFor="sop-title">{t("editor.field.sopTitle")}</Label>
            <Input
              id="sop-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("editor.field.sopTitlePlaceholder")}
            />
          </div>
        </CardContent>
      </Card>

      {/* Steps */}
      <div className="space-y-3">
        {steps.map((step, index) => {
          const flagged = hasActiveFlags(step.review_flags) && !step.review_confirmed
          const f = step.review_flags

          return (
            <Card key={step.id} className={stepBorderClass(step)}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-2 flex-1 min-w-0">
                    <CardTitle className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      <Badge variant="outline">
                        {t("editor.step.label", { n: index + 1 })}
                      </Badge>

                      {/* Flag type badges */}
                      {flagged && f && (
                        <>
                          {f.safety_critical && (
                            <Badge className="text-xs bg-red-500 hover:bg-red-600">
                              {t("review.flag.safety_critical")}
                            </Badge>
                          )}
                          {f.order_dependent && (
                            <Badge className="text-xs bg-orange-500 hover:bg-orange-600">
                              {t("review.flag.order_dependent")}
                            </Badge>
                          )}
                          {f.needs_number_verification && (
                            <Badge className="text-xs bg-yellow-400 hover:bg-yellow-500 text-black">
                              {t("review.flag.needs_number_verification")}
                            </Badge>
                          )}
                        </>
                      )}
                    </CardTitle>

                    {/* Flag notes + confirm checkbox */}
                    {flagged && f && (
                      <div className="space-y-1">
                        {f.notes && (
                          <p className="text-xs text-zinc-500">
                            {t("review.flag.reason")}
                            {f.notes}
                          </p>
                        )}
                        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={step.review_confirmed}
                            onChange={(e) => handleConfirmFlag(step.id, e.target.checked)}
                            className="w-4 h-4 accent-zinc-700"
                          />
                          {t("review.confirm.label")}
                        </label>
                      </div>
                    )}
                  </div>

                  {/* Move / delete controls */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => moveStep(index, "up")}
                      disabled={index === 0}
                      className="h-7 px-2 text-xs"
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => moveStep(index, "down")}
                      disabled={index === steps.length - 1}
                      className="h-7 px-2 text-xs"
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeStep(step.id)}
                      className="h-7 px-2 text-xs text-red-500 hover:text-red-600"
                    >
                      {t("editor.step.btnDelete")}
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t("editor.step.fieldTitle")}</Label>
                  <Input
                    value={step.title}
                    onChange={(e) => updateStep(step.id, "title", e.target.value)}
                    placeholder={t("editor.step.fieldTitlePlaceholder")}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("editor.step.fieldDesc")}</Label>
                  <Textarea
                    value={step.description ?? ""}
                    onChange={(e) => updateStep(step.id, "description", e.target.value)}
                    placeholder={t("editor.step.fieldDescPlaceholder")}
                    rows={3}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t("editor.step.fieldWarnings")}</Label>
                  {(step.warnings ?? []).map((warning, wIdx) => (
                    <div key={wIdx} className="flex gap-2">
                      <Input
                        value={warning}
                        onChange={(e) => updateWarning(step.id, wIdx, e.target.value)}
                        placeholder={t("editor.step.warningPlaceholder")}
                        className="text-sm"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeWarning(step.id, wIdx)}
                        className="shrink-0 text-red-500 hover:text-red-600"
                      >
                        ✕
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => addWarning(step.id)}
                    className="text-xs h-7"
                  >
                    {t("editor.step.btnAddWarning")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Button variant="outline" onClick={addStep} className="w-full">
        {t("editor.btn.addStep")}
      </Button>
    </div>
  )
}
