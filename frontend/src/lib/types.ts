export type VideoStatus =
  | "uploaded"
  | "uploading"
  | "processing"
  | "extracting_audio"
  | "transcribing"
  | "analyzing_frames"
  | "generating_sop"
  | "done"
  | "error"

export type ReviewFlags = {
  safety_critical: boolean
  needs_number_verification: boolean
  order_dependent: boolean
  notes?: string
}

export type Database = {
  public: {
    Tables: {
      videos: {
        Row: {
          id: string
          filename: string
          storage_path: string
          status: VideoStatus
          current_stage: string | null
          progress_percent: number | null
          error_message: string | null
          created_at: string
          user_id: string | null
        }
        Insert: {
          id?: string
          filename: string
          storage_path: string
          status?: VideoStatus
          current_stage?: string | null
          progress_percent?: number | null
          error_message?: string | null
          created_at?: string
          user_id?: string | null
        }
        Update: {
          id?: string
          filename?: string
          storage_path?: string
          status?: VideoStatus
          current_stage?: string | null
          progress_percent?: number | null
          error_message?: string | null
          created_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      sops: {
        Row: {
          id: string
          video_id: string | null
          title: string
          raw_json: Record<string, unknown> | null
          published: boolean
          video_url: string | null
          created_at: string
        }
        Insert: {
          id?: string
          video_id?: string | null
          title: string
          raw_json?: Record<string, unknown> | null
          published?: boolean
          video_url?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          video_id?: string | null
          title?: string
          raw_json?: Record<string, unknown> | null
          published?: boolean
          video_url?: string | null
          created_at?: string
        }
        Relationships: []
      }
      sop_steps: {
        Row: {
          id: string
          sop_id: string
          step_number: number
          title: string
          description: string | null
          warnings: string[] | null
          image_url: string | null
          timestamp_start: number | null
          review_flags: ReviewFlags | null
          review_confirmed: boolean
          created_at: string
        }
        Insert: {
          id?: string
          sop_id: string
          step_number: number
          title: string
          description?: string | null
          warnings?: string[] | null
          image_url?: string | null
          timestamp_start?: number | null
          review_flags?: ReviewFlags | null
          review_confirmed?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          sop_id?: string
          step_number?: number
          title?: string
          description?: string | null
          warnings?: string[] | null
          image_url?: string | null
          timestamp_start?: number | null
          review_flags?: ReviewFlags | null
          review_confirmed?: boolean
          created_at?: string
        }
        Relationships: []
      }
      faq: {
        Row: {
          id: string
          question: string
          answer: string
          created_at: string
        }
        Insert: {
          id?: string
          question: string
          answer: string
          created_at?: string
        }
        Update: {
          id?: string
          question?: string
          answer?: string
          created_at?: string
        }
        Relationships: []
      }
      employees: {
        Row: {
          id: string
          store_id: string | null
          name: string
          pin_hash: string
          created_at: string
        }
        Insert: {
          id?: string
          store_id?: string | null
          name: string
          pin_hash: string
          created_at?: string
        }
        Update: {
          id?: string
          store_id?: string | null
          name?: string
          pin_hash?: string
          created_at?: string
        }
        Relationships: []
      }
      training_progress: {
        Row: {
          id: string
          employee_id: string
          sop_id: string
          current_step: number
          completed_steps: number[]
          started_at: string
          completed_at: string | null
        }
        Insert: {
          id?: string
          employee_id: string
          sop_id: string
          current_step?: number
          completed_steps?: number[]
          started_at?: string
          completed_at?: string | null
        }
        Update: {
          id?: string
          employee_id?: string
          sop_id?: string
          current_step?: number
          completed_steps?: number[]
          started_at?: string
          completed_at?: string | null
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
  }
}

export type Video = Database["public"]["Tables"]["videos"]["Row"]
export type Sop = Database["public"]["Tables"]["sops"]["Row"]
export type SopStep = Database["public"]["Tables"]["sop_steps"]["Row"]
export type FaqEntry = Database["public"]["Tables"]["faq"]["Row"]
export type Employee = Database["public"]["Tables"]["employees"]["Row"]
export type TrainingProgress = Database["public"]["Tables"]["training_progress"]["Row"]
