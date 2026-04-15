"use client"

import { useCallback, useEffect, useState } from "react"
import { createClient } from "@/lib/supabase"
import { ReviewFlags, Sop } from "@/lib/types"
import { t } from "@/lib/i18n"
import { backendUrl } from "@/lib/backend"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "sonner"
import Link from "next/link"

type SopWithVideo = Sop & { videos?: { filename: string } | null }

type StepFlag = {
  sop_id: string
  review_flags: ReviewFlags | null
  review_confirmed: boolean
}

type ReviewState =
  | { kind: "unreviewed" }
  | { kind: "pending"; count: number }
  | { kind: "confirmed" }

function hasActiveFlags(flags: ReviewFlags | null): boolean {
  if (!flags) return false
  return flags.safety_critical || flags.needs_number_verification || flags.order_dependent
}

function computeReviewState(sopId: string, allStepFlags: StepFlag[]): ReviewState {
  const steps = allStepFlags.filter((s) => s.sop_id === sopId)
  if (steps.length === 0) return { kind: "unreviewed" }

  const reviewedSteps = steps.filter((s) => s.review_flags !== null)
  if (reviewedSteps.length === 0) return { kind: "unreviewed" }

  const pendingCount = reviewedSteps.filter(
    (s) => !s.review_confirmed && hasActiveFlags(s.review_flags)
  ).length

  if (pendingCount > 0) return { kind: "pending", count: pendingCount }
  return { kind: "confirmed" }
}

function ReviewBadge({ state }: { state: ReviewState }) {
  if (state.kind === "unreviewed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
        <span className="w-2 h-2 rounded-full bg-zinc-300 shrink-0" />
        {t("sops.review.unreviewed")}
      </span>
    )
  }
  if (state.kind === "pending") {
    return (
      <Badge variant="destructive" className="text-xs shrink-0">
        {t("sops.review.pendingBadge", { count: state.count })}
      </Badge>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-green-600">
      <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
      {t("sops.review.confirmed")}
    </span>
  )
}

export default function SopsContent() {
  const [sops, setSops] = useState<SopWithVideo[]>([])
  const [stepFlags, setStepFlags] = useState<StepFlag[]>([])
  const [reviewing, setReviewing] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

  const fetchData = useCallback(async () => {
    const [{ data: sopData }, { data: flagData }] = await Promise.all([
      supabase
        .from("sops")
        .select("*, videos(filename)")
        .order("created_at", { ascending: false }),
      supabase
        .from("sop_steps")
        .select("sop_id, review_flags, review_confirmed"),
    ])

    setSops(sopData ?? [])
    setStepFlags((flagData ?? []) as StepFlag[])
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function handleTogglePublish(sop: SopWithVideo) {
    const next = !sop.published
    // Optimistic update
    setSops((prev) =>
      prev.map((s) => (s.id === sop.id ? { ...s, published: next } : s))
    )
    const { error } = await supabase
      .from("sops")
      .update({ published: next })
      .eq("id", sop.id)
    if (error) {
      // Roll back on failure
      setSops((prev) =>
        prev.map((s) => (s.id === sop.id ? { ...s, published: !next } : s))
      )
      toast.error(error.message)
    }
  }

  async function handleRereview(sopId: string) {
    setReviewing((prev) => new Set(prev).add(sopId))
    try {
      const res = await fetch(`${backendUrl}/sops/${sopId}/review`, { method: "POST" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(t("sops.review.rerequestSuccess"))
      await fetchData()
    } catch (err) {
      toast.error(
        t("sops.review.rerequestError") +
          ": " +
          (err instanceof Error ? err.message : String(err))
      )
    } finally {
      setReviewing((prev) => {
        const next = new Set(prev)
        next.delete(sopId)
        return next
      })
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-center text-zinc-400 text-sm">{t("sops.loading")}</div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t("sops.pageTitle")}</h2>
        <p className="text-zinc-500 text-sm mt-1">{t("sops.pageSubtitle")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("sops.cardTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {sops.length === 0 ? (
            <div className="p-8 text-center text-zinc-400 text-sm">{t("sops.empty")}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("sops.col.title")}</TableHead>
                  <TableHead>{t("sops.col.sourceVideo")}</TableHead>
                  <TableHead>{t("sops.col.createdAt")}</TableHead>
                  <TableHead className="w-40">{t("sops.col.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sops.map((sop) => {
                  const reviewState = computeReviewState(sop.id, stepFlags)
                  const isReviewing = reviewing.has(sop.id)
                  return (
                    <TableRow key={sop.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span>{sop.title}</span>
                          <ReviewBadge state={reviewState} />
                          {!sop.published && (
                            <Badge variant="outline" className="text-xs text-zinc-400 border-zinc-300">
                              {t("sops.badge.draft")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {sop.videos ? (
                          <Badge
                            variant="outline"
                            className="font-normal max-w-xs truncate inline-block"
                          >
                            {sop.videos.filename}
                          </Badge>
                        ) : (
                          <span className="text-zinc-400 text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-zinc-500 text-sm">
                        {new Date(sop.created_at).toLocaleString("zh-TW")}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Link href={`/admin/sops/${sop.id}/edit`}>
                            <Button size="sm" variant="outline">
                              {t("sops.btn.edit")}
                            </Button>
                          </Link>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleTogglePublish(sop)}
                            className="text-xs text-zinc-500"
                          >
                            {sop.published
                              ? t("sops.btn.unpublish")
                              : t("sops.btn.publish")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleRereview(sop.id)}
                            disabled={isReviewing}
                            className="text-xs text-zinc-500"
                          >
                            {isReviewing
                              ? t("sops.btn.rereviewLoading")
                              : t("sops.btn.rereview")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
