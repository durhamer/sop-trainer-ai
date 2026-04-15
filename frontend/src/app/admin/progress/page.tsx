"use client"

import dynamic from "next/dynamic"

const ProgressContent = dynamic(() => import("./progress-content"), { ssr: false })

export default function ProgressPage() {
  return <ProgressContent />
}
