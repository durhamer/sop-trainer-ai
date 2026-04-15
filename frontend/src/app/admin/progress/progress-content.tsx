"use client"

import { useEffect, useMemo, useState } from "react"
import { createClient } from "@/lib/supabase"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { t } from "@/lib/i18n"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProgressRow = {
  id: string
  employee_id: string
  sop_id: string
  current_step: number
  completed_steps: number[]
  started_at: string
  completed_at: string | null
  employees: { name: string } | null
  sops: { title: string; sop_steps: { id: string }[] } | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusLabel(row: ProgressRow): string {
  if (row.completed_at) return t("adminProgress.status.completed")
  return t("adminProgress.status.inProgress")
}

function statusVariant(row: ProgressRow): "default" | "secondary" | "outline" {
  if (row.completed_at) return "default"
  return "secondary"
}

function formatDate(iso: string | null): string {
  if (!iso) return t("adminProgress.notCompleted")
  return new Date(iso).toLocaleString("zh-TW", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProgressContent() {
  const [rows, setRows] = useState<ProgressRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filterEmployee, setFilterEmployee] = useState("")
  const [filterSop, setFilterSop] = useState("")

  const supabase = createClient()

  useEffect(() => {
    supabase
      .from("training_progress")
      .select("*, employees(name), sops(title, sop_steps(id))")
      .order("started_at", { ascending: false })
      .then(({ data }) => {
        setRows((data ?? []) as ProgressRow[])
        setLoading(false)
      })
  }, [])

  // Unique employees and SOPs for filter dropdowns
  const employeeOptions = useMemo(() => {
    const seen = new Map<string, string>()
    rows.forEach((r) => {
      if (r.employee_id && r.employees?.name) seen.set(r.employee_id, r.employees.name)
    })
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }))
  }, [rows])

  const sopOptions = useMemo(() => {
    const seen = new Map<string, string>()
    rows.forEach((r) => {
      if (r.sop_id && r.sops?.title) seen.set(r.sop_id, r.sops.title)
    })
    return Array.from(seen.entries()).map(([id, title]) => ({ id, title }))
  }, [rows])

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filterEmployee && r.employee_id !== filterEmployee) return false
      if (filterSop && r.sop_id !== filterSop) return false
      return true
    })
  }, [rows, filterEmployee, filterSop])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-zinc-400 text-sm">{t("adminProgress.loading")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t("adminProgress.pageTitle")}</h2>
        <p className="text-zinc-500 text-sm mt-1">{t("adminProgress.pageSubtitle")}</p>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={filterEmployee}
          onChange={(e) => setFilterEmployee(e.target.value)}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm bg-white
                     focus:outline-none focus:ring-2 focus:ring-zinc-300"
        >
          <option value="">{t("adminProgress.filter.allEmployees")}</option>
          {employeeOptions.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>

        <select
          value={filterSop}
          onChange={(e) => setFilterSop(e.target.value)}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm bg-white
                     focus:outline-none focus:ring-2 focus:ring-zinc-300"
        >
          <option value="">{t("adminProgress.filter.allSops")}</option>
          {sopOptions.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("adminProgress.cardTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-zinc-400 text-sm">
              {t("adminProgress.empty")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adminProgress.col.employee")}</TableHead>
                  <TableHead>{t("adminProgress.col.sop")}</TableHead>
                  <TableHead>{t("adminProgress.col.progress")}</TableHead>
                  <TableHead>{t("adminProgress.col.status")}</TableHead>
                  <TableHead>{t("adminProgress.col.startedAt")}</TableHead>
                  <TableHead>{t("adminProgress.col.completedAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => {
                  const totalSteps = row.sops?.sop_steps?.length ?? 0
                  const doneSteps = row.completed_steps?.length ?? 0
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        {row.employees?.name ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-xs truncate">
                        {row.sops?.title ?? "—"}
                      </TableCell>
                      <TableCell className="tabular-nums text-sm">
                        {totalSteps > 0 ? `${doneSteps} / ${totalSteps}` : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(row)}>
                          {statusLabel(row)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-zinc-500 text-sm">
                        {formatDate(row.started_at)}
                      </TableCell>
                      <TableCell className="text-zinc-500 text-sm">
                        {formatDate(row.completed_at)}
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
