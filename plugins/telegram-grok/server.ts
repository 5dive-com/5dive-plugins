#!/usr/bin/env bun
/**
 * Telegram MCP server for Grok CLI.
 *
 * Outbound tools (Grok → user):
 *   reply, edit_message, react, download_attachment
 *
 * Inbound tool (user → Grok):
 *   wait_for_message — blocking. Grok calls when idle; resolves when the
 *   bot receives an allowed DM/group message.
 *
 * State: ~/.grok/channels/telegram/{access.json, .env, inbox/, bot.pid}
 *
 * Sibling to ../telegram/ (the Claude Code build). Forked rather than shared
 * because the runtime contracts diverge — Grok has no channel-notification
 * protocol, so inbound delivery is poll-based instead of push.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import {
  readFileSync, writeFileSync, mkdirSync, chmodSync, statSync,
  realpathSync, renameSync, existsSync, unlinkSync, readdirSync, watch,
} from 'fs'
import { readAccessFile as readAccessFileCore } from './access-core.ts'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join, extname, sep } from 'path'
import { TNA_RE, resolveTnaAnswer, OPT_RE, optionChoices, parseOptions, tapEvidenceArgs , yesNoChoice, describeTapError, tapLanding, tapFailureCopy, type TapLanding} from './tna'
// DIVE-2846: aliased so the durable tap-failure record needs no surgery on
// (or collision with) whatever each plugin already imports from 'fs'.
import { appendFileSync as tapAppendFileSync, mkdirSync as tapMkdirSync, statSync as tapStatSync, renameSync as tapRenameSync } from 'fs'
import { summarizeNeeds, reconcileBanner, type BannerState, type NeedSummary } from './banner'
import { installLifecycle } from './lifecycle.ts'

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return String(pkg.version ?? 'unknown')
  } catch { return 'unknown' }
})()

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'channels', 'telegram')

// DIVE-2846: a tap that fails must leave a record that outlives the process.
// stderr is captured by the harness that spawns us (measured: "Server stderr:
// telegram channel: …" rows in Claude Code's MCP log), but that log is per
// session and the tmux-hosted forks have only scrollback — which is why the two
// taps that failed on 2026-08-06 could never be diagnosed. So also append a
// bounded JSONL at a fixed path anyone can grep after the fact. Best-effort by
// construction: a record we cannot write must never take the tap handler down.
const TAP_FAIL_LOG = join(STATE_DIR, 'tap-failures.jsonl')
const TAP_FAIL_MAX_BYTES = 256_000
function recordTapFailure(line: string): void {
  process.stderr.write(`telegram tna: ${line}\n`)
  try {
    tapMkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    try {
      if (tapStatSync(TAP_FAIL_LOG).size > TAP_FAIL_MAX_BYTES) tapRenameSync(TAP_FAIL_LOG, `${TAP_FAIL_LOG}.1`)
    } catch {
      // no log yet (or unstatable) — nothing to rotate
    }
    tapAppendFileSync(TAP_FAIL_LOG, JSON.stringify({ ts: new Date().toISOString(), event: 'tap_failed', line }) + '\n', { mode: 0o600 })
  } catch {
    // The stderr line above is the floor; never throw out of the tap handler.
  }
}

const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const PID_FILE = join(STATE_DIR, 'bot.pid')
// DIVE-1503/1558: per-DM pinned "needs-you" banner bookkeeping. Maps a paired DM
// chat id → { messageId, fingerprint } so each reconcile edits the existing pin
// instead of posting a fresh banner (the DIVE-1107 banner-storm lesson).
const NEEDS_BANNER_FILE = join(STATE_DIR, 'needs-banner.json')
// Touched on every successful `reply` tool call; the Stop hook reads its
// mtime to suppress the "turn complete" ping when the user already got
// the actual reply within the suppression window.
const LAST_REPLY_FILE = join(STATE_DIR, 'last-reply.stamp')
// Stamped each time wait_for_message hands the agent a real inbound. The Stop
// hook compares this against last-reply.stamp: it only pings "turn complete"
// when an inbound arrived that wasn't replied to, so the idle wait_for_message
// loop (which finishes a turn every few minutes with no real work) stays silent.
const LAST_INBOUND_FILE = join(STATE_DIR, 'last-inbound.stamp')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

// Lock the token to owner-only, then load it. Real env wins so callers
// running the server with TELEGRAM_BOT_TOKEN=... in their shell override.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
// DIVE-1087 team-bot: a member of the shared team bot runs SEND-ONLY against the
// shared token — it MUST NOT poll getUpdates (Telegram allows one consumer per
// token; a 2nd poller = 409 = the listener goes deaf and inline approval taps are
// silently lost fleet-wide). The single team-bot listener is the sole poller; the
// MCP send tools stay live. Opt-in via TELEGRAM_SEND_ONLY=1 in the bridge .env;
// unset = unchanged per-agent polling.
const SEND_ONLY = process.env.TELEGRAM_SEND_ONLY === '1'
if (!TOKEN) {
  process.stderr.write(
    `telegram-grok: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

// Liveness beacon for the single getUpdates slot (DIVE-818/DIVE-819). The active
// poller bumps this file's mtime every HEARTBEAT_MS; a newcomer treats the slot
// as HELD only while the beacon is fresh. Acquisition happens in the poll
// bootstrap at the bottom of the file.
const HEARTBEAT_FILE = join(STATE_DIR, 'bot.heartbeat')
const HEARTBEAT_MS = 3000
// 3 missed beats — how long a newcomer waits before deciding the incumbent died.
const HEARTBEAT_STALE_MS = 9000

// DIVE-818: a TRANSIENT spawn running this server.ts (`claude mcp list`, or an
// overlapping respawn) used to eagerly SIGTERM whatever PID held the slot and
// claim it, then die — leaving NO poller (channel deaf, MCP reply tool gone
// until a manual restart). Fix: never stomp a HEALTHY incumbent; acquisition is
// deferred to the poll bootstrap, which waits out a fresh heartbeat and only
// reclaims the slot once the beacon goes stale (incumbent actually dead).
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
function heartbeatFresh(): boolean {
  try { return Date.now() - statSync(HEARTBEAT_FILE).mtimeMs < HEARTBEAT_STALE_MS } catch { return false }
}
function incumbentHolds(): boolean {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    return pid > 1 && pid !== process.pid && pidAlive(pid) && heartbeatFresh()
  } catch { return false }
}
// Set once this process becomes the active poller; cleared on shutdown.
let heartbeatTimer: ReturnType<typeof setInterval> | undefined

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram-grok: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram-grok: uncaught exception: ${err}\n`)
})

// ============================================================================
// Access control
// ============================================================================

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

// A stranger's in-flight pairing attempt. Keyed by a short code in
// access.json's `pending` map. The 5dive CLI's `pair --code <code>` reads
// senderId + chatId from here to promote the sender into allowFrom; the
// rest is for the plugin's own expiry + reply-throttle bookkeeping.
type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type AccessJson = {
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  // Optional emoji to react with on every inbound (👀, 👍, ❤, etc.).
  // Default: empty — no ack reaction. Telegram only accepts emoji on
  // its fixed whitelist; anything else gets silently dropped by the API.
  ackReaction?: string
  // Max chars per outbound message before chunking. Telegram caps at 4096;
  // we leave headroom and default to 4000. Range [500, 4096].
  textChunkLimit?: number
  // "allowlist" (default) — only senders in allowFrom (DM) or groups (group)
  //                        get through; everyone else is silently dropped.
  // "static" — synonym of allowlist for now; reserved for parity with the
  //            Claude build's static-mode semantics.
  // "pairing" — a stranger DM gets a short code written to `pending` and is
  //            told to relay it; the 5dive CLI's `pair --code` consumes it.
  dmPolicy?: 'allowlist' | 'static' | 'pairing'
  // In-flight pairing attempts, keyed by code. Honored only in "pairing" mode.
  pending?: Record<string, PendingEntry>
}

const DEFAULT_ACCESS: AccessJson = { allowFrom: [], groups: {}, pending: {} }

// Field defaulting only. The failure taxonomy (ENOENT vs unreadable vs corrupt)
// lives in access-core so every channel plugin answers a failed read the same
// way; the old `catch { return DEFAULT_ACCESS }` here silently denied EVERY chat
// whenever access.json was momentarily unreadable (DIVE-3962).
function normalizeAccess(raw: unknown): AccessJson {
  const parsed = (raw ?? {}) as Partial<AccessJson>
  return {
    allowFrom: parsed.allowFrom ?? [],
    groups: parsed.groups ?? {},
    ackReaction: typeof parsed.ackReaction === 'string' ? parsed.ackReaction : undefined,
    textChunkLimit: typeof parsed.textChunkLimit === 'number'
      ? Math.max(500, Math.min(4096, parsed.textChunkLimit))
      : undefined,
    dmPolicy: parsed.dmPolicy === 'static' ? 'static'
      : parsed.dmPolicy === 'pairing' ? 'pairing'
      : 'allowlist',
    pending: parsed.pending ?? {},
  }
}

function loadAccess(): AccessJson {
  return readAccessFileCore({
    accessFile: ACCESS_FILE,
    label: 'telegram-grok',
    normalize: normalizeAccess,
    fallback: () => ({ ...DEFAULT_ACCESS, pending: {} }),
  })
}

// Persist access.json atomically. Used by the pairing flow to record/clear
// `pending` codes. Unknown top-level keys the CLI/dashboard may add are
// preserved because we round-trip the full loaded object.
function saveAccess(a: AccessJson): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = ACCESS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, ACCESS_FILE)
  } catch (err) {
    process.stderr.write(`telegram-grok: saveAccess failed: ${err}\n`)
  }
}

// Drop expired pending codes. Returns true if anything changed.
function pruneExpired(a: AccessJson): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending ?? {})) {
    if (p.expiresAt < now) {
      delete a.pending![code]
      changed = true
    }
  }
  return changed
}

// Refuse to refer to anything outside STATE_DIR — defense in depth, the
// server's own paths are the only ones it should ever read by alias.
function assertInStateDir(path: string) {
  let real: string
  let stateReal: string
  try {
    real = realpathSync(path)
    stateReal = realpathSync(STATE_DIR)
  } catch { return }
  if (real !== stateReal && !real.startsWith(stateReal + sep)) {
    throw new Error(`refusing to send file outside state dir: ${path}`)
  }
}

// chat_id may be a DM (== from.id) or a group/channel id (negative). We
// allow DMs if from.id ∈ allowFrom, and groups if the group id is keyed
// in `groups` and the per-group policy admits the sender + mention rule.
type GateResult =
  | { allowed: true; access: AccessJson }
  | { allowed: false }
  | { allowed: false; pair: { code: string; chatId: string; isResend: boolean } }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const chat = ctx.chat
  const from = ctx.from
  if (!chat || !from) return { allowed: false }

  const chatId = String(chat.id)
  const senderId = String(from.id)

  if (chat.type === 'private') {
    if (access.allowFrom.includes(senderId)) return { allowed: true, access }

    // Pairing mode: mint/replay a code so the 5dive CLI's `pair --code` can
    // promote this sender. Any other dmPolicy silently drops strangers.
    if (access.dmPolicy === 'pairing') {
      if (pruneExpired(access)) saveAccess(access)

      // Existing non-expired code for this sender → remind once, then go quiet.
      for (const [code, p] of Object.entries(access.pending ?? {})) {
        if (p.senderId === senderId) {
          if ((p.replies ?? 1) >= 2) return { allowed: false }
          p.replies = (p.replies ?? 1) + 1
          saveAccess(access)
          return { allowed: false, pair: { code, chatId, isResend: true } }
        }
      }
      // Cap concurrent pending attempts to bound abuse.
      if (Object.keys(access.pending ?? {}).length >= 3) return { allowed: false }

      const code = randomBytes(3).toString('hex') // 6 hex chars
      const now = Date.now()
      access.pending = access.pending ?? {}
      access.pending[code] = {
        senderId,
        chatId,
        createdAt: now,
        expiresAt: now + 60 * 60 * 1000, // 1h
        replies: 1,
      }
      saveAccess(access)
      return { allowed: false, pair: { code, chatId, isResend: false } }
    }
    return { allowed: false }
  }

  const policy = access.groups[chatId]
  if (!policy) return { allowed: false }

  const senderOk = policy.allowFrom.length === 0
    ? access.allowFrom.includes(senderId)
    : policy.allowFrom.includes(senderId)
  if (!senderOk) return { allowed: false }

  if (policy.requireMention) {
    const mentioned = isMentioned(ctx)
    if (!mentioned) return { allowed: false }
  }

  return { allowed: true, access }
}

function isMentioned(ctx: Context): boolean {
  const msg = ctx.message
  if (!msg) return false
  const text = msg.text ?? msg.caption ?? ''
  if (!botUsername) return false
  if (text.includes(`@${botUsername}`)) return true
  const reply = msg.reply_to_message
  if (reply && reply.from?.id === ctx.me?.id) return true
  return false
}

function assertAllowedChat(chatId: string) {
  const access = loadAccess()
  if (access.allowFrom.includes(chatId)) return
  if (access.groups[chatId]) return
  // Group chat IDs are negative; DM chat_id == user_id. If we don't recognise
  // the chat, refuse — outbound is gated by inbound provenance.
  throw new Error(`chat_id ${chatId} is not on the allowlist`)
}

// ============================================================================
// Inbound queue + waiters
// ============================================================================

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

type InboundMsg = {
  chat_id: string
  message_id: string
  message_thread_id?: string
  user: string
  user_id: string
  text: string
  ts: string
  image_path?: string
  attachment?: AttachmentMeta
}

const inboxQueue: InboundMsg[] = []
type Waiter = { resolve: (m: InboundMsg) => void; timer: ReturnType<typeof setTimeout> | null }
const waiters: Waiter[] = []

function enqueueInbound(msg: InboundMsg) {
  // While the agent is in a detected stall (quota/auth/wedge) it can't run a
  // model turn to answer, so a queued message would just sit there silently —
  // the user can't tell if it's still stuck. Instead, reply to EACH inbound
  // with the current cause (re-detected, short-cached) so they can always probe
  // the live state, and don't queue it (avoids a flood of stale messages
  // dumping on the agent when it finally recovers). Normal delivery resumes the
  // moment the loop recovers — clearStallAlert() flips stallAlerted back off.
  if (!STALL_ALERT_DISABLED && stallAlerted) {
    const { cause, detail } = detectStallCauseCached()
    const text = `⚠️ ${agentName()} can’t respond right now — ${cause}.\n${detail}.`
    bot.api.sendMessage(msg.chat_id, text,
      msg.message_thread_id ? { message_thread_id: Number(msg.message_thread_id) } : undefined)
      .catch((err: any) => process.stderr.write(`telegram-grok: stall auto-reply failed: ${err?.message}\n`))
    return
  }
  const next = waiters.shift()
  if (next) {
    if (next.timer) clearTimeout(next.timer)
    next.resolve(msg)
  } else {
    inboxQueue.push(msg)
    kickOnEnqueue()
  }
}

// A message queued with no waiter parked means the agent is out of its listen
// loop. Without this, delivery waits for the re-arm watchdog to see
// REARM_IDLE_MS (default 180s) of measured idle — minutes of dead air on a
// freshly created agent or right after a turn ends. Kick the loop the moment
// the message lands instead. Never mid-turn (the live turn would be abandoned;
// its trailing wait_for_message drains the queue anyway), and at most once per
// REARM_CHECK_MS so a burst can't spam kicks. The consts live below the boot
// section but are initialized long before the first poller callback can fire.
let lastEnqueueKickMs = 0
function kickOnEnqueue(): void {
  if (REARM_DISABLED) return
  if (agentName() === 'unknown') return
  const now = Date.now()
  if (now - lastEnqueueKickMs < REARM_CHECK_MS) return
  // Mid-turn: kicking now would abandon the live turn, so we can't deliver yet.
  // But the Phase-1 idle fix (DIVE-1180) ends the turn instead of immediately
  // re-entering wait_for_message, so nothing drains the queue when the turn
  // closes — delivery would otherwise wait out the ~180s idle re-arm watchdog.
  // Arm a short poller that re-fires the moment the turn ends instead (DIVE-1183).
  if (turnInFlight()) { armTurnEndKick(); return }
  lastEnqueueKickMs = now
  process.stderr.write('telegram-grok: inbound queued with no waiter parked, kicking listen loop\n')
  kickListenLoop()
}

// Poll for the in-flight turn to end so a message queued mid-turn is delivered
// the instant the turn closes, rather than waiting out the idle re-arm watchdog
// (REARM_IDLE_MS, default 180s). Cheap: only runs while a message is queued with
// a turn in flight, and turnInFlight() self-caps at TURN_MAX_MS so a wedged turn
// still eventually releases the kick. A no-op on forks where turnInFlight() is
// always false (they take the immediate-kick path above and never arm this).
let pendingTurnEndKick: ReturnType<typeof setInterval> | null = null
const TURN_END_POLL_MS = 3_000
function armTurnEndKick(): void {
  if (pendingTurnEndKick) return   // already polling
  pendingTurnEndKick = setInterval(() => {
    // A waiter re-parked (loop came back on its own) or the queue drained → done.
    if (waiters.length > 0 || inboxQueue.length === 0) { disarmTurnEndKick(); return }
    if (turnInFlight()) return       // turn still running — keep waiting
    disarmTurnEndKick()
    lastEnqueueKickMs = Date.now()
    process.stderr.write('telegram-grok: turn ended with inbound still queued, waking listen loop\n')
    kickListenLoop()
  }, TURN_END_POLL_MS)
  pendingTurnEndKick.unref?.()
}
function disarmTurnEndKick(): void {
  if (pendingTurnEndKick) { clearInterval(pendingTurnEndKick); pendingTurnEndKick = null }
}

// ============================================================================
// Same-box agent inbox (DIVE-343) — fs-watched drop dir
// ============================================================================
// An agent parked in wait_for_message is DEAF to tmux-typed input: a same-box
// `agent-send` delivered by send-keys lands in the TUI's native queue, which
// only drains when the current turn ends — but the turn can't end while parked.
// Deadlock. So same-box agent-send drops a JSON file here instead; we watch the
// dir and feed it to enqueueInbound, which resolves the parked waiter
// IMMEDIATELY (or kicks the loop if none is parked) — the exact path a real
// Telegram message takes. Reuses the DIVE-285 wake machinery, no pane-scraping.
//
// Drop-file contract (one JSON object per file, name ending in `.json`):
//   { "text": "the message body",   // REQUIRED, non-empty
//     "from": "agent-main",          // optional sender label -> user/user_id
//     "chat_id": "1234567890",       // optional reply-routing target (default "agent-send")
//     "message_thread_id": "5",      // optional forum topic for the reply
//     "ts": "2026-06-13T15:00:00Z" } // optional ISO timestamp (default: now)
// Writers MUST write atomically — write a temp name, then rename into the dir
// (or to a trailing `.json`) — so the watcher never reads a half-written file.
const AGENT_INBOX_DIR = join(STATE_DIR, 'agent-inbox')
mkdirSync(AGENT_INBOX_DIR, { recursive: true, mode: 0o700 })

function ingestInboxFile(name: string): void {
  if (!name.endsWith('.json')) return
  const full = join(AGENT_INBOX_DIR, name)
  let raw: string
  try { raw = readFileSync(full, 'utf8') } catch { return }   // already consumed / mid-rename
  // Unlink first so a malformed file (or a duplicate fs.watch event) can't be
  // reprocessed in a loop.
  try { unlinkSync(full) } catch {}
  let obj: any
  try { obj = JSON.parse(raw) } catch {
    process.stderr.write(`telegram-grok: bad agent-inbox file ${name}: not JSON\n`); return
  }
  const text = typeof obj?.text === 'string' ? obj.text : ''
  if (!text.trim()) {
    process.stderr.write(`telegram-grok: agent-inbox file ${name} has no text\n`); return
  }
  const from = typeof obj?.from === 'string' && obj.from ? obj.from : 'agent-send'
  enqueueInbound({
    chat_id: typeof obj?.chat_id === 'string' && obj.chat_id ? obj.chat_id : 'agent-send',
    message_id: '0',
    ...(typeof obj?.message_thread_id === 'string' && obj.message_thread_id
      ? { message_thread_id: obj.message_thread_id } : {}),
    user: from,
    user_id: from,
    text,
    ts: typeof obj?.ts === 'string' && obj.ts ? obj.ts : new Date().toISOString(),
  })
  process.stderr.write(`telegram-grok: agent-inbox delivered ${name} (from ${from})\n`)
}

// Drain any files dropped while the server was down, then watch for new ones.
// fs.watch can coalesce or double-fire events; ingestInboxFile unlinks first so
// a duplicate event is a harmless no-op and a missed event is caught by the next.
function startAgentInbox(): void {
  try { for (const f of readdirSync(AGENT_INBOX_DIR)) ingestInboxFile(f) } catch {}
  try {
    watch(AGENT_INBOX_DIR, (_evt, fname) => { if (fname) ingestInboxFile(String(fname)) })
    process.stderr.write(`telegram-grok: watching agent-inbox at ${AGENT_INBOX_DIR}\n`)
  } catch (err) {
    process.stderr.write(`telegram-grok: agent-inbox watch failed: ${err}\n`)
  }
}

function dequeueOrWait(timeoutMs: number): Promise<InboundMsg | null> {
  if (inboxQueue.length > 0) return Promise.resolve(inboxQueue.shift()!)
  return new Promise(resolve => {
    const waiter: Waiter = { resolve: m => resolve(m), timer: null }
    waiter.timer = setTimeout(() => {
      const idx = waiters.indexOf(waiter)
      if (idx >= 0) waiters.splice(idx, 1)
      resolve(null)
    }, timeoutMs)
    waiters.push(waiter)
  })
}

function formatInbound(msg: InboundMsg): string {
  const meta = [
    `chat_id=${msg.chat_id}`,
    `message_id=${msg.message_id}`,
    msg.message_thread_id ? `message_thread_id=${msg.message_thread_id}` : null,
    `user=${msg.user}`,
    `user_id=${msg.user_id}`,
    `ts=${msg.ts}`,
    msg.image_path ? `image_path=${msg.image_path}` : null,
    msg.attachment ? `attachment_kind=${msg.attachment.kind}` : null,
    msg.attachment ? `attachment_file_id=${msg.attachment.file_id}` : null,
    msg.attachment?.size != null ? `attachment_size=${msg.attachment.size}` : null,
    msg.attachment?.mime ? `attachment_mime=${msg.attachment.mime}` : null,
    msg.attachment?.name ? `attachment_name=${msg.attachment.name}` : null,
  ].filter(Boolean).join(' ')
  return `<telegram ${meta}>\n${msg.text}\n</telegram>`
}

// ============================================================================
// Bot
// ============================================================================

const bot = new Bot(TOKEN)

// Telegram rejects sendMessage/editMessageText text over 4096 chars
// (400: message is too long). A rejected send only surfaces in bot.catch —
// the user sees nothing (DIVE-313: /tasks went silent; DIVE-1191: recurred
// on the forks). chunkForTelegram/clampList cover the reply paths, but a
// multi-section /tasks (each section clamped to ~4000) can still join past
// 4096, and other slash/button paths send unchunked. This API-layer guard
// degrades any oversized send to a truncated one. parse_mode is dropped on
// truncation because a cut MarkdownV2 entity would itself 400 on unbalanced
// markup.
const TG_HARD_MESSAGE_LIMIT = 4096
bot.api.config.use((prev, method, payload, signal) => {
  if (method === 'sendMessage' || method === 'editMessageText') {
    const p = payload as { text?: string; parse_mode?: string }
    // DIVE-1674: never deliver a bare 'undefined'/empty payload to the user.
    // This is the single transport choke point every send flows through, so a
    // guard here kills the symptom regardless of which caller passed undefined
    // (or a template that stringified to the literal string 'undefined').
    if (p.text == null || p.text.trim() === '' || p.text.trim() === 'undefined') {
      throw new Error(`telegram ${method}: refusing to send empty/undefined text`)
    }
    if (typeof p.text === 'string' && p.text.length > TG_HARD_MESSAGE_LIMIT) {
      p.text = p.text.slice(0, TG_HARD_MESSAGE_LIMIT - 32) + '\n…(message truncated)'
      delete p.parse_mode
    }
  }
  return prev(method, payload, signal)
})
let botUsername = ''
let shuttingDown = false

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// Telegram clears the "typing…" indicator ~5s after each sendChatAction.
// Re-send every 4s per chat from when Grok picks up an inbound (via
// wait_for_message) until the next reply lands, with a 5min ceiling so a
// crashed turn never loops forever. Without this, a thinking Grok looks
// identical to a hung one from the user's phone.
const TYPING_INTERVAL_MS = 4_000
const TYPING_CEILING_MS = 5 * 60 * 1000
const typingLoops = new Map<string, ReturnType<typeof setInterval>>()
const typingCeilings = new Map<string, ReturnType<typeof setTimeout>>()
function startTypingLoop(chat_id: string) {
  stopTypingLoop(chat_id)
  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  const handle = setInterval(() => {
    void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  }, TYPING_INTERVAL_MS)
  typingLoops.set(chat_id, handle)
  typingCeilings.set(chat_id, setTimeout(() => stopTypingLoop(chat_id), TYPING_CEILING_MS))
}
function stopTypingLoop(chat_id: string) {
  const handle = typingLoops.get(chat_id)
  if (handle) {
    clearInterval(handle)
    typingLoops.delete(chat_id)
  }
  const ceiling = typingCeilings.get(chat_id)
  if (ceiling) {
    clearTimeout(ceiling)
    typingCeilings.delete(chat_id)
  }
}

// Telegram sendMessage caps at 4096 characters per message. Grok turns
// regularly exceed that on long explanations or diffs — without chunking,
// reply() would fail with 400 Bad Request and the user sees nothing.
// We leave 96 chars of headroom for any per-chunk wrapper Telegram adds.
const TG_MAX_MESSAGE_CHARS = 4000

// Split text into chunks that fit Telegram's per-message char cap. Prefer
// breaking on paragraph (\n\n), then line (\n), then word boundaries.
// Last-resort: hard-cut at the cap.
function chunkForTelegram(text: string, limit = TG_MAX_MESSAGE_CHARS): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let split = rest.lastIndexOf('\n\n', limit)
    if (split < limit / 2) split = rest.lastIndexOf('\n', limit)
    if (split < limit / 2) split = rest.lastIndexOf(' ', limit)
    if (split < limit / 2) split = limit
    out.push(rest.slice(0, split))
    rest = rest.slice(split).replace(/^\s+/, '')
  }
  if (rest.length > 0) out.push(rest)
  return out
}

// Tracked for /status — last time an inbound message landed (not the
// startup time, not the last reply).
let lastInboundTs: string | null = null

// Bot-side slash commands. These short-circuit before ingest(), so they
// never appear in the wait_for_message queue and Grok doesn't see them.
//
// Grok itself owns commands that need to manipulate its session (model
// switching, stop, restart, checkpoint). Those would require IPC into the
// running session and are out of scope here.
const BOT_COMMANDS: Array<{ command: string; description: string; menuHidden?: boolean }> = [
  { command: 'help',    description: 'Show commands' },
  { command: 'status',  description: 'Pairing, usage, model' },
  { command: 'stop',    description: 'Interrupt task' },
  { command: 'restart', description: 'Respawn grok' },
  { command: 'agents',  description: 'Team' },
  { command: 'team',    description: 'Team (alias for /agents)', menuHidden: true },
  { command: 'tasks',   description: 'List open tasks' },
  { command: 'inbox',   description: 'Pending human gates awaiting you' },
  { command: 'task',    description: 'Add a task — /task add <title>' },
  { command: 'org',     description: 'Show the agent org chart' },
  { command: 'model',   description: 'Pick model' },
  { command: 'ping',    description: 'Liveness check' },
  { command: 'start',   description: 'Pair this chat' },
]

// /team is a hidden alias: still dispatched and shown in /help, but kept off
// the BotFather command-menu picker — Mark: don't list both /agents and /team.
const MENU_COMMANDS = BOT_COMMANDS.filter(c => !c.menuHidden)

function helpText(): string {
  const lines = [
    `*telegram-grok* v${PLUGIN_VERSION} — bridge for xAI Grok CLI`,
    ``,
    `commands:`,
    ...BOT_COMMANDS.map(c => `  /${c.command} — ${c.description}`),
    ``,
    `everything else you send routes to Grok via wait_for_message.`,
    `docs: github.com/5dive-ai/5dive-plugins/tree/main/plugins/telegram-grok`,
  ]
  return lines.join('\n')
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

const SERVER_STARTED_AT = Date.now()
const CLI_BIN = 'grok'

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

// Best-effort plain-text exec for `<cli> --version` / `5dive --version`.
function execText(cmd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    require('child_process').execFile(cmd, args, { timeout: 4000 }, (err: any, out: string) => {
      resolve(err ? null : (String(out || '').split('\n')[0].trim() || null))
    })
  })
}

// This agent's `5dive agent info` (cliVersion + authProfile), v0.1.25+. The CLI
// resolves cliVersion by probing the agent's actual TYPE_BIN — more accurate
// than a PATH lookup (agy's binary isn't on the agent PATH; codex runs 0.134
// via TYPE_BIN even when a newer one sits on the login PATH).
async function read5diveInfo(): Promise<{ cliVersion?: string; authProfile?: string; model?: string } | null> {
  try {
    const j = await run5dive(['agent', 'info', agentName(), '--json'])
    if (!j.ok || !j.data) return null
    return {
      cliVersion: j.data.cliVersion ?? undefined,
      authProfile: j.data.authProfile ?? undefined,
      model: j.data.model ?? undefined,
    }
  } catch { return null }
}

// /status — mirrors the Claude telegram plugin's layout as closely as the
// CLI runtime allows. Grok has no session-status / usage cache like claude's,
// so `status` is derived from the bridge (listening vs working) and usage is
// omitted rather than faked.
// Normalise a `--version` blob to a leading "v<semver>" ("5dive 0.1.23"
// → "v0.1.23", "1.0.3" → "v1.0.3"); fall back to the raw string.
function fmtVer(raw: string): string {
  const m = raw.match(/\d+\.\d+(?:\.\d+)?[\w.+-]*/)
  return m ? `v${m[0]}` : raw
}

