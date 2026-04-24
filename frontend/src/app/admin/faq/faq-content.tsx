"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase"
import { FaqEntry } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { toast } from "sonner"
import { t } from "@/lib/i18n"
import { backendUrl } from "@/lib/backend"
import FaqImportModal from "./faq-import-modal"

export default function FaqPage() {
  const [faqs, setFaqs] = useState<FaqEntry[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [editing, setEditing] = useState<FaqEntry | null>(null)
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState("")
  const [saving, setSaving] = useState(false)
  const [reembedding, setReembedding] = useState(false)

  const supabase = createClient()

  async function triggerReembed() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    fetch(`${backendUrl}/api/faq/reembed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: user.id }),
    }).catch(() => {})
  }

  async function fetchFaqs() {
    const { data } = await supabase
      .from("faq")
      .select("*")
      .order("created_at", { ascending: false })
    if (data) setFaqs(data)
  }

  useEffect(() => {
    fetchFaqs()
  }, [])

  function openNew() {
    setEditing(null)
    setQuestion("")
    setAnswer("")
    setDialogOpen(true)
  }

  function openEdit(faq: FaqEntry) {
    setEditing(faq)
    setQuestion(faq.question)
    setAnswer(faq.answer)
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!question.trim() || !answer.trim()) {
      toast.error("問題與答案均不可為空")
      return
    }
    setSaving(true)
    try {
      if (editing) {
        const { error } = await supabase
          .from("faq")
          .update({ question, answer })
          .eq("id", editing.id)
        if (error) throw error
        toast.success("已更新")
      } else {
        const { error } = await supabase
          .from("faq")
          .insert({ question, answer })
        if (error) throw error
        toast.success("已新增")
      }
      setDialogOpen(false)
      fetchFaqs()
      triggerReembed()
    } catch (err) {
      toast.error("儲存失敗：" + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  async function handleReembedAll() {
    setReembedding(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error("未登入")
      const res = await fetch(`${backendUrl}/api/faq/reembed-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_id: user.id }),
      })
      if (!res.ok) throw new Error("伺服器錯誤")
      toast.success("已重建所有 FAQ 嵌入索引")
    } catch (err) {
      toast.error("重建失敗：" + (err instanceof Error ? err.message : String(err)))
    } finally {
      setReembedding(false)
    }
  }

  async function handleDelete(id: string) {
    const { error } = await supabase.from("faq").delete().eq("id", id)
    if (error) {
      toast.error("刪除失敗")
    } else {
      toast.success("已刪除")
      fetchFaqs()
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">FAQ 管理</h2>
          <p className="text-zinc-500 text-sm mt-1">管理常見問題與答案</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReembedAll} disabled={reembedding}>
            {reembedding ? "重建中…" : "重建嵌入索引"}
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            {t("faqImport.btn")}
          </Button>
          <Button onClick={openNew}>新增 FAQ</Button>
        </div>
      </div>

      {faqs.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-zinc-400 text-sm">
            尚無 FAQ 項目
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {faqs.map((faq) => (
            <Card key={faq.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-4">
                  <CardTitle className="text-sm font-semibold leading-snug">
                    {faq.question}
                  </CardTitle>
                  <div className="flex gap-2 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => openEdit(faq)}>
                      編輯
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-500 hover:text-red-600"
                      onClick={() => handleDelete(faq.id)}
                    >
                      刪除
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-zinc-600 whitespace-pre-wrap">{faq.answer}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <FaqImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={fetchFaqs}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "編輯 FAQ" : "新增 FAQ"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="faq-question">問題</Label>
              <Input
                id="faq-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="輸入問題"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="faq-answer">答案</Label>
              <Textarea
                id="faq-answer"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="輸入答案"
                rows={5}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "儲存中…" : "儲存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
