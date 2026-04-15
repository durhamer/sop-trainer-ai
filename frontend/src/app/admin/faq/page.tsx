"use client"

import dynamic from "next/dynamic"

const FaqContent = dynamic(() => import("./faq-content"), { ssr: false })

export default function FaqPage() {
  return <FaqContent />
}