// Listening vs working, from the inbound/reply stamps (same signal the Stop
// hook uses): "working" only when the latest inbound hasn't been replied to
// yet. Avoids the racy wait_for_message-waiter check.
function bridgeStatus(): string {
  let li = 0, lr = 0
  try { li = Number(readFileSync(LAST_INBOUND_FILE, 'utf8')) || 0 } catch {}
  try { lr = Number(readFileSync(LAST_REPLY_FILE, 'utf8')) || 0 } catch {}
  return li > lr ? '🟡 working' : '🟢 listening'
}

// Generic top-level config.toml key reader (model effort, etc).
function readConfigKey(key: string): string | null {
  try {
    const raw = readFileSync(CLI_CONFIG_FILE, 'utf8')
    const firstSection = raw.search(/^\s*\[/m)
    const head = firstSection === -1 ? raw : raw.slice(0, firstSection)
    const m = head.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*["']?([^"'\\n#]+?)["']?[ \\t]*(?:#.*)?$`, 'm'))
    return m ? m[1].trim() : null
  } catch { return null }
}

// Real agent session uptime via the `agent-<name>` tmux session creation time;
// falls back to the bridge process start if tmux can't be read.
function agentUptimeMs(): number {
  const name = agentName()
  if (name !== 'unknown') {
    try {
      const out = require('child_process').execFileSync('tmux',
        ['display-message', '-t', `agent-${name}`, '-p', '#{session_created}'],
        { timeout: 3000 }).toString().trim()
      const created = Number(out) * 1000
      if (created > 0) return Date.now() - created
    } catch {}
  }
  return Date.now() - SERVER_STARTED_AT
}

// Live cwd of the agent's tmux pane — used when the 5dive registry carries no
// explicit workdir override.
function agentWorkdir(): string | undefined {
  const name = agentName()
  if (name === 'unknown') return undefined
  try {
    const out = require('child_process').execFileSync('tmux',
      ['display-message', '-t', `agent-${name}`, '-p', '#{pane_current_path}'],
      { timeout: 3000 }).toString().trim()
    return out || undefined
  } catch { return undefined }
}

// Most recent bridge activity (inbound or reply), epoch ms, or null.
function lastActivityMs(): number | null {
  let li = 0, lr = 0
  try { li = Number(readFileSync(LAST_INBOUND_FILE, 'utf8')) || 0 } catch {}
  try { lr = Number(readFileSync(LAST_REPLY_FILE, 'utf8')) || 0 } catch {}
  const m = Math.max(li, lr)
  return m > 0 ? m : null
}

async function statusText(senderName: string): Promise<string> {
  const now = Date.now()
  const lines = [`Paired as ${senderName}.`, '']
  lines.push(`status: ${bridgeStatus()}`)
  const model = readConfigModel()
  const effort = readConfigKey('model_reasoning_effort')
  if (model) lines.push(`model: ${model}${effort ? ` · ${effort}` : ''}`)
  lines.push(`uptime: ${formatDuration(agentUptimeMs())}`)
  const lastAct = lastActivityMs()
  lines.push(`last activity: ${lastAct ? `${formatDuration(now - lastAct)} ago` : '(none this session)'}`)
  const info = await read5diveInfo()
  if (info?.cliVersion) {
    const v0 = info.cliVersion.replace(/^[A-Za-z][A-Za-z0-9-]*\s+/, '').trim() || info.cliVersion
    lines.push(`${CLI_LABEL.toLowerCase()}: ${/^\d/.test(v0) ? 'v' + v0 : v0}`)
  }
  lines.push(`plugin: v${PLUGIN_VERSION}`)
  const fiveVer = await execText('sudo', ['-n', '5dive', '--version'])
  if (fiveVer) lines.push(`5dive: ${fmtVer(fiveVer)}`)
  lines.push(`account: ${info?.authProfile || 'default'}`)
  const wd = agentWorkdir()
  if (wd) lines.push(`workdir: ${wd}`)
  return lines.join('\n')
}

// Derive the 5dive agent name from the current Unix user. The MCP server
// runs as agent-<name> per 5dive convention; the tmux session and systemd
// unit follow the same naming. Returns 'unknown' if not in that shape so
// /stop and /restart fail loudly rather than acting on the wrong target.
function agentName(): string {
  try {
    const user = require('os').userInfo().username as string
    if (user.startsWith('agent-')) return user.slice('agent-'.length)
  } catch {}
  return 'unknown'
}

async function interruptGrok(): Promise<string> {
  const name = agentName()
  if (name === 'unknown') return '⚠️ cannot determine agent name; not running under a 5dive systemd unit'
  return new Promise(resolve => {
    // `tmux send-keys -t <session> C-c` interrupts whatever the foreground
    // process in that pane is doing. Grok runs under a 5dive systemd unit
    // that respawns it, so C-c kills the current Grok turn and the unit
    // brings a fresh Grok session back within a few seconds.
    const child = require('child_process').execFile('tmux',
      ['send-keys', '-t', `agent-${name}`, 'C-c'],
      { timeout: 5000 },
      (err: any) => {
        if (err) resolve(`⚠️ tmux send-keys failed: ${err.message}`)
        else resolve(`✋ sent Ctrl-C to agent \`${name}\` — current Grok turn interrupted`)
      },
    )
    void child
  })
}

async function listAgents(): Promise<string> {
  return new Promise(resolve => {
    require('child_process').execFile('sudo',
      ['-n', '5dive', 'agent', 'list', '--json'],
      { timeout: 5000 },
      (err: any, stdout: string) => {
        if (err) return resolve(`⚠️ \`5dive agent list\` failed: ${err.message}`)
        try {
          const env = JSON.parse(stdout) as { ok: boolean; data: any[] }
          if (!env.ok || !Array.isArray(env.data) || env.data.length === 0) {
            return resolve('no agents found')
          }
          const self = agentName()
          const lines = [`*agents on this host* (${env.data.length}):`, '']
          for (const a of env.data) {
            const me = a.name === self ? ' ← me' : ''
            const dot = a.active === 'active' ? '🟢' : '⚪'
            lines.push(`${dot} \`${a.name}\` — ${a.type}${a.channels && a.channels !== 'none' ? ` · ${a.channels}` : ''}${me}`)
          }
          resolve(lines.join('\n'))
        } catch (e) {
          resolve(`⚠️ couldn't parse \`5dive agent list\`: ${e}`)
        }
      },
    )
  })
}

// Run `sudo -n 5dive <args> --json` and return the parsed {ok,data,error}
// envelope. Rejects on spawn/exec failure so callers can show a clean error.
function run5dive(args: string[], timeout = 8000): Promise<{ ok: boolean; data?: any; error?: { message?: string } }> {
  return new Promise((resolve, reject) => {
    require('child_process').execFile('sudo', ['-n', '5dive', ...args], { timeout },
      (err: any, stdout: string) => {
        if (err && !stdout) return reject(err)
        try { resolve(JSON.parse(stdout)) } catch (e) { reject(e) }
      },
    )
  })
}

// DIVE-950: the DIVE-518/519 `mintGateProof` helper is REMOVED. Its --proof token
// (evidence-form b) was agent-forgeable — `5dive gate-proof` mint is require_root
// only, so any sudo-capable agent could mint a valid token and self-clear a gate.
// The verified-human tap now clears via the per-gate --human-proof nonce (form a).

// --- /tasks: tappable list + single-task detail (host-shared queue) ---
// Open tasks render as one button each (tap -> detail); rows assigned to THIS
// agent are starred. The detail view carries a Back button that re-renders the
// list. Read-only; mutations still go through /task add and the dashboard/CLI.
function taskAssignedToMe(assignee: string | null | undefined): boolean {
  if (!assignee) return false
  const me = agentName()
  if (!me || me === 'unknown') return false
  // task assignees appear as either the bare agent name ("main") or the unix
  // user form ("agent-main") in the queue — match both.
  return assignee === me || assignee === `agent-${me}`
}

// Telegram inline-button labels are centered and silently clipped, so the list
// is plain left-aligned text with a tappable /task_<id> deep link per row
// (handled by the bot.hears below). Rows assigned to THIS agent are starred.
// Read-only; mutations go through /task add + dashboard/CLI.
// Clamp a list section to a ~4000-char budget so a long /tasks never exceeds
// Telegram's 4096 send limit (DIVE-313); appends "(+N more)" for the remainder.
function clampList(header: string, lines: string[], total = lines.length): string {
  const BUDGET = 4000
  let used = header.length
  const kept: string[] = []
  for (const line of lines) {
    if (used + line.length + 1 > BUDGET) break
    kept.push(line)
    used += line.length + 1
  }
  const hidden = total - kept.length
  return header + kept.join('\n') + (hidden > 0 ? `\n(+${hidden} more)` : '')
}

// Render one task row: ⭐ if mine, a status flag, ident · title, assignee, link.
// `needTag` appends the gate type (e.g. " [approval]") for the Needs-you section.
function taskRow(t: any, needTag = false): string {
  const TITLE_MAX = 80
  const mine = taskAssignedToMe(t.assignee) ? '⭐ ' : ''
  const flag = t.status === 'in_progress' ? '▶ ' : t.status === 'blocked' ? '⛔ ' : ''
  let title = String(t.title ?? '')
  if (title.length > TITLE_MAX) title = title.slice(0, TITLE_MAX - 1) + '…'
  const tag = needTag && t.need_type ? ` [${t.need_type}]` : ''
  const who = t.assignee ? ` (${String(t.assignee).replace(/^agent-/, '')})` : ''
  return `${mine}${flag}${t.ident} · ${title}${tag}${who}  /task_${t.id}`
}

async function buildTaskList(): Promise<string> {
  let j: any
  try {
    j = await run5dive(['task', 'ls', '--json'])
  } catch (err) {
    return `Failed to list tasks: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!j.ok || !Array.isArray(j.data?.tasks)) return '5dive returned unexpected output.'
  const tasks = j.data.tasks
  if (tasks.length === 0) return 'No open tasks.\n\nAdd one with /task add <title>.'
  const MAX = 40
  // Gates actually waiting on a PERSON float to their own "Needs you" section on top.
  //
  // DIVE-3267: this used to read `t.need_type`, with a comment calling its presence
  // "a clean needs-a-human flag". It is not: need_type present means HAS AN
  // UNANSWERED GATE, and a gate routed to an agent seat is one of those. So "Needs
  // you" listed every open gate in the fleet as an act-on-me row — the same defect
  // DIVE-3224 fixed one command over in /inbox, still live here, and the false
  // premise was written down above the line as its justification.
  //
  // `needs_human` is the CLI's OWN verdict on that question, computed from the one
  // predicate in cmd_task_inbox. We partition on the answer; we do not rebuild the
  // rule, and we must not — that copy is what produced both defects, and the rule
  // has grown a clause since (DIVE-3228's routed-`access` case).
  //
  // FALLBACK, and note which way it fails. On a CLI predating DIVE-3267 the field is
  // absent from every row, and we revert to the old `need_type` reading rather than
  // treating "absent" as "not human" — which would EMPTY this section and hide the
  // founder's own gates. Showing too much is recoverable; hiding a gate is the defect.
  // The CLI guarantees the field is present and 0 (never omitted) on a non-human row,
  // so absent-everywhere is an unambiguous version signal, not a per-row ambiguity.
  //
  // The SAME predicate, negated, feeds the other bucket: an agent-routed gate leaves
  // "Needs you" and must land in "Open tasks" rather than falling out of both.
  const hasVerdict = tasks.some((t: any) => t.needs_human !== undefined)
  const needsHuman = (t: any) => (hasVerdict ? Number(t.needs_human) === 1 : !!t.need_type)
  const needsYou = tasks.filter(needsHuman)
  const rest = tasks.filter((t: any) => !needsHuman(t))
  const sections: string[] = []
  if (needsYou.length) {
    const lines = needsYou.map((t: any) => taskRow(t, true))
    sections.push(clampList(`🔔 Needs you (${needsYou.length}) · tap /task_N to act:\n\n`, lines))
  }
  if (rest.length) {
    const lines = rest.slice(0, MAX).map((t: any) => taskRow(t))
    sections.push(clampList('Open tasks · ⭐ = yours · tap /task_N to open:\n\n', lines, rest.length))
  }
  return sections.join('\n\n')
}

async function buildTaskDetail(id: number): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  let j: any
  try {
    j = await run5dive(['task', 'show', String(id), '--json'])
  } catch (err) {
    return { text: `Failed to load task: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!j.ok || !j.data?.task) return { text: 'Task not found.' }
  const t = j.data.task
  const mine = taskAssignedToMe(t.assignee) ? ' ⭐' : ''
  const lines = [
    `${t.ident} · ${t.title}`,
    ``,
    `status: ${t.status}${t.priority ? `  ·  priority: ${t.priority}` : ''}`,
    `assignee: ${t.assignee || '(unassigned)'}${mine}`,
  ]
  if (t.created_by) lines.push(`created by: ${t.created_by}`)
  const subs = Array.isArray(j.data.subtasks) ? j.data.subtasks : []
  if (subs.length) lines.push(`subtasks: ${subs.length}`)
  // DIVE-3340: SAY THAT A GATE IS PENDING, AND NAME THE ROUTE THAT ANSWERS IT.
  //
  // Reported from a CUSTOMER VM 2026-08-12: the box owner opened /task_<id> on a
  // gated row and every control in front of him either did nothing or was refused.
  // ✅ Done is refused over an open gate (DIVE-555), 🚫 Cancel is refused over one
  // (DIVE-2773), and the CLI refusal sent him to `task need --withdraw`, which
  // authorizes on human/filer/lead/coordinator — a person typing into a bot is none
  // of those, because the command executes on an AGENT seat and the human's identity
  // deliberately does not travel through the chat (DIVE-1401/DIVE-2330 fail closed on
  // purpose). So the row read as uncloseable from every surface he could see.
  //
  // The answer surface existed the whole time and lived somewhere else: the gate posts
  // its OWN message when filed, carrying the DIVE-916 per-gate human nonce in the
  // option buttons' callback_data. This view never mentioned it — not the gate, not the
  // ask, not the route — so if that alert had scrolled away, or the chat was re-paired,
  // the affordance was invisible as well as unreachable.
  //
  // NO BUTTONS ARE MINTED HERE, deliberately. The nonce is not derivable in the plugin
  // (DIVE-950 closed that as agent-forgeable), and a plugin-minted answer control would
  // be a second answer surface with different provenance from the one the CLI seals.
  // The route is named in TEXT instead, which is what the reader was missing. The same
  // posture the gate card list already takes for tier-2 hard gates, whose buttons only
  // the CLI can mint.
  //
  // The keyboard below is left intact rather than suppressed: Escalate and Do now still
  // do their jobs on a gated row, and hiding Done/Cancel would trade a refusal a reader
  // can act on for an absence they cannot. What was actually missing is the sentence
  // saying WHY they refuse and what to do instead, so that is what is added.
  // DIVE-3340 iter2 (main2): CONSUME THE VERDICT, NEVER THE INPUTS.
  // This block's first cut tested `t.need_type && !t.need_answered_at` — "has an
  // unanswered gate" — which is NOT the CLI's open-gate rule. `_task_gate_open_pred`
  // is that plus `status NOT IN ('done','cancelled')`. On 19 live board rows that are
  // done/cancelled with a lingering gate (DIVE-2758, DIVE-2698, DIVE-2511, …) the old
  // predicate rendered three false claims at once: that the row waits on a human (it
  // is closed), that ✅/🚫 sit "below" (buildTaskDetail renders no keyboard on a
  // terminal row), and that /inbox will re-send it (cmd_task_inbox excludes terminal
  // rows by design — "a closed task waits on no one"). Same conflation as DIVE-3224
  // in this plugin's /inbox and DIVE-3267 one command over; `src/task/inbox.sh` states
  // the contract as EXPORT THE VERDICT, NEVER THE INPUTS.
  //
  // The verdicts are now on `task show --json` — the call THIS view makes — and not
  // only on `task ls --json`, which is why the first cut could not consume them. The
  // `!== undefined` fallback mirrors the /tasks list's `hasVerdict` idiom: an older
  // CLI omits the fields, and the fallback rebuilds the rule WITH the status clause
  // rather than without it, so a stale CLI degrades to correct-but-coarse.
  const gateLive =
    t.gate_live !== undefined
      ? Number(t.gate_live) === 1
      : !!(t.need_type && !t.need_answered_at && t.status !== 'done' && t.status !== 'cancelled')
  // A SECOND verdict, and deliberately not the same one. An agent-routed gate
  // (a resolved reviewer, tier<2, no capability need) is OPEN — both close verbs
  // still refuse over it — but it is NOT waiting on a human, and saying so points the
  // reader at /inbox, which counts it as routed_elsewhere and does not list it. Zero
  // rows hold that shape today; it is structurally live, which is why it is a branch
  // and not a comment.
  const gateNeedsHuman = t.needs_human !== undefined ? Number(t.needs_human) === 1 : gateLive
  if (gateLive) {
    const gIdent = t.ident || `DIVE-${t.id}`
    // Type-shaped because the verb genuinely differs, and publishing the wrong one is
    // the same defect one layer down: a secret must never be typed into chat (Telegram
    // keeps history) and a manual gate records that the step was PERFORMED, so both
    // take `task answer` with NO --value. Mirrors _gate_answer_route in the CLI.
    const gHow =
      t.need_type === 'secret'
        ? `place the secret out-of-band, then run \`5dive task answer ${gIdent}\` with NO --value (it must never enter chat history)`
        : t.need_type === 'manual'
          ? `run \`5dive task answer ${gIdent}\` with NO --value (it records that the step was performed)`
          : `tap a button on this gate's own alert message in this chat, or run \`5dive task answer ${gIdent} --value=<answer>\``
    lines.push(
      '',
      gateNeedsHuman
        ? `⛔ PENDING ${String(t.need_type).toUpperCase()} GATE — this row is waiting on a HUMAN ANSWER, not on work.`
        : `⛔ PENDING ${String(t.need_type).toUpperCase()} GATE — this row is waiting on an ANSWER from its routed agent reviewer, not on work.`,
    )
    if (t.ask) {
      // Same clamp rule as inboxCard: an ask with options must not be truncated, or the
      // last option is chopped off and the reader answers a question they cannot see.
      let gAsk = String(t.ask).replace(/\s+/g, ' ').trim()
      if (!t.need_options && gAsk.length > 300) gAsk = gAsk.slice(0, 299) + '…'
      lines.push(`   asks: ${gAsk}`)
    }
    if (t.need_options) lines.push(`   options: ${String(t.need_options)}`)
    if (t.recommend) lines.push(`   ⭐ rec: ${String(t.recommend)}`)
    lines.push(`   to answer: ${gHow}`)
    lines.push(`   ✅ Done and 🚫 Cancel below WILL BE REFUSED while this gate is pending — answering it is what unblocks the row.`)
  }
  if (t.body) {
    let body = String(t.body)
    if (body.length > 1500) body = body.slice(0, 1500) + '\n…(truncated)'
    lines.push('', body)
  }
  if (t.result) lines.push('', `result: ${t.result}`)
  lines.push('', 'back to list: /tasks')
  // DIVE-449: an "Escalate" button (semantics A — flag for attention: bumps
  // priority a tier + pings the owning agent & the paired human). Only for OPEN
  // tasks — a done/cancelled task has nothing to get eyes on. The tap lands in
  // the callback router as `esc:<id>` (mirrors the tna: tap-to-answer flow).
  let keyboard: InlineKeyboard | undefined
  if (t.status !== 'done' && t.status !== 'cancelled') {
    // DIVE-503: "▶️ Do now" (Mark, 2026-06-18) — the ACTIVE counterpart to
    // Escalate. Escalate is passive (bump priority + notify, agent decides when);
    // Do now pings the assigned agent to pick this up immediately and flips the
    // task to in_progress. Only rendered when there's an assignee (nothing to
    // ping otherwise); sits left of 🔺 Escalate. Routes as `donow:<id>`.
    keyboard = new InlineKeyboard()
    if (t.assignee) keyboard.text('▶️ Do now', `donow:${t.id}`)
    keyboard.text('🔺 Escalate', `esc:${t.id}`)
    // DIVE-503: second row — close the task out. ✅ Done is one-tap (reversible
    // by reopening); 🚫 Cancel is two-tap (tap once to arm → confirm) so a
    // fat-finger can't kill a task. Only shown while the task is still open.
    keyboard.row()
    keyboard.text('✅ Done', `tdone:${t.id}`).text('🚫 Cancel', `tcancel:${t.id}`)
  }
  return { text: lines.join('\n'), keyboard }
}

// /task add <title> — create a task on the shared queue.
async function addTask(arg: string, from: string): Promise<string> {
  const sp = arg.indexOf(' ')
  const sub = (sp === -1 ? arg : arg.slice(0, sp)).toLowerCase()
  const title = sp === -1 ? '' : arg.slice(sp + 1).trim()
  if (sub !== 'add') return 'Usage:\n`/task add <title>` — create a task\n`/tasks` — list open tasks'
  if (!title) return "What's the task? Try:\n`/task add Wire up the billing webhook`"
  try {
    const j = await run5dive(['task', 'add', '--json', `--from=${from}`, '--', title])
    if (!j.ok) return `⚠️ Failed: ${j.error?.message ?? 'unknown error'}`
    return `✅ Created \`${j.data.ident}\` — ${j.data.title}`
  } catch (err) {
    return `⚠️ Failed to add task: ${err instanceof Error ? err.message : String(err)}`
  }
}

// /org [tree] — show the agent org chart.
async function orgTree(arg: string): Promise<string> {
  if (arg !== '' && arg !== 'tree') return 'Usage:\n`/org tree` — show the agent org chart'
  try {
    const j = await run5dive(['org', 'tree', '--json'])
    if (!j.ok || !Array.isArray(j.data?.tree)) return '⚠️ `5dive org tree` returned unexpected output.'
    const tree = j.data.tree
    if (tree.length === 0) return 'Org chart is empty.'
    const lines = tree.map((n: any) => {
      const indent = '  '.repeat(Math.max(0, n.depth ?? 0))
      const label = n.title || n.role ? ` — ${n.title || n.role}` : ''
      return `${indent}${n.name}${label}`
    })
    return `*Org chart:*\n\n${lines.join('\n')}`
  } catch (err) {
    return `⚠️ Failed to read org chart: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function restartAgent(name: string, ackUpdateId?: number): Promise<void> {
  if (name === 'unknown') return
  // Ack the triggering update BEFORE we kill the process. The restart tears
  // down this poller; getUpdates only commits the offset on its NEXT call, so
  // if a /restart (or /model) update isn't acked first it sits at the head of
  // the backlog and Telegram REDELIVERS it on the next boot → the bot re-runs
  // /restart → infinite self-restart loop, ~1/sec, until systemd's start-limit
  // trips and the unit fails ("bot looks dead"). Calling getUpdates(offset=id+1)
  // is the ack. Safe here: grammy processes updates sequentially, so no poll is
  // in flight mid-handler. Higher-id updates in the same batch stay pending and
  // are correctly redelivered (they weren't handled). DIVE-13 — hit live on agy.
  if (ackUpdateId != null) {
    try { await bot.api.getUpdates({ offset: ackUpdateId + 1, limit: 1, timeout: 0 }) } catch {}
  }
  await new Promise<void>(resolve => {
    // DIVE-1813: `sudo 5dive agent _self_restart` is the canonical path — on a
    // standard-isolation box the agent's scoped sudoers grants exactly this
    // (there is NO `agent restart <name>` grant), and it restarts ONLY the
    // caller's own unit (derived from SUDO_USER, never argv). Deferred
    // internally so the ack lands before the respawn. Touches the systemd unit,
    // not the tmux session, so the unit's audit log + restart counter stay
    // consistent.
    require('child_process').execFile('sudo',
      ['-n', '5dive', 'agent', '_self_restart'],
      { timeout: 10_000 },
      () => resolve(),
    )
  })
}

// ─── /model — show or switch the CLI model ───────────────────────────────────
// The model is the top-level `model = "..."` key in <CLI_HOME>/config.toml
// (STATE_DIR is <CLI_HOME>/channels/telegram, so config.toml is two levels up).
// Switching writes the key and restarts the agent — the CLI reads its model at
// startup and there's no reliable hot-swap from outside the running session.
const CLI_LABEL = 'Grok'
const CLI_CONFIG_FILE = join(STATE_DIR, '..', '..', 'config.toml')

function readConfigModel(): string | null {
  try {
    const raw = readFileSync(CLI_CONFIG_FILE, 'utf8')
    const firstSection = raw.search(/^\s*\[/m)
    const head = firstSection === -1 ? raw : raw.slice(0, firstSection)
    const m = head.match(/^[ \t]*model[ \t]*=[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/m)
    return m ? m[1].trim() : null
  } catch { return null }
}

// Switch by shelling out to the CLI (5dive v0.1.26+): it does the preamble-safe
// config.toml write + the deferred ~1s restart, so we don't touch the file or
// restart ourselves. Current model comes from `agent info` (live-reads config).
async function handleModelCommand(arg: string): Promise<{ text: string; switchTo?: string }> {
  const name = arg.trim()
  if (!name) {
    let cur: string | undefined
    try { const j = await run5dive(['agent', 'info', agentName(), '--json']); cur = j?.data?.model ?? undefined } catch {}
    if (!cur) cur = readConfigModel() ?? undefined
    return { text:
      `*model* — ${CLI_LABEL}\n\n` +
      `current: \`${cur ?? '(CLI default)'}\`\n\n` +
      `Switch with \`/model <id>\` — any valid ${CLI_LABEL} model id. The agent restarts (~2s) to apply.`,
    }
  }
  if (!/^[A-Za-z0-9._:\/-]+$/.test(name)) {
    return { text: `⚠️ \`${name}\` doesn't look like a model id (allowed: letters, digits, . _ : / -).` }
  }
  try {
    const j = await run5dive(['agent', 'config', agentName(), 'set', `model=${name}`, '--json'])
    if (!j.ok) return { text: `⚠️ ${j.error?.message ?? 'failed to set model'}` }
  } catch (e) {
    return { text: `⚠️ couldn't set model: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { text: `🔁 model → \`${name}\`\nrestarting ${CLI_LABEL} (~2s) to apply…` }
}

// ── /login (DIVE-380): self-serve coding-CLI auth (self-poll types) ──────────
// Wraps the on-box device-code flow (`5dive agent auth start|poll|cancel`). The
// CLI type is resolved at RUNTIME via `agent info` — never hardcoded — so this
// is identical across forks and dodges the generator's name-sweep. grok/codex/
// openclaw self-poll (CLI completes on its own); antigravity is v2 (deferred).
type AuthState = { state?: string; url?: string; code?: string; error?: string; type?: string }
async function authPollFork(sid: string): Promise<AuthState | null> {
  const j = await run5dive(['agent', 'auth', 'poll', sid, '--json'], 8000)
  return j?.ok && j.data ? (j.data as AuthState) : null
}
async function pollAuthUntilFork(
  sid: string,
  done: (s: AuthState) => boolean,
  deadline: number,
): Promise<AuthState | null> {
  const backoff = [2000, 3000, 5000, 8000, 12000, 15000]
  let i = 0
  let last: AuthState | null = null
  while (Date.now() < deadline) {
    const s = await authPollFork(sid)
    if (s) {
      last = s
      if (s.state === 'ok' || s.state === 'error' || s.state === 'expired') return s
      if (done(s)) return s
    }
    const wait = backoff[Math.min(i, backoff.length - 1)]!
    i++
    if (Date.now() + wait >= deadline) break
    await new Promise(r => setTimeout(r, wait))
  }
  return last
}
async function reportLoginFork(sid: string, chatId: string, s: AuthState | null, opts?: { restarting?: boolean }): Promise<void> {
  if (s?.state === 'ok') {
    // Copy must match the action: fresh auth restarts to apply the creds; an
    // already-authed (cached) result changes nothing, so it must NOT say "restarting".
    await bot.api.sendMessage(chatId, opts?.restarting
      ? '✅ Authenticated — restarting to apply (~2s).'
      : '✅ Already authenticated — your agent is ready.').catch(() => {})
  } else if (s?.state === 'error') {
    await bot.api.sendMessage(chatId, `⚠️ Login failed: ${s.error ?? 'unknown error'}. Tap /login to retry.`).catch(() => {})
  } else {
    await run5dive(['agent', 'auth', 'cancel', sid, '--json'], 5000)
    await bot.api.sendMessage(chatId, '⏱️ Login timed out — tap /login to start over.').catch(() => {})
  }
}

// Returns true if this message was handled as a slash command (caller
// should NOT enqueue it for Grok).
async function handleSlashCommand(ctx: Context, text: string): Promise<boolean> {
  // Match /<cmd> and /<cmd>@<botname> (group disambiguation).
  const m = text.match(/^\/([a-z][a-z0-9_]*)(?:@([\w]+))?(?:\s|$)/i)
  if (!m) return false
  const cmd = m[1]!.toLowerCase()
  const targetBot = m[2]?.toLowerCase()
  if (targetBot && targetBot !== botUsername.toLowerCase()) return false
  if (!BOT_COMMANDS.some(c => c.command === cmd)) return false

  const chat_id = String(ctx.chat!.id)
  const reply_to = ctx.message?.message_id
  // update_id of the triggering update. Passed to restartAgent for /restart and
  // /model so it acks/advances the getUpdates offset past this update BEFORE the
  // restart tears us down — otherwise Telegram redelivers it and we self-restart
  // in a loop (DIVE-13).
  const updateId = ctx.update.update_id
  // Everything after "/cmd" (and optional @botname) — the command arguments,
  // e.g. "add Wire up billing" for /task or "tree" for /org.
  const cmdArg = text.slice(m[0]!.length).trim()
  const md = (t: string) => bot.api.sendMessage(chat_id, t, {
    parse_mode: 'Markdown',
    ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
  })

  try {
    switch (cmd) {
      case 'help':
        await bot.api.sendMessage(chat_id, helpText(), {
          parse_mode: 'Markdown',
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      case 'status': {
        const sender = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id ?? 'you')
        await bot.api.sendMessage(chat_id, await statusText(sender), {
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      }
      case 'ping':
        await bot.api.sendMessage(chat_id, `pong — telegram-grok v${PLUGIN_VERSION}`, {
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      case 'stop': {
        const result = await interruptGrok()
        await bot.api.sendMessage(chat_id, result, {
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      }
      case 'restart': {
        // Send the reply BEFORE restarting — our own process is the MCP
        // server, but the systemd unit owns the Grok pane that runs us.
        // 5dive agent restart kills + respawns the pane; depending on
        // 5dive's implementation it may or may not also terminate us.
        // Sending first keeps the user informed even in the kill-us case.
        const name = agentName()
        await bot.api.sendMessage(chat_id, `restarting agent \`${name}\` — back in ~2s`, {
          parse_mode: 'Markdown',
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        }).catch(() => {})
        await restartAgent(name, updateId)
        return true
      }
      case 'model': {
        const r = await handleModelCommand(cmdArg)
        await md(r.text)
        if (r.switchTo) await restartAgent(agentName(), updateId)
        return true
      }
      case 'login': {
        const info = await run5dive(['agent', 'info', agentName(), '--json'])
        const type = info?.data?.type
        if (!type) {
          await bot.api.sendMessage(chat_id, "Couldn't detect your coding-CLI type — use the dashboard.")
          return true
        }
        // 0.5.0 ships /login for claude ONLY. Every fork (self-poll) type is
        // DEFERRED until DIVE-382 verifies each one's cred-path: a fork /login
        // that auths then boots a REVOKED token leaves the agent dead (codex hit
        // exactly this), which is worse than no /login — so the self-poll path
        // below is intentionally unreachable in this release. No swept type
        // literals here, so this stays identical across forks; flip per-type
        // (re-enable the self-poll) once DIVE-382 proves each type.
        const LOGIN_SELF_POLL_ENABLED = false
        if (!LOGIN_SELF_POLL_ENABLED || type === 'antigravity') {
          await bot.api.sendMessage(
            chat_id,
            `/login doesn't support ${type} yet — use the dashboard or \`5dive agent auth start ${type}\`.`,
          )
          return true
        }
        await bot.api.sendMessage(chat_id, `🔐 Starting ${type} login…`)
        const started = await run5dive(['agent', 'auth', 'start', type, '--json'], 15000)
        const sid = started?.data?.sessionId
        if (!sid) {
          await bot.api.sendMessage(chat_id, `Couldn't start login: ${started?.error?.message ?? 'failed'}.`)
          return true
        }
        const s = await pollAuthUntilFork(sid, st => !!st.url, Date.now() + 90_000)
        if (s?.state === 'ok') {
          await reportLoginFork(sid, chat_id, s) // already authed (cached creds) — no cred change, no restart
          return true
        }
        if (!s?.url) {
          await run5dive(['agent', 'auth', 'cancel', sid, '--json'], 5000)
          await bot.api.sendMessage(chat_id, 'No auth link in time — tap /login to retry.')
          return true
        }
        const codeLine = s.code ? `\n\nDevice code: ${s.code}` : ''
        await bot.api.sendMessage(
          chat_id,
          `Open this link, sign in and approve:\n${s.url}${codeLine}\n\nI'll confirm here when it completes — nothing to send back.`,
        )
        // Background-poll the device flow to completion, then APPLY the new creds by
        // restarting: a coding-CLI only reads auth at boot, and a fresh device-login
        // revokes the live session's prior token — so without a restart /login would
        // falsely report ok while the agent stays dead/on-old-creds. Restart reloads
        // creds AND re-enters the listen loop (mirrors the /model self-restart,
        // DIVE-380). Only on success; failure/timeout leaves the session untouched.
        void pollAuthUntilFork(sid, () => false, Date.now() + 3600_000).then(async fin => {
          await reportLoginFork(sid, chat_id, fin, { restarting: fin?.state === 'ok' })
          if (fin?.state === 'ok') await restartAgent(agentName())
        })
        return true
      }
      case 'team':
      case 'agents': {
        const list = await listAgents()
        await bot.api.sendMessage(chat_id, list, {
          parse_mode: 'Markdown',
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      }
      case 'tasks': {
        // Plain text (no parse_mode) so the /task_N deep links stay tappable and
        // titles aren't mangled by Markdown.
        await bot.api.sendMessage(chat_id, await buildTaskList(), {
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      }
      case 'inbox': {
        // /inbox (DIVE-1572): actionable — tap buttons live IN the reply. tier<2
        // gates (with a rec) render as one-tap ✅ Apply-rec buttons; tier-2 hard
        // gates shell the DIVE-1499 send-verb for a nonce-buttoned digest. Falls
        // back to the read-only card list on OSS hosts / unregistered senders.
        // Plain text (no parse_mode) so the /task_N deep links stay tappable.
        // DIVE-3279: one message per gate, sent in order. The FIRST pings and
        // every one after it is silent (disable_notification), so N gates cost
        // one buzz — the same trade DIVE-2712 made CLI-side. Sequential and
        // awaited: Telegram does not guarantee ordering on concurrent sends, and
        // an out-of-order stack is the mesh's unreadability back in another form.
        // `reply_to` threads only the FIRST message; threading all N under one
        // parent is noise.
        const views = await buildActionableInbox(String(ctx.from?.id ?? ''))
        // DIVE-3279 (main, at review): a send that throws must not abort the
        // stack. Telegram 429s a burst, and an unguarded loop then delivers the
        // first K gates and NO trailer — a partial inbox with nothing saying it
        // is partial, which is the exact failure this command exists to prevent.
        // It is a property of N, not of the render, so it only looks rare while
        // the open set is small.
        //
        // Each send is caught and the run continues; a 429 names its own backoff
        // in `parameters.retry_after`, honoured (bounded) so the REST of the
        // stack lands instead of compounding the limit. The trailer is always
        // last and always attempted, and reports what did not arrive — so a
        // short stack is legible rather than silent.
        let undelivered = 0
        for (const [i, view] of views.entries()) {
          const isTrailer = i === views.length - 1
          let text = view.text
          if (isTrailer && undelivered > 0) {
            text += `\n\n⚠️ ${undelivered} gate message${undelivered === 1 ? '' : 's'} could not be delivered — re-run /inbox to see ${undelivered === 1 ? 'it' : 'them'}.`
          }
          try {
            await bot.api.sendMessage(chat_id, text, {
              ...(reply_to && i === 0 ? { reply_parameters: { message_id: reply_to } } : {}),
              ...(view.keyboard ? { reply_markup: view.keyboard } : {}),
              ...(i > 0 ? { disable_notification: true } : {}),
            })
          } catch (err) {
            const retryAfter = Number((err as any)?.parameters?.retry_after ?? 0)
            const backoffMs = retryAfter > 0 && retryAfter <= 30 ? retryAfter * 1000 : 0
            if (backoffMs) await new Promise((r) => setTimeout(r, backoffMs))
            // DIVE-3279 (main, on the residual's own residual): the TRAILER is the
            // one message that reports the others, so losing it silently puts us
            // straight back in the original failure mode — a partial inbox with no
            // tell — just narrowed to a single message. Every other gate is counted
            // and reported by it; nothing counts IT. So it alone gets one bounded
            // retry, after its own retry_after. Still no retry for a gate message:
            // re-sending into a limit you just hit is the worse trade, and the
            // trailer names what is missing anyway.
            if (isTrailer) {
              try {
                await bot.api.sendMessage(chat_id, text, {
                  ...(i > 0 ? { disable_notification: true } : {}),
                })
              } catch {
                /* give up: one bounded retry, then stop rather than spin on the limit */
              }
            } else {
              undelivered++
            }
          }
        }
        return true
      }
      case 'task':
        await md(await addTask(cmdArg, ctx.from?.username || 'telegram'))
        return true
      case 'org':
        await md(await orgTree(cmdArg))
        return true
      case 'start':
        await md(
          'This bot bridges Telegram to your xAI Grok session.\n\n' +
          'Already paired? Just type. Messages here reach the Grok session.\n\n' +
          'Not paired yet? Send me a message to get a pairing code, then have the ' +
          'server operator run `5dive agent pair <agent> --code=<code>`. You can also ' +
          'be added from the 5dive dashboard (Telegram access). Standalone installs ' +
          'without 5dive: `bun pair.ts` in the telegram-grok plugin dir.\n\n' +
          'Try `/help` for the full command list.',
        )
        return true
    }
  } catch (err) {
    process.stderr.write(`telegram-grok: /${cmd} reply failed: ${err}\n`)
  }
  return true
}

function safeName(name: string | undefined): string | undefined {
  if (!name) return undefined
  // Strip path separators + nulls. Telegram-provided names are user-controlled.
  return name.replace(/[\x00\/\\]/g, '_').slice(0, 200) || undefined
}

async function ingest(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const verdict = gate(ctx)
  if (!verdict.allowed) {
    // Pairing mode: tell the stranger their code so they can relay it to the
    // operator. Sent directly (not via the allowlist-gated reply tool) since
    // the sender isn't allowed yet. The code is already persisted in pending.
    if ('pair' in verdict && verdict.pair) {
      const { code, chatId, isResend } = verdict.pair
      const lead = isResend ? 'Still pending' : 'Pairing required'
      await bot.api.sendMessage(chatId,
        `${lead} — give this code to the 5dive operator to approve you:\n\n` +
        `\`${code}\`\n\n` +
        `They run: 5dive agent pair <agent> --code=${code}`,
        { parse_mode: 'Markdown' },
      ).catch(() => {})
    }
    return
  }

  if (await handleSlashCommand(ctx, text)) return

  lastInboundTs = new Date().toISOString()

  const from = ctx.from!
  const chat = ctx.chat!
  const msgId = ctx.message?.message_id
  // Forum-supergroup topic. Telegram sets message_thread_id on every message
  // posted inside a non-General topic; absent for DMs, regular groups, and
  // posts in a supergroup's General channel. Surfaced in inbound meta so the
  // model can thread its reply back into the same topic.
  const threadId = ctx.message?.message_thread_id

  // Optional ack reaction (off by default). Fire-and-forget.
  const ack = verdict.access.ackReaction
  if (ack && msgId != null) {
    void bot.api.setMessageReaction(String(chat.id), msgId, [
      { type: 'emoji', emoji: ack as ReactionTypeEmoji['emoji'] },
    ]).catch(() => {})
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  enqueueInbound({
    chat_id: String(chat.id),
    message_id: msgId != null ? String(msgId) : '0',
    ...(threadId != null ? { message_thread_id: String(threadId) } : {}),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    text,
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment ? { attachment } : {}),
  })
}

// --- /inbox (DIVE-1334/1371): pending human gates so none are missed ---
// Renders one compact card per PENDING human gate from `5dive task inbox`.
// A gate is "pending" when it carries a need_type and has not been answered
// (need_answer null/absent). Every gate here awaits the paired human, so we
// don't filter by assignee. Read-only: acting on a gate rides /task_<id> (deep
// link) or the DIVE-1305 channel-proof replies below. clampList keeps < 4096.
function inboxCard(t: any): string {
  const flag = '⛔ '
  const type = t.need_type ? ` [${t.need_type}]` : ''
  const who = t.assignee ? ` (${String(t.assignee).replace(/^agent-/, '')})` : ''
  let title = String(t.title ?? '')
  if (title.length > 70) title = title.slice(0, 69) + '…'
  const parts = [`${flag}${t.ident}${type} · ${title}${who}`]
  if (t.recommend) parts.push(`   ⭐ rec: ${String(t.recommend)}`)
  if (t.need_options) parts.push(`   options: ${String(t.need_options)}`)
  if (t.ask) {
    let ask = String(t.ask).replace(/\s+/g, ' ').trim()
    if (!t.need_options && ask.length > 200) ask = ask.slice(0, 199) + '…'
    parts.push(`   ${ask}`)
  }
  parts.push(`   → /task_${t.id}`)
  return parts.join('\n')
}

async function buildInboxList(): Promise<string> {
  let j: { ok: boolean; data?: any; error?: { message?: string } }
  try {
    j = await run5dive(['task', 'inbox', '--json'])
  } catch (err) {
    return `Failed to load inbox: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!j.ok || !Array.isArray(j.data?.inbox)) return '5dive returned unexpected output.'
  const pending = j.data.inbox.filter((t: any) => t.need_type && !t.need_answered_at && !t.need_answer) // DIVE-2041: answered is need_answered_at (an answered SECRET gate keeps need_answer NULL); banner.ts mirrors this
  if (pending.length === 0) {
    return 'No pending gates 🎉\n\nNothing needs a human right now. You\'re all caught up.'
  }
  // Trailing "\n" per card → clampList's single-"\n" join yields a blank line
  // between cards, so multi-line cards read as distinct blocks.
  const cards = pending.map((t: any) => inboxCard(t) + '\n')
  const header =
    `🔔 ${pending.length} gate${pending.length === 1 ? '' : 's'} awaiting you. Tap /task_N to open one:\n\n`
  // To ANSWER a gate: use its original alert's Approve/Deny buttons, the
  // dashboard, or the one-tap quick-clear below ("go with recs" / "approve
  // DIVE-N") which clears tier<2 gates via DIVE-1305 channel-proof.
  const footer =
    `\n\nTo clear the tier<2 gates fast, reply "go with recs" (or "approve DIVE-N"). ` +
    `Hard money/destructive/secret/brand gates keep their per-gate button tap.`
  return clampList(header, cards, pending.length) + footer
}

// --- /inbox (DIVE-1572): ACTIONABLE gate inbox — tap buttons inline ---
// The DIVE-1568 needs-you banner points the founder at /inbox, so the buttons
// must live IN the /inbox reply, not only in a separate digest DM (lodar's
// DIVE-1525 complaint). Sourced from `task inbox --json` — the CLI's own "waiting
// on a HUMAN" view, which since DIVE-3224 also exposes `tier` beside `recommend`.
// It used to read `task ls --json` and re-derive the human/agent split here,
// because this view withheld `tier`; that copy of the rule filtered on `need_type`
// alone — "has an unanswered gate", not "needs a human" — and lodar's /inbox
// listed 12 gates of which 3 were his, the other 9 routed to agent seats and each
// carrying a ✅ button on a question addressed to somebody else (DIVE-3224). Do
// not rebuild that predicate here again: it lives in `cmd_task_inbox`, it has
// grown a fourth clause since (DIVE-3228's routed-`access` case), and a second
// copy would have missed it silently. A tier<2 gate WITH a
// recommendation is plugin-clearable: render a one-tap `✅ <ident>: <rec>` button
// that applies the rec in place via the DIVE-1305 `clear-recs --channel-proof`
// rail (the allowFrom-vetted sender id IS the human proof — an agent can't forge
// it — re-enforced CLI-side, tier<2 only; no DIVE-916 nonce needed). tier-2 hard
// gates (money/secret/destructive/brand) can't be button-minted in-plugin (the
// nonce isn't derivable — the DIVE-950 hole), so we shell the DIVE-1499 `task
// inbox --send` verb to DM a nonce-buttoned digest for those and note it inline.
// Falls back to the read-only list on OSS hosts / unregistered senders — and on a
// host whose CLI predates DIVE-3224, `tier` is simply absent, which reads as 2 and
// routes every gate through that nonce digest: fewer inline buttons, never a gate
// the founder cannot reach.
// DIVE-3279 (lodar, 2026-08-11: "need to post it one by one when i call /inbox -
// not like a messy mesh list in one message"): this returns an ARRAY of messages —
// ONE PER GATE — and the caller sends them in order. It used to return a single
// {text, keyboard} built by clampList, so N gates arrived as one wall of cards with
// one merged keyboard.
//
// This is the same fix DIVE-2712 made CLI-side in `_task_inbox_send`, which is why
// the founder saw a mesh from /inbox and a clean stack from the hard-gate digest DM
// in the SAME chat: the split only ever existed on the CLI's push path, never on
// the plugin's pull path. The reasons carry over unchanged — a card per message is
// readable at any N, and it makes the clear path correct BY CONSTRUCTION, since a
// message that carries exactly one gate cannot lose another gate's button when its
// own keyboard is retired (see the gclear handler, which no longer rebuilds).
//
// clampList is deliberately NOT used across gates any more: its job was to fit N
// cards under Telegram's 4096 cap by DROPPING the overflow behind "(+N more)", so a
// large inbox silently hid gates from the one view that exists to prevent exactly
// that. One message per gate removes the cap pressure entirely; the only clamp left
// is per-card, for a single pathological ask.
//
// THE COST IS THE PUSH COUNT, paid the same way DIVE-2712 paid it: the caller pings
// on the first message and sends every one after it silently, so the founder gets
// one buzz and a readable stack rather than N buzzes.
async function buildActionableInbox(
  senderId: string,
): Promise<{ text: string; keyboard?: InlineKeyboard }[]> {
  if (!senderId || !loadAccess().allowFrom.includes(senderId)) {
    return [{ text: await buildInboxList() }]
  }
  let j: { ok: boolean; data?: any }
  try {
    j = await run5dive(['task', 'inbox', '--json'])
  } catch {
    return [{ text: await buildInboxList() }] // no 5dive on this host (OSS) — read-only fallback
  }
  if (!j.ok || !Array.isArray(j.data?.inbox)) return [{ text: '5dive returned unexpected output.' }]
  // NO filter here, deliberately (DIVE-3224). `inbox` is already exactly the open,
  // unanswered, non-terminal gates that are waiting on a HUMAN; anything added
  // here is a second copy of a rule the CLI owns.
  const pending = j.data.inbox
  const routedElsewhere = Number(j.data?.routed_elsewhere ?? 0) || 0
  if (pending.length === 0) {
    const quiet = routedElsewhere
      ? `\n\n${routedElsewhere} open gate${routedElsewhere === 1 ? ' is' : 's are'} routed to agent seats — not yours to answer.`
      : ''
    return [{ text: "No pending gates 🎉\n\nNothing needs a human right now. You're all caught up." + quiet }]
  }
  // An ABSENT or unparseable tier reads as 2, matching the CLI view's own
  // fail-safe: such a gate keeps its card and gets a nonce-buttoned tap via the
  // digest below, rather than a plugin-minted ✅ it has not proved it may have.
  const tierOf = (t: any) => {
    const tr = Number.parseInt(String(t.tier ?? ''), 10)
    return Number.isFinite(tr) ? tr : 2
  }
  const soft = pending.filter((t: any) => tierOf(t) < 2 && !!t.recommend)
  const hardCount = pending.filter((t: any) => tierOf(t) >= 2).length
  const softIds = new Set(soft.map((t: any) => String(t.id)))

  // ONE MESSAGE PER GATE. Each carries its own card and, when that gate is the
  // plugin-clearable kind (tier<2 WITH a rec), its own single ✅ button — so the
  // button and the ask it answers can never be separated, and retiring one
  // keyboard cannot touch another gate's. `gclear:<id>` is unchanged; what
  // changed is that the callback now arrives from a message holding exactly one
  // gate, which is what lets its handler stop rebuilding the whole view.
  const messages: { text: string; keyboard?: InlineKeyboard }[] = pending.map((t: any, i: number) => {
    let text = `🔔 Gate ${i + 1}/${pending.length} awaiting you:\n\n` + inboxCard(t)
    // Per-CARD clamp only. Nothing is dropped for being the Nth gate any more —
    // this bounds one pathological ask against Telegram's 4096 cap, and a gate
    // whose text is truncated still keeps its /task_N link and its button.
    if (text.length > 4000) text = text.slice(0, 3999) + '…'
    if (softIds.has(String(t.id))) {
      const recLabel = String(t.recommend).replace(/\s+/g, ' ').trim()
      const recShort = recLabel.length > 24 ? recLabel.slice(0, 23) + '…' : recLabel
      return {
        text: text + '\n\nTap ✅ to apply the ⭐ recommendation and clear this gate.',
        keyboard: new InlineKeyboard().text(`✅ ${t.ident}: ${recShort}`, `gclear:${t.id}`),
      }
    }
    return { text }
  })

  // tier-2 hard gates → DM the nonce-buttoned digest (only the CLI mints those).
  // Fire it ONLY when a hard gate is actually pending, so the common all-soft
  // case never triggers a redundant second DM.
  let digestNote = ''
  if (hardCount > 0) {
    const sent = await handleInboxRequest(senderId)
    digestNote =
      sent && sent.startsWith('📬')
        ? `\n\n🔒 ${hardCount} hard gate${hardCount === 1 ? '' : 's'} (money/secret/destructive/brand) sent as a tap-button digest DM above — approve/deny there.`
        : `\n\n🔒 ${hardCount} hard gate${hardCount === 1 ? '' : 's'} need a per-gate tap — see /tasks or the dashboard.`
  }
  // Counted, never listed: without this a filtered inbox is indistinguishable from
  // a fleet with no open gates, which is the same "an unnotified gate reads exactly
  // like a notified one" shape the CLI's own text render guards against.
  const routedNote = routedElsewhere
    ? `\n\n(${routedElsewhere} more open gate${routedElsewhere === 1 ? '' : 's'} routed to agent seats — not yours to answer.)`
    : ''
  // The trailer, as its own final message. These are statements about the SET —
  // the hard-gate digest, the withheld count, the bulk-clear affordance — and
  // hanging them off the last gate's card would make that one gate read as if they
  // were about it. It is also the only message whose content survives a gate being
  // cleared, so nothing here may be per-gate.
  messages.push({
    text:
      `📋 ${pending.length} gate${pending.length === 1 ? '' : 's'} above.` +
      digestNote +
      routedNote +
      '\n\nOr reply "go with recs" to clear every tier<2 gate at once. You can also act on the dashboard.',
  })
  return messages
}

// DIVE-1489 (propagated via DIVE-1504): actionable /inbox. The read-only card
// list (buildInboxList) can't mint per-gate tap buttons for tier-2 gates — the
// DIVE-916 human nonce isn't derivable in-plugin, and an agent-readable nonce
// would be agent-forgeable (the DIVE-950 hole). So the actionable path shells the
// DIVE-1499 root-side verb `5dive task inbox --send`, which mints a FRESH nonce
// per hard gate, embeds it ONLY in Telegram callback_data, and DMs the paired
// owner ONE digest with WORKING tap buttons for EVERY gate type (approval/secret/
// manual included), then rotates the stored hash after confirmed delivery. We
// pass the requesting human's id as --channel-proof; the verb re-verifies it
// against access.json allowFrom before sending. Grok is polling-only (no
// SEND_ONLY relay-in drain path exists in this lineage — cf DIVE-1428, which is
// therefore N/A here), so this is wired solely into the `case 'inbox'` command
// handler. Returns the ack to post back, or null when the sender isn't a
// registered human or the host isn't a 5dive box (run5dive rejects → the caller
// falls back to the read-only buildInboxList).
async function handleInboxRequest(senderId: string): Promise<string | null> {
  if (!senderId || !loadAccess().allowFrom.includes(senderId)) return null // not a registered human
  let j: { ok: boolean; data?: any; error?: { message?: string } }
  try {
    j = await run5dive(['task', 'inbox', '--send', `--channel-proof=${senderId}`, '--json'], 10000)
  } catch {
    return null // no 5dive on this host (OSS/standalone) — caller falls back to buildInboxList
  }
  if (!j.ok) {
    return `Couldn't send your gate inbox right now. ${String(j?.error?.message ?? '').slice(0, 160)}`.trim()
  }
  if (j.data?.sent === false) {
    return 'No pending gates 🎉\n\nNothing needs a human right now. You\'re all caught up.'
  }
  const gates = Number(j.data?.gates ?? 0)
  const total = Number(j.data?.total ?? gates)
  const more = total > gates ? ` (${total - gates} more — see /tasks or the dashboard)` : ''
  return (
    `📬 Sent your gate inbox with tap buttons for ${gates} pending gate${gates === 1 ? '' : 's'}${more}. ` +
    `Approve/deny right here — money/secret/destructive/brand gates included, no dashboard needed.`
  )
}

// DIVE-1305: paired-human bulk-clear. When the paired human types "go with recs"
// (or "approve DIVE-1234" / "approve all") in their OWN DM, honor it as a human
// clear of the pending gates — applying each gate's --recommend — instead of
// making them tap every gate. The sender being in allowFrom (a paired DM) IS the
// human proof: we pass the verified chat_id to `task clear-recs --channel-proof`,
// which re-verifies it against access.json and clears ONLY tier<2 agent-clearable
// gates (tier-2 hard money/destructive/secret/brand gates keep their per-gate
// tap). Private chat only — "own channel" is a DM, not a group. Registered
// BEFORE the message bridge so it isn't forwarded to the agent as a normal
// message. Anchored patterns (^…$) so we never hijack a sentence that merely
// contains "approve". run5dive reject (no 5dive on host / OSS) → stay silent.
const BULK_RECS_RE = /^\s*(?:go with (?:the |your )?recs(?:ommendations)?|approve all|clear all(?: gates)?)\s*[.!]?\s*$/i
const APPROVE_ONE_RE = /^\s*approve\s+(DIVE-\d+|\d+)\s*[.!]?\s*$/i
bot.hears([BULK_RECS_RE, APPROVE_ONE_RE], async ctx => {
  if (ctx.chat?.type !== 'private') return // "your own channel" = a DM, never a group
  const senderId = String(ctx.from?.id ?? '')
  if (!loadAccess().allowFrom.includes(senderId)) return
  const text = ctx.message?.text ?? ''
  const one = APPROVE_ONE_RE.exec(text)
  const args = ['task', 'clear-recs', `--channel-proof=${senderId}`, '--json']
  if (one) args.push(`--only=${one[1]}`)
  let j: { ok: boolean; data?: any; error?: { message?: string } }
  try {
    j = await run5dive(args, 8000)
  } catch {
    return // no 5dive on this host (OSS/standalone) — stay silent
  }
  if (!j?.ok) {
    await ctx.reply(
      one
        ? `Couldn't clear ${one[1]} — it may be a hard gate (money/destructive/secret/brand) that still needs a button tap, or already answered. Open it: /task_${String(one[1]).replace(/^DIVE-/, '')}`
        : `Couldn't apply recommendations right now. ${String(j?.error?.message ?? '').slice(0, 160)}`.trim(),
    )
    return
  }
  const cleared = Number(j.data?.cleared ?? 0)
  const gates: string[] = Array.isArray(j.data?.gates) ? j.data.gates : []
  if (cleared === 0) {
    await ctx.reply(
      one
        ? `Nothing to clear on ${one[1]} — it's either already answered or a hard gate that keeps its per-gate tap.`
        : `No agent-clearable gates pending. (Hard money/destructive/secret/brand gates keep their per-gate tap — open /tasks to act on those.)`,
    )
    return
  }
  await ctx.reply(
    `✅ Applied your recommendations to ${cleared} gate${cleared === 1 ? '' : 's'}: ${gates.join(', ')}.` +
      `\n\nHard gates (money/destructive/secret/brand), if any, still need a per-gate tap — see /tasks.`,
  )
})

// /task_<id> — tappable deep link from the /tasks list. Opens the single-task
// detail. Registered BEFORE the message bridge so the tap is handled here and
// NOT forwarded to the agent as a normal message (no next()). Gated on allowFrom.
bot.hears(/^\/task_(\d+)\b/, async ctx => {
  const senderId = String(ctx.from?.id ?? '')
  if (!loadAccess().allowFrom.includes(senderId)) return
  const m = /^\/task_(\d+)\b/.exec(ctx.message?.text ?? '')
  if (!m) return
  const detail = await buildTaskDetail(Number(m[1]))
  await ctx.reply(detail.text, detail.keyboard ? { reply_markup: detail.keyboard } : undefined)
})

// Tap-to-answer for a human-gate ping (DIVE-117 parity, DIVE-118). The DIVE-105
// notify DM carries inline buttons for decision(--options)/approval gates; a tap
// lands here as `tna:<taskId>:<token>` — token is the option INDEX for a decision
// (resolved against the LIVE need_options, never the tapped payload: dodges the
// 64-byte callback_data cap AND can't be tampered to inject a value) or
// 'approved'/'denied' for an approval. The DB is the source of truth: re-read the
// gate first so a dashboard/CLI answer (or a double-tap) between ping and tap
// doesn't double-answer. Fully fail-soft — a stale/deleted task or any CLI error
// just acks the callback with a nudge and never throws. Only `tna:` callbacks are
// claimed; anything else falls through. (Emit is type-gated CLI-side; this lands
// dormant until task_need_notify enables buttons for this runtime — DIVE-118.)
// DIVE-332/335: auto-render a Yes/No inline keyboard when a reply ends in a
// single yes/no-style question, so the user taps instead of typing "yes". Fire
// ONLY when, after trimming, the text ends in exactly one '?', that is the ONLY
// '?' in the message, and the trailing question isn't an "A or B?" choice
// (false buttons on rhetorical/multi-part prompts are worse than a missed one).
// Opt-out: a trailing `<!-- no-buttons -->` (or `<!-- no-yn -->`), stripped from
// the outgoing text either way.
const YN_SUPPRESS = /\s*<!--\s*no-?(?:yn|buttons)\s*-->\s*$/i
function yesNoButtons(text: string): { stripped: string; keyboard?: InlineKeyboard } {
  if (YN_SUPPRESS.test(text)) return { stripped: text.replace(YN_SUPPRESS, '') }
  // DIVE-1429: pure polar-question detection lives in tna.ts (yesNoChoice); it
  // excludes wh-questions ("what's up?") that a Yes/No answer can't address.
  if (!yesNoChoice(text)) return { stripped: text }
  return {
    stripped: text,
    keyboard: new InlineKeyboard().text('✅ Yes', 'yn:yes').text('❌ No', 'yn:no'),
  }
}

// DIVE-708/717: when a reply presents a lettered/numbered CHOICE list (a) … b) …
// or 1. 2. 3.), render one tappable button per option instead of the Yes/No
// pair, so the user taps the actual choice. Detection (sequence + cue gate) is
// the pure optionChoices() in tna.ts; here we just build the keyboard. One
// button per row — option labels read better stacked than side-by-side.
// callback_data is `opt:<index>`; the chosen label is re-resolved from the
// tapped message at tap time (parseOptions), so it never has to fit the 64-byte
// callback cap. Shares the YN opt-out marker (`<!-- no-buttons -->`).
const OPT_BTN_MAX = 56 // keep button text to one tidy line in the Telegram UI
function optionButtons(text: string): { keyboard?: InlineKeyboard; labels?: string[] } {
  if (YN_SUPPRESS.test(text)) return {}
  const opts = optionChoices(text)
  if (!opts.length) return {}
  const kb = new InlineKeyboard()
  opts.forEach((o, i) => {
    const label = o.label.length > OPT_BTN_MAX ? o.label.slice(0, OPT_BTN_MAX - 1).trimEnd() + '…' : o.label
    kb.text(`${o.marker.toUpperCase()}) ${label}`, `opt:${i}`).row()
  })
  // Inject the FULL label (not the truncated button text) on tap.
  return { keyboard: kb, labels: opts.map(o => o.label) }
}

// DIVE-708/717: remember a sent message's option labels so an `opt:<index>` tap
// resolves the exact choice text. Robust to the sender-prefix/chunking that
// would make re-parsing the displayed message unreliable. Bounded cache.
const OPTION_CAP = 200
const optionLabelsByMsg = new Map<number, string[]>()
function rememberOptions(message_id: number, labels: string[]): void {
  if (optionLabelsByMsg.has(message_id)) return
  if (optionLabelsByMsg.size >= OPTION_CAP) {
    const oldest = optionLabelsByMsg.keys().next().value
    if (oldest != null) optionLabelsByMsg.delete(oldest)
  }
  optionLabelsByMsg.set(message_id, labels)
}

// DIVE-3206: the ✅ Done / ⚠️ Confirm cancel taps ran `5dive task done|cancel <id>`
// with NO --result, and the CLI refuses a first close that would leave the result
// column permanently blank (DIVE-2773 close-without-reason, and no flag bypasses
// it). So every tap failed — and in --json mode run5dive RESOLVES on a refusal
// (DIVE-2623), so the fork did not even reach its catch: it reported "✅ Marked
// done" for a close that never happened.
//
// A tap has no text field, so the honest reason is not a manufactured one: it says
// what the tap actually establishes (a verified human closed this from the task
// view, attributed to their Telegram id per DIVE-3178) and states plainly that no
// detail was captured. That is what the refusal asks for — the shape of a real
// reason — and it is deliberately NOT "n/a", which the CLI calls out by name.
function tapResult(verb: 'done' | 'cancel', taskId: string, senderId: string): string {
  const how = `by a verified human tap in Telegram (sender ${senderId}) on the /task_${taskId} detail view`
  return verb === 'cancel'
    ? `Cancelled ${how}. Nothing here was concluded — the row was dropped, not finished, and the tap carries no text field so no further reason was captured. If the why matters, it has to be added to this row by hand.`
    : `Closed ${how}. No detail was captured — the tap carries no text field — so this row records only that a human judged it complete; look at the work itself, not at this field.`
}

// A failed tap must say WHICH refusal fired, not send the human to a surface that
// was never the problem. Telegram caps a callback answer at 200 chars, hence the
// clamp.
function tapFailText(prefix: string, e: unknown): string {
  const raw = String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? '')
  const line = raw.split('\n').map(s => s.trim()).filter(Boolean).find(s => s.length > 0) ?? ''
  const detail = line.replace(/^error:\s*/i, '')
  if (!detail) return `${prefix} — open the dashboard.`
  const room = 200 - prefix.length - 3
  return `${prefix} — ${detail.length > room ? detail.slice(0, room - 1) + '…' : detail}`
}

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data ?? ''
  const senderId = String(ctx.from?.id ?? '')
  if (!loadAccess().allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }

  // DIVE-332/335: tap on an auto-rendered Yes/No question button (the reply
  // tool appends `yn:yes`/`yn:no` when a reply ends in a single yes/no
  // question). Inject the plain 'yes'/'no' as a synthetic inbound — the exact
  // path a typed reply takes (enqueueInbound) — so the agent's next
  // wait_for_message just sees the answer. Sender already vetted above; drop
  // the keyboard so it can't be double-tapped, leaving the question text intact.
  const ynM = /^yn:(yes|no)$/.exec(data)
  if (ynM) {
    const value = ynM[1]!
    const msg = ctx.callbackQuery.message
    enqueueInbound({
      chat_id: String(msg?.chat.id ?? ctx.from?.id ?? ''),
      message_id: msg ? String(msg.message_id) : '0',
      ...(msg && 'is_topic_message' in msg && msg.is_topic_message && msg.message_thread_id != null
        ? { message_thread_id: String(msg.message_thread_id) }
        : {}),
      user: ctx.from?.username ?? String(ctx.from?.id ?? ''),
      user_id: String(ctx.from?.id ?? ''),
      text: value,
      ts: new Date().toISOString(),
    })
    await ctx.editMessageReplyMarkup().catch(() => {})
    await ctx.answerCallbackQuery({ text: value === 'yes' ? '👍 Yes' : '👎 No' }).catch(() => {})
    return
  }

  // DIVE-708/717: tap on an auto-rendered choice-list button (`opt:<index>`).
  // Resolve the chosen label from the cache the send path stored against this
  // message; fall back to re-parsing the message text if the cache was lost
  // (e.g. a plugin restart between send and tap). Inject the label as a synthetic
  // inbound — the exact path a typed reply takes (enqueueInbound) — so the
  // agent's next wait_for_message just sees the choice. Sender already vetted
  // above; drop the keyboard so it can't be double-tapped, message text intact.
  const optM = OPT_RE.exec(data)
  if (optM) {
    const idx = Number(optM[1])
    const msg = ctx.callbackQuery.message
    const labels = (msg ? optionLabelsByMsg.get(msg.message_id) : undefined)
      ?? (msg && 'text' in msg && typeof msg.text === 'string' ? parseOptions(msg.text).map(o => o.label) : [])
    const value = labels[idx]
    if (value == null) {
      await ctx.answerCallbackQuery({ text: 'That option is no longer available.' }).catch(() => {})
      return
    }
    enqueueInbound({
      chat_id: String(msg?.chat.id ?? ctx.from?.id ?? ''),
      message_id: msg ? String(msg.message_id) : '0',
      ...(msg && 'is_topic_message' in msg && msg.is_topic_message && msg.message_thread_id != null
        ? { message_thread_id: String(msg.message_thread_id) }
        : {}),
      user: ctx.from?.username ?? String(ctx.from?.id ?? ''),
      user_id: String(ctx.from?.id ?? ''),
      text: value,
      ts: new Date().toISOString(),
    })
    if (msg) optionLabelsByMsg.delete(msg.message_id)
    await ctx.editMessageReplyMarkup().catch(() => {})
    const ackLabel = value.length > 40 ? value.slice(0, 39) + '…' : value
    await ctx.answerCallbackQuery({ text: `✓ ${ackLabel}` }).catch(() => {})
    return
  }

  // DIVE-449: tap on the "Escalate" button under a /task_<id> detail view.
  // Semantics A (Mark, 2026-06-17): flag for attention — `task escalate` bumps
  // the task priority a tier (capped at urgent) and pings the owning agent + the
  // paired human. Sender already vetted above; drop the button so it can't
  // double-fire, and any CLI error just acks softly. Re-open /task_<id> to
  // escalate again (high -> urgent); the rebuilt detail re-renders the button.
  const escM = /^esc:(\d+)$/.exec(data)
  if (escM) {
    const taskId = escM[1]!
    try {
      const r = await run5dive(['task', 'escalate', taskId, '--json'], 8000)
      const pri = r.ok ? (r.data?.priority ?? 'high') : 'high'
      await ctx.answerCallbackQuery({ text: `🔺 Escalated — priority ${pri}` }).catch(() => {})
      // DIVE-503: after escalating, swap the keyboard for a single "▶️ Do now"
      // (Mark's "when I press escalate" flow) so a priority bump leads straight
      // into kicking the agent off, instead of the buttons just vanishing.
      await ctx.editMessageReplyMarkup({
        reply_markup: new InlineKeyboard().text('▶️ Do now', `donow:${taskId}`),
      }).catch(() => {})
    } catch {
      await ctx.answerCallbackQuery({ text: "Couldn't escalate — open the dashboard." }).catch(() => {})
    }
    return
  }

  // DIVE-503: "▶️ Do now" tap (Mark, 2026-06-18). Active interrupt — distinct
  // from Escalate's passive priority bump. Resolves the task's assignee and pings
  // that agent directly to pick it up immediately, then flips the task to
  // in_progress. Refuses if unassigned (nothing to ping). Fail-soft + drops the
  // button after a successful tap, mirroring the esc:/tna: flows.
  const dnM = /^donow:(\d+)$/.exec(data)
  if (dnM) {
    const taskId = dnM[1]!
    try {
      const show = await run5dive(['task', 'show', taskId, '--json'], 5000)
      const task = show.ok ? show.data?.task : undefined
      const assignee = task?.assignee ? String(task.assignee).replace(/^agent-/, '') : ''
      if (!assignee) {
        await ctx.answerCallbackQuery({ text: 'No assignee — assign it first.' }).catch(() => {})
        return
      }
      const ident = task?.ident ?? `task ${taskId}`
      // Flip to in_progress (idempotent; ignore if already started), then ping.
      await run5dive(['task', 'start', taskId, '--json'], 8000).catch(() => {})
      const msg = `▶️ Mark wants ${ident} done now — please pick it up immediately. Details: /task_${taskId}`
      await run5dive(['agent', 'send', assignee, msg, '--json'], 8000)
      await ctx.answerCallbackQuery({ text: `▶️ Pinged ${assignee} — on it now` }).catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
    } catch {
      await ctx.answerCallbackQuery({ text: "Couldn't kick it off — open the dashboard." }).catch(() => {})
    }
    return
  }

  // DIVE-503: ✅ Done (one-tap) / 🚫 Cancel (two-tap confirm) for /task_<id>.
  // Done marks complete; Cancel arms first (swaps to a Confirm/Keep pair) so an
  // accidental tap can't kill a task. All fail-soft like the esc:/donow: flows.
  const tdM = /^tdone:(\d+)$/.exec(data)
  if (tdM) {
    const taskId = tdM[1]!
    try {
      const r = await run5dive(['task', 'done', taskId, '--json', `--result=${tapResult('done', taskId, senderId)}`], 8000)
      if (!r.ok) throw new Error(r.error?.message ?? 'the CLI refused the close')
      await ctx.answerCallbackQuery({ text: '✅ Marked done' }).catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
    } catch (e) {
      await ctx.answerCallbackQuery({ text: tapFailText("Couldn't mark done", e) }).catch(() => {})
    }
    return
  }
  // First tap on Cancel — arm the confirm rather than cancelling outright.
  const tcM = /^tcancel:(\d+)$/.exec(data)
  if (tcM) {
    const taskId = tcM[1]!
    await ctx.answerCallbackQuery({ text: 'Tap "Confirm cancel" to cancel this task.' }).catch(() => {})
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard()
        .text('⚠️ Confirm cancel', `tcancelc:${taskId}`)
        .text('↩︎ Keep', `tkeep:${taskId}`),
    }).catch(() => {})
    return
  }
  // Confirmed cancel.
  const tccM = /^tcancelc:(\d+)$/.exec(data)
  if (tccM) {
    const taskId = tccM[1]!
    try {
      const r = await run5dive(['task', 'cancel', taskId, '--json', `--result=${tapResult('cancel', taskId, senderId)}`], 8000)
      if (!r.ok) throw new Error(r.error?.message ?? 'the CLI refused the cancel')
      await ctx.answerCallbackQuery({ text: '🚫 Cancelled' }).catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
    } catch (e) {
      await ctx.answerCallbackQuery({ text: tapFailText("Couldn't cancel", e) }).catch(() => {})
    }
    return
  }
  // "Keep" — back out of the cancel-confirm by rebuilding the full detail keyboard.
  const tkM = /^tkeep:(\d+)$/.exec(data)
  if (tkM) {
    const taskId = tkM[1]!
    try {
      const detail = await buildTaskDetail(Number(taskId))
      await ctx.editMessageText(detail.text, { reply_markup: detail.keyboard }).catch(() => {})
    } catch {}
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  // DIVE-1572: ✅ inline gate-clear tap from the actionable /inbox. Applies the
  // tier<2 gate's ⭐ recommendation in place via the DIVE-1305 clear-recs
  // channel-proof rail — the verified sender id (allowFrom-vetted at the top of
  // this handler) is the human proof, re-enforced CLI-side (tier<2 only). On
  // success we rebuild the inbox so the cleared gate's button drops; a tier-2 /
  // already-answered gate acks softly (its buttons live in the --send digest).
  const gcM = /^gclear:(\d+)$/.exec(data)
  if (gcM) {
    const taskId = gcM[1]!
    try {
      const cj = await run5dive(
        ['task', 'clear-recs', `--channel-proof=${senderId}`, `--only=${taskId}`, '--json'],
        8000,
      )
      if (cj?.ok && Number(cj.data?.cleared ?? 0) > 0) {
        await ctx.answerCallbackQuery({ text: '✅ Applied your recommendation' }).catch(() => {})
        // DIVE-3279: mark THIS message resolved and drop ITS keyboard — do not
        // rebuild the inbox into it. Since the split, the message that carried
        // this button holds exactly one gate, so editing it with the full
        // rebuilt view would re-mesh every remaining gate into the message the
        // founder just cleared — silently undoing the one-per-gate split on the
        // very first tap, and taking the other gates' own messages out of sync
        // with it. The remaining gates keep their own messages and their own
        // live buttons; /inbox re-run is no longer needed to reach them, which
        // is the DIVE-2712 property this path now inherits.
        const prior = String((ctx.callbackQuery?.message as any)?.text ?? '')
        await ctx
          .editMessageText((prior ? prior + '\n\n' : '') + '✅ Cleared — your recommendation was applied.')
          .catch(() => {})
      } else {
        await ctx
          .answerCallbackQuery({ text: '🔒 Hard gate or already answered — use the digest tap or the dashboard.' })
          .catch(() => {})
      }
    } catch {
      await ctx.answerCallbackQuery({ text: "Couldn't clear — open the dashboard." }).catch(() => {})
    }
    return
  }

  const tnaM = TNA_RE.exec(data)
  if (!tnaM) return
  const taskId = tnaM[1]!
  const token = tnaM[2]!
  // DIVE-916: per-gate HUMAN nonce from callback_data → forwarded as --human-proof.
  const humanProof = tnaM[3]
  let tnaIdent: string | null = null
  try {
    const show = await run5dive(['task', 'show', taskId, '--json'], 5000)
    const task = show.ok ? show.data?.task : undefined
    // Branch logic lives in resolveTnaAnswer (DIVE-369, byte-identical across
    // base+forks, pinned headless by test/tna-harness.test.ts). Thin I/O adapter.
    // DIVE-2846: the ident is what a human can look up; the callback carries
    // only the internal id. Keep it so a failure names the right task.
    if (typeof (task as any)?.ident === 'string') tnaIdent = (task as any).ident
    const r = resolveTnaAnswer(task, token)
    if (r.kind === 'nogate') {
      await ctx.answerCallbackQuery({ text: 'This task no longer has a gate.' }).catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
      return
    }
    if (r.kind === 'already') {
      await ctx.answerCallbackQuery({ text: r.toast }).catch(() => {})
      await ctx.editMessageText(r.edit).catch(() => {})
      return
    }
    if (r.kind === 'invalid') {
      await ctx.answerCallbackQuery({ text: 'That option is no longer valid.' }).catch(() => {})
      await ctx.editMessageReplyMarkup().catch(() => {})
      return
    }
    // DIVE-518/916: a verified human tap (allowFrom gate above) — mark --human
    // and attach human-evidence for a hard human gate. DIVE-916 folds in `manual`
    // (now human-enforced) and forwards --human-proof (the per-gate nonce) as the
    // tap-path evidence (SUDO_UID here is the agent). DIVE-950 dropped the old
    // --proof form (agent-forgeable). Any one accepted form suffices; decision none.
    // DIVE-1115: mark EVERY verified-human tap --human (allowFrom vetted the
    // tapper above) so decision/manual taps no longer record a bare agent name,
    // which was invisible to the zero-human KPI. See tapEvidenceArgs.
    const extraArgs = tapEvidenceArgs(humanProof, {
      uid: ctx.callbackQuery.from?.id,
      username: ctx.callbackQuery.from?.username,
      messageId: ctx.callbackQuery.message?.message_id,
      osUser: process.env.USER,
    })
    // DIVE-2623: run5dive() RESOLVES (never rejects) on a CLI refusal in --json
    // mode, unlike base's execFileP. Without this check an ok:false envelope
    // (e.g. a task_answer_closed_row refusal, DIVE-2228) fell through as if the
    // answer succeeded and the catch block below never ran.
    const answered = await run5dive(['task', 'answer', taskId, ...r.answerArgs, ...extraArgs, '--json'], 8000)
    if (!answered.ok) throw new Error(answered.error?.message || 'task answer failed')
    await ctx.answerCallbackQuery({ text: `Answered: ${r.ack}` }).catch(() => {})
    await ctx.editMessageText(`✅ answered: ${r.ack}`).catch(() => {})
  } catch (err) {
    // DIVE-2846: bind the exception. The old `catch {` bound nothing, so a tap that
    // told a human it failed left NO record of why anywhere, and the cause was
    // unrecoverable after the fact. Three things now happen instead: keep and record
    // the exception, RE-READ the gate so we report what actually landed rather than
    // asserting a failure we never confirmed, and name the real ident — `DIVE-<id>`
    // was the INTERNAL id, which names a different real task (id 2846 is DIVE-2659).
    // DIVE-894 still holds: point at the on-box command, not a dashboard.
    const info = describeTapError(err)
    let landing: TapLanding = 'unknown'
    let answer: string | null = null
    let recheckDetail: string | null = null
    try {
      const re = await run5dive(['task', 'show', taskId, '--json'], 5000)
      const t = re.ok ? re.data?.task : undefined
      landing = tapLanding(re.ok === true, t)
      if (typeof t?.ident === 'string') tnaIdent = t.ident
      answer = t?.need_answer ?? null
    } catch (reErr) {
      recheckDetail = describeTapError(reErr).detail
    }
    const copy = tapFailureCopy({ taskId, ident: tnaIdent, err: info, landing, answer, recheckDetail })
    recordTapFailure(copy.log)
    await ctx.answerCallbackQuery({ text: copy.toast }).catch(() => {})
    await ctx.reply(copy.chat).catch(() => {})
  }
})

bot.on('message:text', async ctx => {
  await ingest(ctx, ctx.message.text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await ingest(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '') || 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${safeExt}`)
      writeFileSync(path, buf)
      return path
    } catch (err) {
      process.stderr.write(`telegram-grok: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
  await ingest(ctx, text, undefined, {
    kind: 'document', file_id: doc.file_id,
    size: doc.file_size, mime: doc.mime_type, name,
  })
})

bot.on('message:voice', async ctx => {
  const v = ctx.message.voice
  await ingest(ctx, ctx.message.caption ?? '(voice message)', undefined, {
    kind: 'voice', file_id: v.file_id, size: v.file_size, mime: v.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const a = ctx.message.audio
  const name = safeName(a.file_name)
  await ingest(ctx, ctx.message.caption ?? `(audio: ${safeName(a.title) ?? name ?? 'audio'})`, undefined, {
    kind: 'audio', file_id: a.file_id, size: a.file_size, mime: a.mime_type, name,
  })
})

bot.on('message:video', async ctx => {
  const v = ctx.message.video
  await ingest(ctx, ctx.message.caption ?? '(video)', undefined, {
    kind: 'video', file_id: v.file_id, size: v.file_size,
    mime: v.mime_type, name: safeName(v.file_name),
  })
})

bot.on('message:sticker', async ctx => {
  const s = ctx.message.sticker
  const emoji = s.emoji ? ` ${s.emoji}` : ''
  await ingest(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker', file_id: s.file_id, size: s.file_size,
  })
})

bot.catch(err => {
  process.stderr.write(`telegram-grok: handler error (polling continues): ${err.error}\n`)
})

// ============================================================================
// MCP server
// ============================================================================

const mcp = new Server(
  { name: 'telegram-grok', version: PLUGIN_VERSION },
  { capabilities: { tools: {} } },
)

const FORMAT_DESC =
  "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). "
  + "Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed)."

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'wait_for_message',
      description:
        "Block until the user sends a Telegram message, then return it. "
        + "Call this whenever you're idle waiting on user input — it replaces the "
        + "Grok CLI's normal stdin prompt for chats routed through this bot. "
        + "Returns a <telegram chat_id=... message_id=... user=...> block with the "
        + "message body — or, when several messages queued up while you were busy, a "
        + "<telegram-batch> of such blocks; answer each as appropriate (they may be from "
        + "different chats). Use the chat_id and message_id in subsequent reply/react calls. "
        + "If no message arrives before the timeout, returns <telegram timeout=true/>: "
        + "END YOUR TURN. Do NOT call wait_for_message again just to keep polling on an empty "
        + "inbox — that burns a model turn every cycle. The server re-arms this loop the moment "
        + "a real message is queued, so no inbound is ever missed.",
      inputSchema: {
        type: 'object',
        properties: {
          timeout_seconds: {
            type: 'number',
            description:
              "Max seconds to wait before returning <telegram timeout=true/>. Default 50, max 50 — "
              + "capped to stay under Grok's default 60s MCP tool timeout (tool_timeout_sec), past "
              + "which the call is killed and an inbound that arrived near the boundary is dropped. "
              + "Keep the default instead of asking for longer (raise tool_timeout_sec for this "
              + "server in ~/.grok/config.toml if you genuinely need longer polls).",
          },
        },
      },
    },
    {
      name: 'reply',
      description:
        'Reply on Telegram. Pass chat_id from a prior wait_for_message result. '
        + 'Optionally pass reply_to (message_id) for threading under a specific message, '
        + 'message_thread_id for posting into a forum topic, and files (absolute paths) to attach.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
          reply_to: {
            type: 'string',
            description: 'Message ID to thread under. Use message_id from an inbound message.',
          },
          message_thread_id: {
            type: 'string',
            description: "Forum topic id. Pass through verbatim from an inbound message's message_thread_id when present, so the reply lands in the same topic instead of the supergroup's General channel. Omit if the inbound had none.",
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths to attach. Images send as photos, other types as documents. Max 50MB each.',
          },
          format: { type: 'string', enum: ['text', 'markdownv2'], description: FORMAT_DESC },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'edit_message',
      description:
        "Edit a message the bot previously sent. Useful for interim progress updates that don't "
        + "trigger a push notification on the user's device. Send a fresh reply for final results.",
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
          format: { type: 'string', enum: ['text', 'markdownv2'], description: FORMAT_DESC },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
    {
      name: 'react',
      description:
        'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist '
        + '(👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'download_attachment',
      description:
        'Download a file attachment from a Telegram message to the local inbox. Use when '
        + 'an inbound message had attachment_file_id. Returns the local file path. '
        + 'Telegram caps bot downloads at 20MB.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The attachment_file_id from an inbound message' },
        },
        required: ['file_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  markActivity()
  try {
    switch (req.params.name) {
      case 'wait_for_message': {
        const requested = Number(args.timeout_seconds ?? 50)
        const seconds = Math.max(1, Math.min(50, isFinite(requested) ? requested : 50))
        const msg = await dequeueOrWait(seconds * 1000)
        if (!msg) {
          return { content: [{ type: 'text', text: `<telegram timeout=true seconds=${seconds}/>` }] }
        }
        // Drain the rest of a queued burst into the SAME turn — each extra
        // message would otherwise cost a full model turn (~30s apiece of reply
        // latency for the sender). Capped so a backlog flood after a stall
        // can't blow the context window. Metadata stays per-message, so the
        // agent can still answer each chat/thread individually.
        const batch = [msg]
        while (inboxQueue.length > 0 && batch.length < BATCH_DRAIN_MAX) {
          batch.push(inboxQueue.shift()!)
        }
        // Grok now has a message to work on — keep "typing…" visible until
        // it sends `reply` (or the 5min ceiling).
        startTypingLoop(msg.chat_id)
        try { writeFileSync(LAST_INBOUND_FILE, String(Date.now())) } catch {}
        if (batch.length === 1) {
          return { content: [{ type: 'text', text: formatInbound(msg) }] }
        }
        const blocks = batch.map(formatInbound).join('\n')
        return { content: [{ type: 'text', text:
          `<telegram-batch count=${batch.length} note="messages queued while you were busy; answer each as appropriate">\n${blocks}\n</telegram-batch>` }] }
      }

      case 'reply': {
        const chat_id = String(args.chat_id)
        const text = String(args.text)
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
        // Forum-topic routing — see the reply tool description. Omitted →
        // reply goes to General (or the only thread, in a plain group / DM).
        const message_thread_id = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
        const files = (args.files as string[] | undefined) ?? []
        const format = (args.format as string | undefined) ?? 'text'
        const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined

        assertAllowedChat(chat_id)
        stopTypingLoop(chat_id)
        for (const f of files) {
          assertInStateDir(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
          }
        }

        const accessForReply = loadAccess()
        // DIVE-332/335: auto-render a Yes/No keyboard when the reply ends in a
        // single yes/no question (opt-out marker stripped either way). The tap
        // rides the callback path below, injecting a clean 'yes'/'no' inbound.
        const { stripped: ynText, keyboard: ynKeyboard } = yesNoButtons(text)
        const chunks = chunkForTelegram(ynText, accessForReply.textChunkLimit ?? TG_MAX_MESSAGE_CHARS)
        // DIVE-708/717: a choice-list keyboard takes precedence over Yes/No, but
        // only when the whole reply is a single chunk — the tap resolves the
        // option from the message it's attached to, so every option must live in
        // it.
        const optRes = chunks.length === 1 ? optionButtons(text) : {}
        const lastKeyboard = optRes.keyboard ?? ynKeyboard
        const sentIds: number[] = []
        try {
          for (let i = 0; i < chunks.length; i++) {
            // Thread reply_to only on the first chunk — subsequent chunks
            // would all quote the same inbound, which is noisy. The keyboard
            // (choice-list or Yes/No) attaches to the LAST chunk only.
            const isLastChunk = i === chunks.length - 1
            const sent = await bot.api.sendMessage(chat_id, chunks[i]!, {
              ...(i === 0 && reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
              ...(message_thread_id != null ? { message_thread_id } : {}),
              ...(parseMode ? { parse_mode: parseMode } : {}),
              ...(isLastChunk && lastKeyboard ? { reply_markup: lastKeyboard } : {}),
            })
            // DIVE-708/717: cache the option labels against the message the
            // keyboard rides on, so its taps resolve to the right choice text.
            if (isLastChunk && optRes.keyboard && optRes.labels) {
              rememberOptions(sent.message_id, optRes.labels)
            }
            sentIds.push(sent.message_id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        for (const f of files) {
          const ext = extname(f).toLowerCase()
          const input = new InputFile(f)
          const opts = {
            ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
            ...(message_thread_id != null ? { message_thread_id } : {}),
          }
          const out = PHOTO_EXTS.has(ext)
            ? await bot.api.sendPhoto(chat_id, input, opts)
            : await bot.api.sendDocument(chat_id, input, opts)
          sentIds.push(out.message_id)
        }

        // Stamp for the Stop hook's duplicate-suppression check.
        try { writeFileSync(LAST_REPLY_FILE, String(Date.now())) } catch {}

        const result = sentIds.length === 1
          ? `sent (id: ${sentIds[0]})`
          : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }] }
      }

      case 'edit_message': {
        const chat_id = String(args.chat_id)
        const message_id = Number(args.message_id)
        assertAllowedChat(chat_id)
        const editFormat = (args.format as string | undefined) ?? 'text'
        const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
        const edited = await bot.api.editMessageText(
          chat_id, message_id, String(args.text),
          ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
        )
        const id = typeof edited === 'object' ? edited.message_id : message_id
        return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
      }

      case 'react': {
        const chat_id = String(args.chat_id)
        assertAllowedChat(chat_id)
        await bot.api.setMessageReaction(chat_id, Number(args.message_id), [
          { type: 'emoji', emoji: String(args.emoji) as ReactionTypeEmoji['emoji'] },
        ])
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'download_attachment': {
        const file_id = String(args.file_id)
        const file = await bot.api.getFile(file_id)
        if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
        const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
        const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
        const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
        writeFileSync(path, buf)
        return { content: [{ type: 'text', text: path }] }
      }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

// ============================================================================
// Listen-loop self-heal
//
// codex/grok have no push channel: the agent only receives Telegram messages
// while parked in a wait_for_message call, which it re-enters after each reply
// (see AGENTS.md "Loop"). A rough restart — e.g. the nightly host-updates cron
// leaving systemd timeout-kills + leftover processes — can boot the agent to an
// idle prompt OUTSIDE that loop. The server keeps draining getUpdates but the
// model never sees the message, so the bot looks dead. We watch for that and
// re-kick the loop via the same tmux send-keys path /stop already uses.
//
// Knobs: TELEGRAM_REARM_DISABLED=1 turns it off; TELEGRAM_REARM_IDLE_MS sets the
// idle threshold (default 180000). It MUST comfortably exceed the longest single
// model-inference span: a reasoning model can reason 60–120s+ in ONE span that
// writes nothing to the session transcript, so newestTurnMtimeMs() goes stale
// mid-turn and a lower threshold kicks a busy agent off its task (customer bug
// 5dive-exact-swallow). 180s covers typical reasoning; a genuinely-wedged
// session is still caught (just slower) and backstopped by sendStallAlert.
// Tunable up to 600s for agents that reason even longer.
// ============================================================================
const REARM_DISABLED = process.env.TELEGRAM_REARM_DISABLED === '1'
const REARM_IDLE_MS = Math.max(20_000, Math.min(600_000,
  Number(process.env.TELEGRAM_REARM_IDLE_MS ?? 180_000)))
const REARM_CHECK_MS = 15_000
// Max queued messages handed to one wait_for_message return (burst batching).
const BATCH_DRAIN_MAX = 10
const REARM_KICK_TEXT =
  'A Telegram message is waiting: call wait_for_message now to receive it, then reply. '
  + 'After handling any queued messages, if wait_for_message returns <telegram timeout=true/>, '
  + 'END YOUR TURN — the server re-arms you when the next message arrives. '
  + 'This is an automated re-arm; do not send a Telegram reply about it.'

// Bumped on every MCP tool call. A working agent (not parked in wait_for_message)
// still acks/edits within ~30s, so recent activity means "busy, leave alone";
// prolonged silence with no parked waiter means "fell out of the loop".
let lastServerActivity = Date.now()
let rearmKicks = 0
function markActivity(): void { lastServerActivity = Date.now() }

// ── Silent-failure self-report ──────────────────────────────────────────────
// The re-arm watchdog above keeps a *healthy* agent in the listen loop. Some
// stalls can't be re-armed, though: an exhausted model quota, an expired login,
// or a wedged TUI. The agent then takes no model turn at all — so neither the
// listen loop nor the silence hook (which only fires on a tool call) can tell
// the user anything; the bot just goes quiet. This server is still alive
// draining getUpdates, so it's the one component that can still reach Telegram.
// When re-arm kicks repeatedly fail to revive the loop, we scan the pane for a
// known cause and send the owner ONE alert.
//
// Knobs: TELEGRAM_STALL_ALERT_DISABLED=1 turns it off; TELEGRAM_STALL_ESCALATE_AFTER
// sets how many failed re-arm kicks count as "genuinely wedged" (default 3).
const STALL_ALERT_DISABLED = process.env.TELEGRAM_STALL_ALERT_DISABLED === '1'
const STALL_ESCALATE_AFTER = Math.max(1, Math.min(20,
  Number(process.env.TELEGRAM_STALL_ESCALATE_AFTER ?? 3)))
const LAST_STALL_ALERT_FILE = join(STATE_DIR, 'last-stall-alert.stamp')
// One alert per stall episode. Set when we alert, cleared when the loop
// recovers (a waiter re-parks). Persisted to a stamp so a server bounce
// mid-stall doesn't re-ping.
let stallAlerted = existsSync(LAST_STALL_ALERT_FILE)
// The pane as it looked when we alerted. Written next to the stamp so the NEXT
// occurrence is diagnosable from the box itself instead of from a forwarded
// screenshot (DIVE-3786: the customer report we had was a photo of a chat).
const LAST_STALL_PANE_FILE = join(STATE_DIR, 'last-stall-pane.txt')
let _lastPane = ''
// Set by kickListenLoop() when it types a re-arm prompt and then CANNOT observe
// its own Enter landing. This is the one "wedged" state we actually measure, as
// opposed to inferring it from a pane scrape that matched none of our patterns.
let rearmSubmitFailed = false

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1) }

// Capture the agent's tmux pane and classify a stall cause from known failure
// banners, so the alert can name the actual problem. Best-effort: any failure
// to read/classify falls back to a generic "wedged" message.
function detectStallCause(): { cause: string; detail: string } {
  const name = agentName()
  try {
    const cp = require('child_process')
    const pane: string = cp.execFileSync('tmux',
      ['capture-pane', '-t', `agent-${name}`, '-p'],
      { timeout: 5_000, encoding: 'utf8' })
    _lastPane = pane
    const tail = pane.slice(-4000)
    // Model/credit quota exhausted (e.g. Antigravity "Individual quota reached").
    if (/quota reached|out of (?:credits|quota)|usage limit|rate limit exceeded/i.test(tail)) {
      const reset = tail.match(/resets? in[^\n]*/i)?.[0]?.trim()
      return { cause: 'model quota/credits exhausted', detail: reset ? capitalize(reset) : 'no reset time shown in the pane' }
    }
    // Auth expired / sitting at a login screen.
    if (/\b(sign in|log ?in|authenticate|re-?authenticate|oauth|enter your api key)\b/i.test(tail)) {
      return { cause: 'auth expired — sitting at a login screen', detail: 're-run `5dive agent auth …` for this agent' }
    }
    // Our own re-arm keystrokes went in and we could not see the submit land.
    // Unlike everything below this line, that IS an observation.
    if (rearmSubmitFailed) {
      return {
        cause: 'stuck at the input prompt',
        detail: 'the agent is idle and our re-arm keystrokes are not being submitted — try /restart',
      }
    }
    // Nothing matched. This branch means exactly "it stopped answering and none
    // of the patterns above fired" — so say that, and show the owner what is
    // actually on the screen. Do NOT name a mechanism we never tested: the old
    // text here claimed the listen loop was wedged and that the agent would not
    // re-arm, neither of which this function looks at (DIVE-3786).
    return { cause: 'not responding — cause unknown', detail: paneTailSummary(tail) }
  } catch {
    return { cause: 'not responding', detail: 'could not read the agent pane' }
  }
}

// The last few non-empty screen lines, for an alert that cannot name a cause.
// Trimmed hard: this goes in a Telegram message, not a log.
function paneTailSummary(tail: string): string {
  const lines = tail.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '')
  const last = lines.slice(-3).map((l) => (l.length > 100 ? l.slice(0, 99) + '…' : l))
  if (last.length === 0) return 'the agent screen is blank'
  return 'Last lines on its screen:\n' + last.map((l) => '  ' + l).join('\n')
}

// detectStallCause does a synchronous pane capture; cache it briefly so a burst
// of inbound messages (each auto-replied while stalled) doesn't fire one tmux
// capture per message. 5s TTL keeps the reported cause effectively live.
let _causeCache: { at: number; val: { cause: string; detail: string } } | null = null
function detectStallCauseCached(): { cause: string; detail: string } {
  const now = Date.now()
  if (_causeCache && now - _causeCache.at < 5_000) return _causeCache.val
  const val = detectStallCause()
  _causeCache = { at: now, val }
  return val
}

// Send one stall alert to every owner (allowFrom) DM. Plain text — no markdown,
// so a banner containing special characters can't break the message.
function sendStallAlert(): void {
  if (stallAlerted) return
  const name = agentName()
  const { cause, detail } = detectStallCause()
  const text = `⚠️ ${name} stopped responding — ${cause}.\n${detail}.\n\n`
    + 'The Telegram listen loop isn’t recovering on its own. Try /restart, or check the agent pane.'
  const owners = loadAccess().allowFrom ?? []
  if (owners.length === 0) {
    process.stderr.write('telegram-grok: stall detected but no allowFrom owner to alert\n')
    return
  }
  for (const id of owners) {
    bot.api.sendMessage(id, text).catch((err: any) =>
      process.stderr.write(`telegram-grok: stall alert to ${id} failed: ${err?.message}\n`))
  }
  stallAlerted = true
  try { writeFileSync(LAST_STALL_ALERT_FILE, String(Date.now())) } catch {}
  // Keep the evidence on the box. Without this the only record of what the
  // agent was sitting on is whatever the owner happens to screenshot.
  try {
    writeFileSync(LAST_STALL_PANE_FILE,
      `# ${new Date().toISOString()} ${name} — ${cause}: ${detail}\n${_lastPane}`)
  } catch {}
  process.stderr.write(`telegram-grok: stall alert sent (${cause}) to ${owners.length} owner(s)\n`)
}

// Loop recovered — drop the dedup flag so a future stall alerts again.
function clearStallAlert(): void {
  rearmSubmitFailed = false
  if (!stallAlerted) return
  stallAlerted = false
  try { if (existsSync(LAST_STALL_ALERT_FILE)) unlinkSync(LAST_STALL_ALERT_FILE) } catch {}
}

// ── Re-arm kick ─────────────────────────────────────────────────────────────
// Typing into a live TUI has two silent failure modes, and the old version of
// this function had both (DIVE-3786):
//
//   1. `send-keys -l` APPENDS. If a previous delivery's Enter was dropped, its
//      text is still sitting in the composer, and every later kick concatenates
//      onto that stranded line instead of replacing it. Since the recovery path
//      IS the delivery path, the failure repairs itself into a worse one.
//   2. The Enter was fire-and-forget — the callback discarded the result, right
//      under a comment saying the TUI "occasionally drops an Enter".
//
// So now: clear the composer first, submit as its own call, and CHECK. A landed
// Enter clears the composer and starts a turn, so the pane must change; byte-
// identical panes before and after mean the keystroke went nowhere.
const REARM_TYPE_SETTLE_MS = 400
const REARM_SUBMIT_SETTLE_MS = 700

function capturePaneSync(name: string): string | null {
  try {
    const cp = require('child_process')
    return cp.execFileSync('tmux', ['capture-pane', '-t', `agent-${name}`, '-p'],
      { timeout: 5_000, encoding: 'utf8' }) as string
  } catch { return null }
}

function sendKeysAsync(name: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const cp = require('child_process')
    cp.execFile('tmux', ['send-keys', '-t', `agent-${name}`, ...args],
      { timeout: 5_000 }, (err: any) => {
        if (err) process.stderr.write(`telegram-grok: rearm send-keys failed: ${err.message}\n`)
        resolve(!err)
      })
  })
}

const rearmSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// One clear-type-submit-verify attempt. Returns true only if the submit was
// OBSERVED to change the pane; a pane we cannot read counts as unconfirmed.
async function kickListenLoopOnce(name: string): Promise<boolean> {
  // C-u kills the composer line. Verified against a live codex TUI on 2026-08-28:
  // typing a probe string then sending C-u returns the composer to its
  // placeholder hint, i.e. genuinely empty.
  if (!(await sendKeysAsync(name, ['C-u']))) return false
  if (!(await sendKeysAsync(name, ['-l', REARM_KICK_TEXT]))) return false
  await rearmSleep(REARM_TYPE_SETTLE_MS)
  const typed = capturePaneSync(name)
  if (!(await sendKeysAsync(name, ['Enter']))) return false
  await rearmSleep(REARM_SUBMIT_SETTLE_MS)
  const after = capturePaneSync(name)
  if (typed === null || after === null) return false
  return after !== typed
}

function kickListenLoop(): void {
  const name = agentName()
  if (name === 'unknown') return
  void (async () => {
    if (await kickListenLoopOnce(name)) { rearmSubmitFailed = false; return }
    // A busy TUI can swallow one Enter; a wedged one swallows every Enter.
    process.stderr.write('telegram-grok: rearm submit not observed, retrying once\n')
    if (await kickListenLoopOnce(name)) { rearmSubmitFailed = false; return }
    rearmSubmitFailed = true
    process.stderr.write('telegram-grok: rearm submit still not observed — agent is not accepting input\n')
  })()
}

// Newest agent-turn mtime (ms) — the "still doing real work" signal used by the
// watchdog below. Grok writes per-turn transcript files (events/chat_history/
// updates .jsonl) under ~/.grok/sessions/<cwd>/<session-id>/. prompt_history.jsonl
// is deliberately EXCLUDED: the re-arm prompt itself lands there, so it would
// mask a genuinely-wedged session. Returns 0 if none found.
const GROK_SESSIONS_DIR = join(STATE_DIR, '..', '..', 'sessions')
function newestTurnMtimeMs(): number {
  try {
    const cp = require('child_process')
    const out: string = cp.execFileSync('find',
      [GROK_SESSIONS_DIR, '-type', 'f', '(',
        '-name', 'events.jsonl', '-o', '-name', 'chat_history.jsonl', '-o', '-name', 'updates.jsonl',
       ')', '-printf', '%T@\\n'],
      { timeout: 4_000, encoding: 'utf8' })
    const secs = out.split('\n').reduce((m: number, l: string) => Math.max(m, Number(l) || 0), 0)
    if (secs > 0) return Math.round(secs * 1000)
  } catch { /* fall through */ }
  return 0
}

// Whether a model turn is genuinely IN FLIGHT right now — the authoritative
// "don't kick" signal. newestTurnMtimeMs() infers liveness from file mtime, but
// grok writes NOTHING to the session log during a model-inference span: a
// reasoning model can reason for minutes in a single span, so mtime goes stale
// mid-turn and the idle threshold alone false-kicks a busy agent off its task
// (DIVE-15, residual of customer bug 5dive-exact-swallow). The turn *boundary* is
// logged, though: grok emits a `turn_started` event when a turn begins and
// `turn_ended` when it finishes (events.jsonl under the session dir). So an OPEN
// turn — the most recent of those two markers being `turn_started` — means a turn
// is in progress no matter how long it has been silent. Trust is capped at
// TURN_MAX_MS: a turn that logged its start but never its end (a hard wedge mid
// inference) eventually becomes kickable again rather than wedging the watchdog
// forever. Best-effort — any read/parse failure returns false, leaving the
// newestTurnMtimeMs() + idle-threshold fallback in force.
const TURN_MAX_MS = Math.max(60_000, Math.min(1_800_000,
  Number(process.env.TELEGRAM_TURN_MAX_MS ?? 900_000)))
function turnInFlight(): boolean {
  const OPEN = 'turn_started', CLOSE = 'turn_ended'
  try {
    const cp = require('child_process')
    const out: string = cp.execFileSync('find',
      [GROK_SESSIONS_DIR, '-type', 'f', '-name', 'events.jsonl', '-printf', '%T@\\t%p\\n'],
      { timeout: 4_000, encoding: 'utf8' })
    let newest = '', newestT = 0
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t'); if (tab < 0) continue
      const t = Number(line.slice(0, tab))
      if (t > newestT) { newestT = t; newest = line.slice(tab + 1) }
    }
    if (!newest) return false
    // Scan the tail newest-first for the last turn boundary. A generous slice so a
    // turn with many tool-call records before a long final reasoning span is still
    // covered without reading the whole (possibly large) log.
    const buf = readFileSync(newest, 'utf8')
    const lines = (buf.length > 262_144 ? buf.slice(-262_144) : buf).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim(); if (!l) continue
      let rec: any
      try { rec = JSON.parse(l) } catch { continue }
      if (rec?.type === CLOSE) return false
      if (rec?.type === OPEN) {
        // Only a turn that began within THIS server's lifetime is genuinely in
        // flight. A turn_started left open by a previous session — e.g. a rough
        // restart (the nightly cron timeout-kill) that killed the agent mid-turn
        // without logging turn_ended — is stale; ignoring it keeps cold-start
        // re-arm working. TURN_MAX_MS additionally bounds a turn that started this
        // session but then wedged. Unparseable ts → don't block (allow the kick).
        const ts = Date.parse(rec.ts ?? rec.timestamp ?? '')
        if (!Number.isFinite(ts) || ts < SERVER_STARTED_AT || Date.now() - ts > TURN_MAX_MS) return false
        return true
      }
    }
  } catch { /* fall through */ }
  return false
}

function startRearmWatchdog(): void {
  if (REARM_DISABLED) return
  if (agentName() === 'unknown') return
  const timer = setInterval(() => {
    // Parked in wait_for_message → loop is armed and healthy.
    if (waiters.length > 0) { rearmKicks = 0; clearStallAlert(); return }
    // DIVE-165: a re-arm exists ONLY to hand the agent a message it's currently
    // out of the loop to receive. With nothing queued there is nothing to
    // deliver, so kicking an idle agent here just forces an empty model turn
    // (wait_for_message → times out → turn ends → kicked again) — the 24/7 idle
    // quota burn. Skip when the inbox is empty; the kick fires the moment a real
    // inbound lands with no waiter parked (enqueueInbound pushes to inboxQueue).
    // Stall state is left untouched: during a genuine wedge the undelivered
    // message keeps the queue non-empty, so escalation still works.
    if (inboxQueue.length === 0) return
    const now = Date.now()
    // Liveness = the most recent of a Telegram-MCP call OR a real agent turn.
    // markActivity() only fires on Telegram tool calls, so an agent heads-down
    // on a task (shell/edits/`5dive task start`) leaves lastServerActivity stale
    // and would be wrongly kicked back into wait_for_message, abandoning the
    // task (customer bug 5dive-exact-swallow). Only pay for the turn-activity
    // stat once the cheap signal already looks stale.
    let idle = now - lastServerActivity
    if (idle >= REARM_IDLE_MS) {
      // A turn genuinely in flight (incl. a multi-minute silent reasoning span
      // that writes nothing, so mtime alone goes stale) must NEVER be kicked,
      // regardless of elapsed time — the real fix for DIVE-15. The agent is
      // provably alive, so also reset the kick counter and clear any stall alert.
      if (turnInFlight()) { rearmKicks = 0; clearStallAlert(); return }
      const lastTurn = newestTurnMtimeMs()
      if (lastTurn > 0) idle = Math.min(idle, now - lastTurn)
    }
    if (idle < REARM_IDLE_MS) return
    // Stalled out of the loop. Back off on repeated kicks (1×,2×,4×…cap 8×) so a
    // genuinely wedged session isn't spammed; a successful re-arm resets the count.
    const backoff = Math.min(8, 2 ** rearmKicks)
    if (idle < REARM_IDLE_MS * backoff) return
    process.stderr.write(`telegram-grok: listen loop idle ${Math.round(idle / 1000)}s, re-arming (kick #${rearmKicks + 1})\n`)
    kickListenLoop()
    rearmKicks += 1
    lastServerActivity = now  // reset clock; wait before the next kick
    // Repeated kicks aren't reviving the loop → a quota/auth/wedge stall the
    // watchdog can't fix on its own. Tell the owner once (best-effort, deduped).
    if (!STALL_ALERT_DISABLED && rearmKicks >= STALL_ESCALATE_AFTER) sendStallAlert()
  }, REARM_CHECK_MS)
  timer.unref?.()
}

// ============================================================================
// Boot
// ============================================================================

// Stop cleanly AND exit. bot.stop() aborts the in-flight getUpdates long-poll
// so the next poller doesn't 409-conflict on the single-consumer token — but
// the MCP StdioServerTransport keeps stdin (and the event loop) alive, so the
// process won't exit on its own. Without an explicit exit, systemd waits the
// full TimeoutStopSec then SIGKILLs, and each create-flow restart burns that
// window before the bridge answers (the ~2-3min dead window). Force exit on a
// short deadline too, in case bot.stop() can't settle mid-abort.
let shuttingDownExit = false
function shutdown() {
  if (shuttingDownExit) return
  shuttingDownExit = true
  shuttingDown = true
  try {
    // Only the active poller owns these files — never clear an incumbent's.
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) {
      unlinkSync(PID_FILE)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      try { unlinkSync(HEARTBEAT_FILE) } catch {}
    }
  } catch {}
  const deadline = setTimeout(() => process.exit(0), 2000)
  deadline.unref?.()
  bot.stop().catch(() => {}).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

// DIVE-3752: signals and stdin EOF are not sufficient. When the parent chain
// (`claude` → `bun run` → us) is severed, neither fires reliably — but POSIX
// reparents us, so the ppid clause in ./lifecycle.ts catches it. No fork had
// that clause; only `plugins/telegram` did.
installLifecycle({ channel: 'telegram-grok', stateDir: STATE_DIR, cleanup: shutdown })

// DIVE-1251: exit when our MCP parent (the grok/TUI session) disconnects. On
// /clear, the TUI RE-INITS its MCP servers — it disconnects this server.ts and
// spawns a fresh one — so our stdin hits EOF. The MCP SDK's StdioServerTransport
// only wires stdin 'data'/'error', never 'end'/'close', so without this the
// orphaned pre-/clear process lingers forever: it keeps holding the getUpdates
// slot (heartbeat still fresh) while the NEW spawn parks in acquireSlot() behind
// it and never exits — one leaked bun process per fresh heartbeat nudge. Exiting
// on EOF frees the slot so the current MCP-connected spawn acquires it.
// shutdown() only unlinks the PID/heartbeat files it actually owns, so a parked
// spawn exiting here can never stomp the incumbent's slot.
const onParentDisconnect = () => {
  if (shuttingDownExit) return
  process.stderr.write('telegram-grok: MCP parent disconnected (stdin EOF) — exiting orphaned bridge\n')
  shutdown()
}
process.stdin.once('end', onParentDisconnect)
process.stdin.once('close', onParentDisconnect)

await mcp.connect(new StdioServerTransport())

startRearmWatchdog()
startAgentInbox()

// DIVE-1503/1558 pinned-banner store I/O. Heuristic state: a lost read/write only
// costs one redundant banner send, never worth failing anything over.
function readBannerStore(): Record<string, BannerState> {
  try {
    const j = JSON.parse(readFileSync(NEEDS_BANNER_FILE, 'utf8')) as Record<string, BannerState>
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}
function writeBannerStore(store: Record<string, BannerState>): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = NEEDS_BANNER_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(store) + '\n', { mode: 0o600 })
    renameSync(tmp, NEEDS_BANNER_FILE)
  } catch {}
}

// DIVE-1503/1558: reconcile the pinned "needs-you" banner in every paired DM
// against the current gate backlog. Pin on the first gate, edit in place as the
// backlog changes, unpin at zero — so a pending gate can never scroll out of
// sight. Runs on a slow timer (below) in personal-bot/polled mode; 5dive-only
// (the inbox verb is a 5dive surface). Never throws into the timer.
// DIVE-2041 — SAY IT OUT LOUD WHEN THE BANNER IS SUPPRESSED FLEET-WIDE.
//
// The single-pinner rule (DIVE-1568) is: only the resolved org coordinator pins
// the needs-you banner, and every other agent unpins any banner it left behind.
// When `5dive task coordinator` resolves to '' — a multi-root chart with nobody
// tagged — "every other agent" is ALL of them, so the else branch below runs
// everywhere, the pin is removed from every paired DM, and the 60s timer
// re-asserts that forever. That is exactly what DIVE-2031 was: 12 pending human
// gates, not one banner anywhere, for days.
//
// Nothing said a word. Every component reported success, because from each
// agent's point of view "I am not the coordinator, so I do not pin" is the
// normal, correct path — the outage and the healthy case are the SAME code path
// with a different fleet-wide precondition, which is why no local check could
// have caught it. Same family as DIVE-1968 / DIVE-1927: the item is filed, the
// filer believes it was surfaced, the human never sees it, and the no-op logs
// nothing.
//
// Rate-limited to one line an hour, and the timestamp RESETS the moment a
// coordinator resolves again, so a fresh outage is loud immediately instead of
// waiting out a window from the last one. This log is the local witness; the
// fleet-level one is `5dive doctor --category=channels`
// (needs-banner-coordinator), which computes the resolution itself rather than
// asking the bot — deliberately, because a bot that is down reports nothing at
// all, and "down" is precisely the state we most need named.
const COORDINATOR_MISS_LOG_INTERVAL_MS = 3_600_000
let coordinatorMissLoggedAt = 0
function noteCoordinatorSuppression(coordinator: string): void {
  if (coordinator !== '') {
    coordinatorMissLoggedAt = 0 // resolved again — next outage logs on its first tick
    return
  }
  const now = Date.now()
  if (coordinatorMissLoggedAt !== 0 && now - coordinatorMissLoggedAt < COORDINATOR_MISS_LOG_INTERVAL_MS) return
  coordinatorMissLoggedAt = now
  console.error(
    '[needs-banner] SUPPRESSED FLEET-WIDE: `5dive task coordinator` resolved to nobody, ' +
      'so no agent pins the needs-you banner and every paired DM has it unpinned — ' +
      'pending human gates are invisible there until this is fixed. ' +
      'Cause: the org chart has no agent tagged coordinator and more than one root. ' +
      "Fix: `5dive org set <agent> --manager=<mgr>` to leave one root, or put 'coordinator' " +
      "in one agent's role. Check: `5dive doctor --category=channels` (DIVE-2031/2041).",
  )
}

let reconcilingBanner = false
// DIVE-1568: the resolved org coordinator (5dive task coordinator, DIVE-333):
// the sole role='coordinator', else the lone org root, else '' (ambiguous/no org
// — nobody pins). Returns null on a lookup error so the caller can skip the tick
// rather than unpin a live banner on a transient blip.
async function read5diveCoordinator(): Promise<string | null> {
  let j: { ok: boolean; data?: any }
  try { j = await run5dive(['task', 'coordinator', '--json']) } catch { return null }
  if (!j?.ok) return null
  return typeof j.data?.coordinator === 'string' ? j.data.coordinator : ''
}

async function reconcileNeedsBanner(): Promise<void> {
  if (reconcilingBanner) return // never overlap: a slow inbox read must not double-run
  reconcilingBanner = true
  try {
    if (!(await read5diveInfo())) return // OSS/standalone host: no inbox verb, no banner
    const dmChats = loadAccess().allowFrom // DM chat_id == user id (see access notes)
    if (dmChats.length === 0) return
    // DIVE-1568: pin on ONE agent only — the resolved org coordinator. Otherwise
    // the founder gets the SAME open-gate reminder pinned across every paired
    // agent's DM (base + forks). A non-coordinator never pins, and unpins any
    // banner it left behind. Empty/ambiguous org resolves to nobody (fail-quiet).
    const coordinator = await read5diveCoordinator()
    if (coordinator === null) return // lookup failed: do nothing, never flicker a live pin
    noteCoordinatorSuppression(coordinator) // DIVE-2041: '' is an OUTAGE, not a quiet no-op
    const iAmCoordinator = coordinator !== '' && coordinator === agentName()
    let summary: NeedSummary
    if (iAmCoordinator) {
      let j: { ok: boolean; data?: any }
      try {
        j = await run5dive(['task', 'inbox', '--json'])
      } catch {
        return // read error — do NOTHING, never unpin a live backlog on a transient blip
      }
      if (!j?.ok || !Array.isArray(j.data?.inbox)) return
      summary = summarizeNeeds(j.data.inbox)
    } else {
      summary = { count: 0, oldestCreatedAt: null } // force unpin of any stale banner
    }
    const now = Date.now()
    const store = readBannerStore()
    let dirty = false
    for (const chat of dmChats) {
      const act = reconcileBanner(store[chat], summary, now)
      try {
        if (act.kind === 'send') {
          const m = await bot.api.sendMessage(chat, act.text)
          await bot.api.pinChatMessage(chat, m.message_id, { disable_notification: true }).catch(() => {})
          store[chat] = { messageId: m.message_id, fingerprint: act.fingerprint }
          dirty = true
        } else if (act.kind === 'edit') {
          await bot.api.editMessageText(chat, act.messageId, act.text)
          store[chat] = { messageId: act.messageId, fingerprint: act.fingerprint }
          dirty = true
        } else if (act.kind === 'unpin') {
          await bot.api.unpinChatMessage(chat, act.messageId).catch(() => {})
          await bot.api.editMessageText(chat, act.messageId, act.clearText).catch(() => {})
          delete store[chat]
          dirty = true
        }
      } catch (err) {
        // If the pinned message is gone (user deleted it), forget it so the next
        // tick re-sends a fresh pin. Other errors are transient — retry next tick.
        const msg = String((err as { description?: unknown })?.description ?? err)
        if (/message to edit not found|message can't be edited|MESSAGE_ID_INVALID|to unpin not found/i.test(msg)) {
          delete store[chat]
          dirty = true
        }
      }
    }
    if (dirty) writeBannerStore(store)
  } catch {
    // heuristic surface — a timer must never crash the bot
  } finally {
    reconcilingBanner = false
  }
}

// DIVE-1503/1558: keep the pinned "needs-you" banner in sync with the gate
// backlog. NOT armed in SEND_ONLY: there one shared team-bot serves several
// agents (DIVE-249), each with its own STATE_DIR + banner store, so a proactive
// per-agent timer would pin several banners into the one owner DM (relay users
// stay on the on-demand /inbox digest — DIVE-1558 decision A). Slow cadence — a
// pin only needs to survive scroll, not tick in real time; first run deferred so
// bot.api + access.json are settled.
if (!SEND_ONLY) {
  setTimeout(() => void reconcileNeedsBanner(), 3000).unref()
  setInterval(() => void reconcileNeedsBanner(), 60_000).unref()
}

if (SEND_ONLY) {
  // DIVE-1087: in SEND_ONLY mode the poll loop is STRUCTURALLY ABSENT — acquireSlot
  // + bot.start() are never invoked, so this bridge can never become a 2nd
  // getUpdates consumer on the shared team token. The listener is the sole poller.
  process.stderr.write(
    `telegram-grok: SEND_ONLY — getUpdates disabled (team-bot member; the shared listener is the sole poller)\n`,
  )
} else void (async () => {
  // DIVE-818 single-flight acquisition: wait until no HEALTHY incumbent holds
  // the slot, then claim it. A transient enumeration spawn (`claude mcp list`)
  // parks here harmlessly and is killed by its parent before it ever polls.
  async function acquireSlot(): Promise<void> {
    for (;;) {
      if (shuttingDown) return
      if (!incumbentHolds()) {
        try {
          const prev = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
          if (prev > 1 && prev !== process.pid && pidAlive(prev)) {
            process.stderr.write(`telegram-grok: reclaiming stale poller pid=${prev}\n`)
            process.kill(prev, 'SIGTERM')
          }
        } catch {}
        writeFileSync(PID_FILE, String(process.pid))
        return
      }
      await new Promise(r => setTimeout(r, HEARTBEAT_MS))
    }
  }
  const bumpHeartbeat = () => { try { writeFileSync(HEARTBEAT_FILE, String(Date.now())) } catch {} }
  await acquireSlot()
  if (shuttingDown) return
  bumpHeartbeat()
  heartbeatTimer = setInterval(bumpHeartbeat, HEARTBEAT_MS)

  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        // Telegram REMEMBERS the last allowed_updates passed to getUpdates and
        // reuses it when omitted. A bridge that ran on this token before may
        // have narrowed it to exclude callback_query — which silently kills the
        // /tasks tappable buttons (messages arrive, taps don't). Pin it
        // explicitly to what we handle.
        allowed_updates: ['message', 'callback_query'],
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-grok: polling as @${info.username}\n`)
          // Register the bot command menu so the TG app surfaces /<cmd>
          // suggestions. Failures are non-fatal — polling continues.
          // Write the menu to BOTH the default scope (groups + fallback) and
          // all_private_chats (DMs). A recycled bot token can carry a stale
          // all_private_chats menu that would otherwise shadow the default one
          // in DMs (Telegram resolves the most specific scope per chat).
          for (const scope of [undefined, { type: 'all_private_chats' as const }]) {
            void bot.api.setMyCommands(MENU_COMMANDS, scope ? { scope } : undefined).catch(err => {
              process.stderr.write(`telegram-grok: setMyCommands(${scope?.type ?? 'default'}) failed: ${err}\n`)
            })
          }
        },
      })
      return
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
      process.stderr.write(
        `telegram-grok: polling error attempt ${attempt}${is409 ? ' (409 Conflict)' : ''}: `
        + `${err instanceof Error ? err.message : String(err)}; retrying in ${wait}ms\n`,
      )
      await new Promise(r => setTimeout(r, wait))
      // DIVE-1239: a 409 means another process is already polling this bot
      // token. Re-run single-flight acquisition so we PARK behind a HEALTHY
      // incumbent (fresh heartbeat) instead of thrashing getUpdates against it
      // forever. Without this, a second server.ts spawned by the heartbeat/
      // task/session re-arm path fights the boot poller indefinitely — two live
      // pollers on one token = permanent 409 = the plugin goes deaf.
      if (is409) await acquireSlot()
    }
  }
})()
