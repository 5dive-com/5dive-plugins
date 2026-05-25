// Shared types for the telegram plugin's hook scripts.
//
// HookPayload is a partial subset — claude sends more keys; we only type what
// at least one hook reads. TranscriptEntry intentionally permissive: the
// JSONL format mutates across claude versions and missing fields are common,
// so consumers narrow with `select`-style guards rather than relying on
// schema rigor.

export type HookPayload = {
  tool_name?: string
  transcript_path?: string
  stop_hook_active?: boolean
  message?: string
  reason?: string
  error?: string | { resetsAt?: number | string }
  stopReason?: string
  resetsAt?: number | string
  reset_at?: number | string
  resetAt?: number | string
  rateLimit?: { resetsAt?: number | string }
}

export type TranscriptContentBlock = {
  type: string
  text?: string
  name?: string
}

export type TranscriptEntry = {
  type?: 'user' | 'assistant' | string
  message?: {
    content?: string | TranscriptContentBlock[]
  }
  error?: string
  isApiErrorMessage?: boolean
}

export type AccessConfig = {
  allowFrom?: string[]
  groups?: Record<string, unknown>
  pending?: Record<string, unknown>
}

export type SilenceState = {
  lastInboundAt?: number
  lastReplyAt?: number
  lastReminderAt?: number
  toolCallsSinceReply?: number
}
