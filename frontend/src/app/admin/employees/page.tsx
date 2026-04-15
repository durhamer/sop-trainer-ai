"use client"

import dynamic from "next/dynamic"

const EmployeesContent = dynamic(() => import("./employees-content"), { ssr: false })

export default function EmployeesPage() {
  return <EmployeesContent />
}
