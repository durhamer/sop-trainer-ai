import { createServerSupabase } from "@/lib/supabase-server"
import { notFound } from "next/navigation"
import { SopEditor } from "./sop-editor"

export const dynamic = "force-dynamic"

export default async function EditSopPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createServerSupabase()

  const { data: sop } = await supabase
    .from("sops")
    .select("*")
    .eq("id", id)
    .single()

  if (!sop) notFound()

  const { data: steps } = await supabase
    .from("sop_steps")
    .select("*")
    .eq("sop_id", id)
    .order("step_number")

  return <SopEditor sop={sop} initialSteps={steps ?? []} />
}
