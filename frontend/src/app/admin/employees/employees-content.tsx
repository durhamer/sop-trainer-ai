"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase"
import { Employee } from "@/lib/types"
import { hashPin } from "@/lib/employee-session"
import { t } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"

export default function EmployeesContent() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Employee | null>(null)
  const [name, setName] = useState("")
  const [pin, setPin] = useState("")
  const [saving, setSaving] = useState(false)

  const supabase = createClient()

  async function fetchEmployees() {
    const { data } = await supabase
      .from("employees")
      .select("*")
      .order("created_at", { ascending: false })
    setEmployees(data ?? [])
    setLoading(false)
  }

  useEffect(() => { fetchEmployees() }, [])

  function openAdd() {
    setEditing(null)
    setName("")
    setPin("")
    setDialogOpen(true)
  }

  function openEdit(employee: Employee) {
    setEditing(employee)
    setName(employee.name)
    setPin("") // never pre-fill PIN
    setDialogOpen(true)
  }

  async function handleSave() {
    const trimmedName = name.trim()
    const trimmedPin = pin.trim()

    if (!trimmedName) {
      toast.error(t("employees.validation.nameRequired"))
      return
    }

    const isNewPin = trimmedPin.length > 0
    if (isNewPin && (!/^\d{4,6}$/.test(trimmedPin))) {
      toast.error(t("employees.validation.pinFormat"))
      return
    }

    // Adding a new employee requires a PIN
    if (!editing && !isNewPin) {
      toast.error(t("employees.validation.pinFormat"))
      return
    }

    setSaving(true)
    try {
      if (editing) {
        // Update name (always) and pin_hash (only if new PIN entered)
        const payload: Record<string, string> = { name: trimmedName }
        if (isNewPin) {
          payload.pin_hash = await hashPin(trimmedPin)
        }
        const { error } = await supabase
          .from("employees")
          .update(payload)
          .eq("id", editing.id)
        if (error) throw error
        toast.success(t("employees.toast.editSuccess"))
      } else {
        const pin_hash = await hashPin(trimmedPin)
        const { error } = await supabase
          .from("employees")
          .insert({ name: trimmedName, pin_hash })
        if (error) throw error
        toast.success(t("employees.toast.addSuccess"))
      }
      setDialogOpen(false)
      fetchEmployees()
    } catch (err) {
      toast.error(
        t("employees.toast.saveError") +
          (err instanceof Error ? err.message : String(err))
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    const { error } = await supabase.from("employees").delete().eq("id", id)
    if (error) {
      toast.error(t("employees.toast.deleteError"))
    } else {
      toast.success(t("employees.toast.deleteSuccess"))
      fetchEmployees()
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            {t("employees.pageTitle")}
          </h2>
          <p className="text-zinc-500 text-sm mt-1">{t("employees.pageSubtitle")}</p>
        </div>
        <Button onClick={openAdd}>{t("employees.btn.add")}</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("employees.pageTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-zinc-400 text-sm">
              {t("employees.loading")}
            </div>
          ) : employees.length === 0 ? (
            <div className="p-8 text-center text-zinc-400 text-sm">
              {t("employees.empty")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("employees.col.name")}</TableHead>
                  <TableHead>{t("employees.col.pin")}</TableHead>
                  <TableHead>{t("employees.col.createdAt")}</TableHead>
                  <TableHead className="w-32">{t("employees.col.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {employees.map((emp) => (
                  <TableRow key={emp.id}>
                    <TableCell className="font-medium">{emp.name}</TableCell>
                    <TableCell className="text-zinc-400 tracking-widest">
                      {t("employees.pinMasked")}
                    </TableCell>
                    <TableCell className="text-zinc-500 text-sm">
                      {new Date(emp.created_at).toLocaleString("zh-TW")}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openEdit(emp)}
                        >
                          {t("employees.btn.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-500 hover:text-red-600"
                          onClick={() => handleDelete(emp.id)}
                        >
                          {t("employees.btn.delete")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("employees.dialog.editTitle")
                : t("employees.dialog.addTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t("employees.field.name")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("employees.field.namePlaceholder")}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("employees.field.pin")}</Label>
              <Input
                type="password"
                inputMode="numeric"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder={
                  editing
                    ? t("employees.field.pinEditHint")
                    : t("employees.field.pinPlaceholder")
                }
              />
              {editing && (
                <p className="text-xs text-zinc-400">
                  {t("employees.field.pinEditHint")}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("employees.btn.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t("employees.btn.saving") : t("employees.btn.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
