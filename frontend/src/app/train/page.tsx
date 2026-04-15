"use client"

import dynamic from "next/dynamic"

const TrainContent = dynamic(() => import("./train-content"), { ssr: false })

export default function TrainPage() {
  return <TrainContent />
}
