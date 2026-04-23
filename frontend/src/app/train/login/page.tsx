"use client"

import { t } from "@/lib/i18n"

export default function TrainLoginFallbackPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">{t("train.login.title")}</h1>
      <p className="text-xl text-slate-500 max-w-sm">{t("train.login.noStoreUrl")}</p>
    </div>
  )
}
