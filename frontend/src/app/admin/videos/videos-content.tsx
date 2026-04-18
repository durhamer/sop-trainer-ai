"use client"

import { useEffect, useRef, useState } from "react"
import { createClient } from "@/lib/supabase"
import { Video } from "@/lib/types"
import { backendUrl } from "@/lib/backend"
import { t } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "sonner"

const STATUS_LABEL: Record<string, string> = {
  uploading:  "上傳中...",
  uploaded:   "已上傳",
  processing: "處理中",
  done:       "完成",
  error:      "錯誤",
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  uploading:  "secondary",
  uploaded:   "outline",
  processing: "secondary",
  done:       "default",
  error:      "destructive",
}

export default function VideosPage() {
  const [videos, setVideos] = useState<Video[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const supabase = createClient()

  async function fetchVideos() {
    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .order("created_at", { ascending: false })
    if (!error && data) setVideos(data)
  }

  useEffect(() => {
    fetchVideos()

    // Poll every 3s to update processing status
    const interval = setInterval(fetchVideos, 3000)
    return () => clearInterval(interval)
  }, [])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const allowedTypes = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"]
    if (!allowedTypes.includes(file.type)) {
      toast.error("僅支援 MP4、MOV、AVI、WebM 格式")
      return
    }

    if (file.size > 500 * 1024 * 1024) {
      toast.error("檔案大小不得超過 500MB")
      return
    }

    setUploading(true)
    setUploadProgress(0)

    try {
      // 1. Get current user
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error("未登入")

      // 2. Upload to Supabase Storage
      // Strip non-ASCII chars so Supabase Storage accepts the key
      const safeName = file.name.replace(/[^\x00-\x7F]/g, "_")
      const storagePath = `videos/${user.id}/${Date.now()}_${safeName}`

      // Simulate upload progress via XMLHttpRequest for real progress events
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            setUploadProgress(Math.round((event.loaded / event.total) * 90))
          }
        })
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve()
          } else {
            reject(new Error(`上傳失敗：HTTP ${xhr.status}`))
          }
        })
        xhr.addEventListener("error", () => reject(new Error("網路錯誤")))

        // Use fetch-based upload through Supabase Storage directly
        supabase.storage
          .from("training-videos")
          .upload(storagePath, file, { upsert: false })
          .then(({ error }) => {
            if (error) reject(error)
            else resolve()
          })
          .catch(reject)

        // Close the XHR (we used it only for progress simulation)
        xhr.abort()
      })

      setUploadProgress(90)

      // 3. Insert video record
      const { data: videoRecord, error: insertError } = await supabase
        .from("videos")
        .insert({
          filename: file.name,
          storage_path: storagePath,
          status: "uploaded",
          user_id: user.id,
        })
        .select()
        .single()

      if (insertError) throw insertError

      setUploadProgress(95)

      // 4. Trigger backend pipeline
      const triggerRes = await fetch(`${backendUrl}/pipeline/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_id: videoRecord.id,
          storage_path: storagePath,
        }),
      })

      if (!triggerRes.ok) {
        // Non-fatal: pipeline trigger failed but video was saved
        toast.warning("影片已上傳，但自動處理觸發失敗，請稍後手動重試")
      } else {
        toast.success("影片已上傳，正在排入處理佇列")
      }

      setUploadProgress(100)
      fetchVideos()
    } catch (err) {
      toast.error("上傳失敗：" + (err instanceof Error ? err.message : String(err)))
    } finally {
      setUploading(false)
      setUploadProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === videos.length ? new Set() : new Set(videos.map((v) => v.id))
    )
  }

  async function handleBulkDelete() {
    setDeleting(true)
    try {
      const ids = Array.from(selected)
      const res = await fetch(`${backendUrl}/api/videos/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_ids: ids }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      toast.success(t("bulkDelete.successVideos", { n: String(ids.length) }))
      setSelected(new Set())
      setConfirmOpen(false)
      fetchVideos()
    } catch (err) {
      toast.error(t("bulkDelete.error", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setDeleting(false)
    }
  }

  async function handleRetrigger(video: Video) {
    const res = await fetch(`${backendUrl}/pipeline/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id: video.id,
        storage_path: video.storage_path,
      }),
    })
    if (res.ok) {
      await supabase.from("videos").update({ status: "processing", error_message: null }).eq("id", video.id)
      toast.success("已重新觸發處理")
      fetchVideos()
    } else {
      toast.error("觸發失敗")
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">影片管理</h2>
          <p className="text-zinc-500 text-sm mt-1">上傳訓練影片，系統將自動產生 SOP</p>
        </div>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmOpen(true)}
            >
              {t("bulkDelete.btn", { n: String(selected.size) })}
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/x-msvideo,video/webm"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "上傳中…" : "上傳影片"}
          </Button>
        </div>
      </div>

      {uploading && (
        <Card>
          <CardContent className="pt-6 space-y-2">
            <div className="flex justify-between text-sm text-zinc-600">
              <span>上傳進度</span>
              <span>{uploadProgress}%</span>
            </div>
            <Progress value={uploadProgress} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">影片列表</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {videos.length === 0 ? (
            <div className="p-8 text-center text-zinc-400 text-sm">
              尚未上傳任何影片
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-zinc-700 cursor-pointer"
                      checked={videos.length > 0 && selected.size === videos.length}
                      onChange={toggleSelectAll}
                      aria-label={t("bulkDelete.selectAll")}
                    />
                  </TableHead>
                  <TableHead>檔案名稱</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead>上傳時間</TableHead>
                  <TableHead className="w-28">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {videos.map((video) => {
                  const isProcessing = video.status === "processing" || video.status === "uploading"
                  const pct = video.progress_percent ?? 0
                  return (
                    <TableRow key={video.id} data-state={selected.has(video.id) ? "selected" : undefined}>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="w-4 h-4 accent-zinc-700 cursor-pointer"
                          checked={selected.has(video.id)}
                          onChange={() => toggleSelect(video.id)}
                        />
                      </TableCell>
                      <TableCell className="font-medium max-w-xs truncate">{video.filename}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[video.status] ?? "secondary"}>
                          {STATUS_LABEL[video.status] ?? video.status}
                        </Badge>
                        {isProcessing && video.current_stage && (
                          <div className="mt-2 space-y-1 min-w-[180px]">
                            <div className="flex items-center justify-between text-xs text-zinc-500">
                              <span>{video.current_stage}</span>
                              <span className="tabular-nums">{pct}%</span>
                            </div>
                            <Progress value={pct} className="h-1" />
                          </div>
                        )}
                        {video.status === "done" && video.current_stage && (
                          <p className="text-xs text-zinc-400 mt-1">{video.current_stage}</p>
                        )}
                        {video.error_message && (
                          <p className="text-xs text-red-500 mt-1 max-w-xs truncate">{video.error_message}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-zinc-500 text-sm">
                        {new Date(video.created_at).toLocaleString("zh-TW")}
                      </TableCell>
                      <TableCell>
                        {video.status === "error" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRetrigger(video)}
                          >
                            重試
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Confirmation dialog */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-base font-semibold">{t("bulkDelete.confirmTitle")}</h3>
            <p className="text-sm text-zinc-600">
              {t("bulkDelete.confirmVideos", { n: String(selected.size) })}
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
              >
                {t("bulkDelete.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBulkDelete}
                disabled={deleting}
              >
                {deleting ? t("bulkDelete.deleting") : t("bulkDelete.confirm")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
