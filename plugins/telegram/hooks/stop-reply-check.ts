#!/usr/bin/env -S bun
// Stop hook: catch the "Telegram inbound this turn, no reply tool call"
// slip and either auto-relay the assistant's transcript text, block the
// Stop so the agent retries, or DM a diagnostic — depending on what's in
// the transcript.
//
// Decision tree (when had_inbound this turn):
//   reply/edit_message sent this turn        → exit clean (proper channel
//                                              used; loose transcript text
//                                              is narration — do NOT relay)
//   no send, transcript text present         → DM "(auto-relay) <text>"
//                                              (the genuine "talked to the
//                                              transcript instead of
//                                              replying" miss)
//   no send, no text, react-only             → exit clean (intentional ack)
//   no send, no text, no tool, first time    → {decision:"block"} retry
//   no send, no text, no tool, re-entry      → DM enriched diagnostic
//
// A "send" is reply OR edit_message — react / download_attachment don't
// count, since a 👍 isn't a text answer. Deciding at the turn level
// (did the agent reach the proper channel at all?) rather than
// per-text-block is what stops preambles and end-of-turn summaries
// leaking out after the real reply.
//
// Loop safety (three layers — any one is sufficient):
//   1. payload.stop_hook_active=true set by the harness on Stop re-invocation.
//   2. /tmp/5dive-stopblock-<sha1(transcript_path)>.lock written when we
//      block, removed when re-entry runs. Belt-and-suspenders if the
//      harness flag is ever absent.
//   3. Block decision is only emitted on the empty-text branch.

import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setTimeout as sleep } from 'timers/promises'
import { readPayload } from './lib/payload'
import { readEntries, analyzeTurn, hadTelegramToolCallAfter } from './lib/transcript'
import { sendMessage, getToken } from './lib/telegram'
import { emitBlock } from './lib/output'
import { TG_TOOL_PREFIX } from './lib/paths'
import type { HookPayload } from './lib/types'

const payload = await readPayload<HookPayload>()

// Allow buffered transcript writes to settle. claude appends async; the
// last assistant entry can be in-flight when Stop fires and we'd otherwise
// relay stale text and miss the latest.
await sleep(50)

const transcriptPath = payload.transcript_path
if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0)

const lockKey = createHash('sha1').update(transcriptPath).digest('hex')
const lockFile = join(tmpdir(), `5dive-stopblock-${lockKey}.lock`)

// Stale-lock GC: a lock older than 1h is from a crashed prior run.
if (existsSync(lockFile)) {
  try {
    const ageSec = Date.now() / 1000 - statSync(lockFile).mtimeMs / 1000
    if (ageSec > 3600) unlinkSync(lockFile)
  } catch {
    // ignore
  }
}

const entries = readEntries(transcriptPath)

// Re-entry path: harness flagged stop_hook_active. We blocked the previous
// Stop; now decide whether to send a diagnostic.
if (payload.stop_hook_active === true) {
  if (existsSync(lockFile)) {
    let cachedChat = ''
    let cachedMsg = ''
    let cachedLine = 0
    try {
      const parts = readFileSync(lockFile, 'utf8').split('|')
      cachedChat = parts[0] ?? ''
      cachedMsg = parts[1] ?? ''
      cachedLine = parseInt(parts[2] ?? '0', 10) || 0
      unlinkSync(lockFile)
    } catch {
      // ignore
    }
    const recovered = cachedLine > 0
      ? hadTelegramToolCallAfter(entries, cachedLine, TG_TOOL_PREFIX)
      : false
    if (recovered) process.exit(0)
    if (cachedChat && getToken()) {
      let diag = '[5dive] Agent stopped without a Telegram reply and produced no transcript text'
      if (cachedMsg) diag += ` (unanswered message_id=${cachedMsg})`
      diag += '. Retry-after-block already attempted; check journalctl on the host.'
      await sendMessage(cachedChat, diag)
    }
  }
  process.exit(0)
}

// Normal path: analyze current turn.
const a = analyzeTurn(entries, TG_TOOL_PREFIX)

// Proceed only if there was a Telegram inbound this turn and we know which
// chat to send to.
if (!a.hadInbound || !a.lastChatId || !getToken()) process.exit(0)
const chatId = a.lastChatId

// Turn-level rule: if the agent delivered text through the proper channel
// — reply or edit_message — anywhere in this turn, every loose assistant
// transcript block is narration (preamble, progress notes, end-of-turn
// summary), NOT a missed answer. Suppress all auto-relay.
if (a.hadSend) process.exit(0)

// No reply/edit_message this turn. If the agent produced transcript text,
// it "talked to the transcript instead of replying" — relay it.
if (a.texts.length > 0) {
  const joined = a.texts.join('\n\n').trim()
  if (joined) {
    await sendMessage(chatId, `(auto-relay) ${joined}`)
    process.exit(0)
  }
}

// No text and no real send. A react-only ack is intentional — don't block.
if (a.hadTool) process.exit(0)

// Empty-text branch: agent stopped with neither text nor a telegram tool
// call. If a lock already exists, the harness lost re-entry tracking —
// fall through to diagnostic instead of blocking again.
if (existsSync(lockFile)) {
  let cachedChat = ''
  let cachedMsg = ''
  try {
    const parts = readFileSync(lockFile, 'utf8').split('|')
    cachedChat = parts[0] ?? ''
    cachedMsg = parts[1] ?? ''
    unlinkSync(lockFile)
  } catch {
    // ignore
  }
  const diagChat = cachedChat || chatId
  const diagMsg = cachedMsg || a.lastMessageId || ''
  let diag = '(auto-relay) Agent stopped without a Telegram reply and produced no transcript text'
  if (diagMsg) diag += ` (unanswered message_id=${diagMsg})`
  diag += '. Retry-after-block already attempted; check journalctl on the host.'
  await sendMessage(diagChat, diag)
  process.exit(0)
}

// Write lock with line-count anchor + block the Stop.
const lineCount = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean).length
try {
  writeFileSync(lockFile, `${chatId}|${a.lastMessageId ?? ''}|${lineCount}`)
} catch {
  // ignore
}

let reason = `You received a Telegram message (chat_id=${chatId}`
if (a.lastMessageId) reason += `, message_id=${a.lastMessageId}`
reason +=
  ') and the turn ended with neither assistant text nor an ' +
  'mcp__plugin_telegram_telegram__{reply,react,edit_message} tool call. ' +
  'Send a reply now before stopping.'
emitBlock(reason)
process.exit(0)
