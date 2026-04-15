"use client"

import dynamic from "next/dynamic"

const VideosContent = dynamic(() => import("./videos-content"), { ssr: false })

export default function VideosPage() {
  return <VideosContent />
}
