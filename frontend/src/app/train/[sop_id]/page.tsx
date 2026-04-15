"use client"

import dynamic from "next/dynamic"

const SopReader = dynamic(() => import("./sop-reader"), { ssr: false })

export default function SopReaderPage() {
  return <SopReader />
}
