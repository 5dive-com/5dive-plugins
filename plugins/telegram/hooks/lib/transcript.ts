import { readFileSync } from 'fs'
import type { TranscriptContentBlock, TranscriptEntry } from './types'

// Read a JSONL transcript file into entries. Malformed lines are silently
// dropped — claude occasionally writes a partial line that we'll see again
// on the next read. Returns [] on file-not-found.
export function readEntries(transcriptPath: string): TranscriptEntry[] {
  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf8')
  } catch {
    return []
  }
  const out: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip
    }
  }
  return out
}

// Find the most-recent rate-limit notice text. claude logs it as a
// synthetic assistant message tagged error="rate_limit" with
// isApiErrorMessage=true; the text content carries the verbatim
// "resets Xpm (TZ)" line claude received from the 429 response.
// Immune to the tmux alt-screen issue that hides the pane line when the
// "Stop and wait" menu is showing.
export function findRateLimitText(entries: TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.error !== 'rate_limit' || !e.isApiErrorMessage) continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
    }
  }
  return null
}

// Per-turn analysis for stop-reply-check. A turn starts at the most-recent
// entry where type=user AND .message.content is a STRING — that pattern is
// the initial real user/channel prompt (tool_result feedback also has
// type=user but content is an array, so it's excluded). Within the turn:
//   - hadInbound: any user content (initial OR system-reminder embedded in
//     a tool_result) contains a telegram <channel> block.
//   - hadTool: any assistant tool_use called one of the telegram MCP tools.
//   - hadSend: a strict subset of hadTool — reply or edit_message only
//     (react / download_attachment don't count as a text answer).
//   - texts: every non-empty assistant text block in turn order.
//   - lastChatId / lastMessageId: from the most-recent inbound.
export type TurnAnalysis = {
  turnStart: number
  hadInbound: boolean
  hadTool: boolean
  hadSend: boolean
  texts: string[]
  lastChatId: string | null
  lastMessageId: string | null
}

export function analyzeTurn(entries: TranscriptEntry[], tgPrefix: string): TurnAnalysis {
  // Find turn start.
  let turnStart = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'user' && typeof e.message?.content === 'string') {
      turnStart = i
      break
    }
  }
  const turn = entries.slice(turnStart)

  const chatRe = /source="plugin:telegram:telegram"\s+chat_id="(\d+)"/
  const msgRe = /source="plugin:telegram:telegram"[^>]*message_id="(\d+)"/

  let hadInbound = false
  let hadTool = false
  let hadSend = false
  const texts: string[] = []
  let lastChatId: string | null = null
  let lastMessageId: string | null = null

  for (const e of turn) {
    if (e.type === 'user') {
      const content =
        typeof e.message?.content === 'string'
          ? e.message.content
          : JSON.stringify(e.message?.content ?? '')
      if (content.includes('source="plugin:telegram:telegram"')) {
        hadInbound = true
        const cm = chatRe.exec(content)
        if (cm) lastChatId = cm[1]
        const mm = msgRe.exec(content)
        if (mm) lastMessageId = mm[1]
      }
    } else if (e.type === 'assistant') {
      const content = e.message?.content
      if (!Array.isArray(content)) continue
      // Join all text blocks in this assistant message and push as one entry
      // (matches the bash behavior: per-message text join, not per-block).
      const joined = content
        .filter((b: TranscriptContentBlock) => b.type === 'text' && typeof b.text === 'string')
        .map((b: TranscriptContentBlock) => b.text!)
        .join('\n')
      if (joined.length > 0) texts.push(joined)
      for (const block of content) {
        if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(tgPrefix)) {
          hadTool = true
          if (block.name === `${tgPrefix}reply` || block.name === `${tgPrefix}edit_message`) {
            hadSend = true
          }
        }
      }
    }
  }

  return { turnStart, hadInbound, hadTool, hadSend, texts, lastChatId, lastMessageId }
}

// Scan transcript entries past a given line index for any telegram tool
// call. Used by stop-reply-check's re-entry path to decide whether the
// agent recovered after we blocked it.
export function hadTelegramToolCallAfter(entries: TranscriptEntry[], startIdx: number, tgPrefix: string): boolean {
  for (let i = startIdx; i < entries.length; i++) {
    const e = entries[i]
    if (e.type !== 'assistant') continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(tgPrefix)) {
        return true
      }
    }
  }
  return false
}
