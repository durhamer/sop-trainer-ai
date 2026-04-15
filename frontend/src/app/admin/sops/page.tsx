"use client"

import dynamic from "next/dynamic"

const SopsContent = dynamic(() => import("./sops-content"), { ssr: false })

export default function SopsPage() {
  return <SopsContent />
}
