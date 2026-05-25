import { readFileSync } from 'fs'
import { ACCESS_FILE } from './paths'
import type { AccessConfig, TranscriptEntry } from './types'

export function loadAccess(): AccessConfig {
  try {
    return JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as AccessConfig
  } catch {
    return {}
  }
}

export function getAllowedChatIds(access?: AccessConfig): string[] {
  const a = access ?? loadAccess()
  const allow = a.allowFrom ?? []
  const groups = a.groups ? Object.keys(a.groups) : []
  return [...allow, ...groups]
}

// Caller-only narrowing. When an agent is paired with multiple chats
// (DM + group), the "ping everyone in access.json" approach makes an
// unrelated group buzz every time a single user's session hits a failure.
// Scan the transcript for the most-recent telegram <channel> inbound and
// return just that chat id so the caller can scope notifications.
//
// Matches the upstream system-reminder format the telegram plugin injects
// on inbound:
//   <channel source="plugin:telegram:telegram" chat_id="123" message_id="...">
// Returns null when there's no inbound (autonomous turn, cron-triggered, etc).
export function getCallerChatId(entries: TranscriptEntry[]): string | null {
  const re = /source="plugin:telegram:telegram"\s+chat_id="(\d+)"/g
  let last: string | null = null
  for (const e of entries) {
    if (e.type !== 'user') continue
    const content =
      typeof e.message?.content === 'string'
        ? e.message.content
        : JSON.stringify(e.message?.content ?? '')
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      last = m[1]
    }
  }
  return last
}
