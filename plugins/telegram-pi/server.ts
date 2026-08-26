#!/usr/bin/env bun
/**
 * Telegram bridge for the pi CLI (earendil-works / pi-coding-agent) — DIVE-1202.
 *
 * pi has NO MCP/hooks config surface (DIVE-1198 spike): it is EXTENSION-based
 * and ships a first-class in-process SDK. So this is a long-running RELAY that
 * HOSTS pi directly via `createAgentSession()` — a FOURTH run-model, distinct
 * from claude (`--channels` flag), codex/grok/agy (MCP wired into config), and
 * opencode (HTTP relay over `opencode serve`):
 *
 *   Telegram inbound ──▶ session.prompt(text) ──▶ text_delta stream ──▶ Telegram
 *                        pi `tool_call` extension hook (bash/write/edit)
 *                                             ──▶ 🔐 once/always/reject buttons
 *                                             ──▶ { block:true } on reject
 *
 * SANDBOXED-BY-DEFAULT (DIVE-1198): pi ships no built-in permission system, so
 * this bridge gates every MUTATING tool (bash/write/edit) behind a Telegram
 * approval tap. Read-only tools (read/ls/grep/find) pass silently. The gate is
 * the pi extension API's `tool_call` event, which can block execution — the
 * reason TelePi's TUI-dialog adapter is unnecessary here.
 *
 * Auth: pi's default AuthStorage falls back to the env `*_API_KEY` (DIVE-1200),
 * injected by systemd, so no key wiring is needed here. Model: read from
 * ~/.pi/agent/settings.json defaultProvider/defaultModel (DIVE-1205).
 *
 * State: ~/.pi/channels/telegram/{access.json, .env, bot.pid}
 * Transport + access + command surface reused verbatim from the telegram-opencode
 * fork (access control, pairing, chunking, streaming edit-in-place, permission
 * buttons, and the /status /stop /restart /agents /tasks /task /org /model handlers).
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { TNA_RE, resolveTnaAnswer, OPT_RE, optionChoices, parseOptions, tapEvidenceArgs , yesNoChoice, describeTapError, tapLanding, tapFailureCopy, type TapLanding} from './tna'
// DIVE-2846: aliased so the durable tap-failure record needs no surgery on
// (or collision with) whatever each plugin already imports from 'fs'.
import { appendFileSync as tapAppendFileSync, mkdirSync as tapMkdirSync, statSync as tapStatSync, renameSync as tapRenameSync } from 'fs'
import { summarizeNeeds, reconcileBanner, type BannerState, type NeedSummary } from './banner'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import {
  readFileSync, writeFileSync, mkdirSync, chmodSync, statSync,
  realpathSync, renameSync, existsSync, unlinkSync,
} from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join, sep } from 'path'
import { installLifecycle } from './lifecycle.ts'

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return String(pkg.version ?? 'unknown')
  } catch { return 'unknown' }
})()

// ~/.pi/agent (settings.json, sessions/, auth.json) — pi's config home.
const AGENT_DIR = process.env.PI_AGENT_DIR ?? getAgentDir()
const SETTINGS_FILE = join(AGENT_DIR, 'settings.json')
// Where the agent's tools operate (bash cwd etc.). Exported by 5dive-agent-start.
const PI_PROJECT_DIR = process.env.PI_PROJECT_DIR ?? process.cwd()

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.PI_HOME ?? join(homedir(), '.pi'), 'channels', 'telegram')

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
// DIVE-1503/1558: per-DM pinned "needs-you" banner bookkeeping. Maps a paired DM
// chat id → { messageId, fingerprint } so each reconcile edits the existing pin
// instead of posting a fresh banner (the DIVE-1107 banner-storm lesson).
const NEEDS_BANNER_FILE = join(STATE_DIR, 'needs-banner.json')
const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'bot.pid')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// Lock the token to owner-only, then load it. Real env wins.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `telegram-pi: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

// Liveness beacon for the single getUpdates slot (DIVE-818/DIVE-819, ported to
// pi per DIVE-1241). The active poller bumps this file's mtime every
// HEARTBEAT_MS; a newcomer treats the slot as HELD only while the beacon is
// fresh. Acquisition happens in the poll bootstrap at the bottom of the file.
const HEARTBEAT_FILE = join(STATE_DIR, 'bot.heartbeat')
const HEARTBEAT_MS = 3000
// 3 missed beats — how long a newcomer waits before deciding the incumbent died.
const HEARTBEAT_STALE_MS = 9000

// DIVE-818: a TRANSIENT spawn running this server.ts (an overlapping respawn, or
// a shared-checkout enumeration) used to eagerly SIGTERM whatever PID held the
// slot and claim it, then die — leaving NO poller (channel deaf, relay gone
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
  process.stderr.write(`telegram-pi: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram-pi: uncaught exception: ${err}\n`)
})

// ============================================================================
// Access control  (verbatim from the opencode/grok forks — access/pairing parity)
// ============================================================================

type GroupPolicy = { requireMention: boolean; allowFrom: string[] }
type PendingEntry = {
  senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number
}
type AccessJson = {
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  ackReaction?: string
  textChunkLimit?: number
  dmPolicy?: 'allowlist' | 'static' | 'pairing'
  pending?: Record<string, PendingEntry>
}

const DEFAULT_ACCESS: AccessJson = { allowFrom: [], groups: {}, pending: {} }

function loadAccess(): AccessJson {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<AccessJson>
    return {
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      ackReaction: typeof parsed.ackReaction === 'string' ? parsed.ackReaction : undefined,
      textChunkLimit: typeof parsed.textChunkLimit === 'number'
        ? Math.max(500, Math.min(4096, parsed.textChunkLimit)) : undefined,
      dmPolicy: parsed.dmPolicy === 'static' ? 'static'
        : parsed.dmPolicy === 'pairing' ? 'pairing' : 'allowlist',
      pending: parsed.pending ?? {},
    }
  } catch {
    return { ...DEFAULT_ACCESS, pending: {} }
  }
}

function saveAccess(a: AccessJson): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = ACCESS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, ACCESS_FILE)
  } catch (err) {
    process.stderr.write(`telegram-pi: saveAccess failed: ${err}\n`)
  }
}

function pruneExpired(a: AccessJson): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending ?? {})) {
    if (p.expiresAt < now) { delete a.pending![code]; changed = true }
  }
  return changed
}

function assertInStateDir(path: string) {
  let real: string, stateReal: string
  try { real = realpathSync(path); stateReal = realpathSync(STATE_DIR) } catch { return }
  if (real !== stateReal && !real.startsWith(stateReal + sep)) {
    throw new Error(`refusing to send file outside state dir: ${path}`)
  }
}

type GateResult =
  | { allowed: true; access: AccessJson }
  | { allowed: false }
  | { allowed: false; pair: { code: string; chatId: string; isResend: boolean } }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const chat = ctx.chat, from = ctx.from
  if (!chat || !from) return { allowed: false }
  const chatId = String(chat.id), senderId = String(from.id)

  if (chat.type === 'private') {
    if (access.allowFrom.includes(senderId)) return { allowed: true, access }
    if (access.dmPolicy === 'pairing') {
      if (pruneExpired(access)) saveAccess(access)
      for (const [code, p] of Object.entries(access.pending ?? {})) {
        if (p.senderId === senderId) {
          if ((p.replies ?? 1) >= 2) return { allowed: false }
          p.replies = (p.replies ?? 1) + 1
          saveAccess(access)
          return { allowed: false, pair: { code, chatId, isResend: true } }
        }
      }
      if (Object.keys(access.pending ?? {}).length >= 3) return { allowed: false }
      const code = randomBytes(3).toString('hex')
      const now = Date.now()
      access.pending = access.pending ?? {}
      access.pending[code] = { senderId, chatId, createdAt: now, expiresAt: now + 3600_000, replies: 1 }
      saveAccess(access)
      return { allowed: false, pair: { code, chatId, isResend: false } }
    }
    return { allowed: false }
  }

  const policy = access.groups[chatId]
  if (!policy) return { allowed: false }
  const senderOk = policy.allowFrom.length === 0
    ? access.allowFrom.includes(senderId) : policy.allowFrom.includes(senderId)
  if (!senderOk) return { allowed: false }
  if (policy.requireMention && !isMentioned(ctx)) return { allowed: false }
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
  throw new Error(`chat_id ${chatId} is not on the allowlist`)
}

// ============================================================================
// pi engine — in-process AgentSession per chat + sandboxed-by-default gate
// ============================================================================

// One pi model = ~/.pi/agent/settings.json {defaultProvider, defaultModel}.
// Read for /status and /model; written by /model (and by DIVE-1205 at create).
function currentModel(): { providerID: string; modelID: string } | null {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as any
    if (s?.defaultProvider && s?.defaultModel) return { providerID: String(s.defaultProvider), modelID: String(s.defaultModel) }
  } catch {}
  return null
}
function setModel(provider: string, model: string): void {
  let s: any = {}
  try { s = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) } catch {}
  s.defaultProvider = provider
  s.defaultModel = model
  mkdirSync(AGENT_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + '\n')
}

// Which tools mutate the box and therefore require a human tap. Everything else
// (read/ls/grep/find and read-only custom tools) runs silently. pi has no
// permission system of its own, so this list IS the sandbox boundary.
const MUTATING_TOOLS = new Set(['bash', 'write', 'edit'])

function describeTool(name: string, input: any): string {
  try {
    if (name === 'bash' && typeof input?.command === 'string') return input.command
    if ((name === 'write' || name === 'edit') && typeof input?.path === 'string') return `${name} ${input.path}`
    return JSON.stringify(input ?? {}).slice(0, 300)
  } catch { return name }
}

type PermVerdict = 'once' | 'always' | 'reject'
const pendingToolPerms = new Map<string, { resolve: (v: PermVerdict) => void; chat_id: string; message_id?: number }>()
let permSeq = 0
const PERM_TIMEOUT_MS = 10 * 60 * 1000

// Post 🔐 once/always/reject buttons and resolve when the user taps (or after a
// timeout → reject, so a never-answered gate can't hang the turn forever). Fails
// CLOSED (reject) if the prompt can't even be sent — sandboxed-by-default.
function requestToolApproval(chat_id: string, toolName: string, detail: string): Promise<PermVerdict> {
  const id = String(++permSeq)
  const body = `🔐 pi wants to run *${toolName}*:\n\`${detail.slice(0, 350)}\``
  const kb = new InlineKeyboard()
    .text('✅ once', `piperm:once:${id}`).text('✅ always', `piperm:always:${id}`).text('❌ reject', `piperm:reject:${id}`)
  return new Promise<PermVerdict>(resolve => {
    let settled = false
    const done = (v: PermVerdict) => { if (!settled) { settled = true; pendingToolPerms.delete(id); resolve(v) } }
    bot.api.sendMessage(chat_id, body, { parse_mode: 'Markdown', reply_markup: kb })
      .then(sent => {
        if (settled) return
        pendingToolPerms.set(id, { resolve: done, chat_id, message_id: sent.message_id })
        setTimeout(() => {
          if (!settled) {
            bot.api.sendMessage(chat_id, `⏱️ approval for *${toolName}* timed out — blocked.`, { parse_mode: 'Markdown' }).catch(() => {})
            done('reject')
          }
        }, PERM_TIMEOUT_MS)
      })
      .catch(err => {
        process.stderr.write(`telegram-pi: permission prompt failed (blocking): ${err}\n`)
        done('reject')
      })
  })
}

// The inline extension injected into every per-chat pi session. Its `tool_call`
// hook runs before each tool executes and can block it (pi extension API). We
// close over chat_id + a per-session "always" allowlist so approvals are scoped
// to the conversation they were granted in.
function buildPermExtension(chat_id: string, allowedTools: Set<string>) {
  return (pi: ExtensionAPI) => {
    pi.on('tool_call', async (event: any) => {
      const name = String(event?.toolName ?? '')
      if (!MUTATING_TOOLS.has(name)) return undefined      // read-only → silent pass
      if (allowedTools.has(name)) return undefined          // "always" this session
      const verdict = await requestToolApproval(chat_id, name, describeTool(name, event?.input))
      if (verdict === 'reject') return { block: true, reason: 'Rejected by user via Telegram' }
      if (verdict === 'always') allowedTools.add(name)
      return undefined
    })
  }
}

type ChatEngine = { session: AgentSession; allowedTools: Set<string>; unsub: () => void }
const engines = new Map<string, ChatEngine>()

async function engineForChat(chat_id: string): Promise<ChatEngine> {
  const existing = engines.get(chat_id)
  if (existing) return existing
  const allowedTools = new Set<string>()
  const resourceLoader = new DefaultResourceLoader({
    cwd: PI_PROJECT_DIR,
    agentDir: AGENT_DIR,
    extensionFactories: [buildPermExtension(chat_id, allowedTools)],
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: PI_PROJECT_DIR,
    resourceLoader,
    sessionManager: SessionManager.create(PI_PROJECT_DIR),
  })
  const unsub = session.subscribe((ev: any) => handleSessionEvent(chat_id, ev))
  const engine: ChatEngine = { session, allowedTools, unsub }
  engines.set(chat_id, engine)
  return engine
}

async function disposeEngine(chat_id: string): Promise<void> {
  const e = engines.get(chat_id)
  if (!e) return
  engines.delete(chat_id)
  try { e.unsub?.() } catch {}
  try { await e.session.abort?.() } catch {}
  try { e.session.dispose?.() } catch {}
}

// Extract the last assistant message's text — a fallback for finalize when the
// streamed text_delta accumulation came up empty.
function lastAssistantText(session: AgentSession): string {
  try {
    const msgs: any[] = (session as any).messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.role !== 'assistant') continue
      const c = m.content
      if (typeof c === 'string') return c.trim()
      if (Array.isArray(c)) {
        return c.filter((x: any) => x?.type === 'text' && typeof x.text === 'string').map((x: any) => x.text).join('').trim()
      }
      return ''
    }
  } catch {}
  return ''
}

// pi AgentSession event → live Telegram stream. Only text_delta feeds the reply
// (thinking_delta / tool events are excluded, matching the CLI's own rendering).
function handleSessionEvent(chat_id: string, event: any): void {
  if (event?.type !== 'message_update') return
  const ame = event.assistantMessageEvent
  if (ame?.type !== 'text_delta' || typeof ame.delta !== 'string') return
  const s = streams.get(chat_id)
  if (!s) return
  s.text += ame.delta
  scheduleFlush(s)
}

// ============================================================================
// Bot
// ============================================================================

const bot = new Bot(TOKEN)
// DIVE-1674: never deliver a bare 'undefined'/empty payload to the user.
// This is the single transport choke point every send flows through, so a
// guard here kills the symptom regardless of which caller passed undefined
// (or a template that stringified to the literal string 'undefined').
bot.api.config.use((prev, method, payload, signal) => {
  if (method === 'sendMessage' || method === 'editMessageText') {
    const p = payload as { text?: string }
    if (p.text == null || p.text.trim() === '' || p.text.trim() === 'undefined') {
      throw new Error(`telegram ${method}: refusing to send empty/undefined text`)
    }
  }
  return prev(method, payload, signal)
})
let botUsername = ''
let shuttingDown = false

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

const TYPING_INTERVAL_MS = 4_000
const TYPING_CEILING_MS = 5 * 60 * 1000
const typingLoops = new Map<string, ReturnType<typeof setInterval>>()
const typingCeilings = new Map<string, ReturnType<typeof setTimeout>>()
function startTypingLoop(chat_id: string) {
  stopTypingLoop(chat_id)
  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  typingLoops.set(chat_id, setInterval(() => {
    void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  }, TYPING_INTERVAL_MS))
  typingCeilings.set(chat_id, setTimeout(() => stopTypingLoop(chat_id), TYPING_CEILING_MS))
}
function stopTypingLoop(chat_id: string) {
  const h = typingLoops.get(chat_id); if (h) { clearInterval(h); typingLoops.delete(chat_id) }
  const c = typingCeilings.get(chat_id); if (c) { clearTimeout(c); typingCeilings.delete(chat_id) }
}

const TG_MAX_MESSAGE_CHARS = 4000
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

// DIVE-341: auto-render a Yes/No inline keyboard when an assistant reply ends in
// a single yes/no question. Conservative — only when there's exactly one '?' and
// the trailing question isn't an "A or B?" choice. Opt-out: a trailing
// `<!-- no-buttons -->` (or `<!-- no-yn -->`), stripped either way.
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

// DIVE-708/717: render one tappable button per option when a reply presents a
// lettered/numbered choice list. Detection is optionChoices() in tna.ts; here we
// build the keyboard. callback_data is `opt:<index>`; the label is re-resolved
// from the tapped message at tap time. Shares the YN opt-out marker.
const OPT_BTN_MAX = 56
function optionButtons(text: string): { keyboard?: InlineKeyboard; labels?: string[] } {
  if (YN_SUPPRESS.test(text)) return {}
  const opts = optionChoices(text)
  if (!opts.length) return {}
  const kb = new InlineKeyboard()
  opts.forEach((o, i) => {
    const label = o.label.length > OPT_BTN_MAX ? o.label.slice(0, OPT_BTN_MAX - 1).trimEnd() + '…' : o.label
    kb.text(`${o.marker.toUpperCase()}) ${label}`, `opt:${i}`).row()
  })
  return { keyboard: kb, labels: opts.map(o => o.label) }
}

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

async function sendReply(chat_id: string, text: string, opts?: { reply_to?: number; thread?: number }): Promise<void> {
  const limit = loadAccess().textChunkLimit ?? TG_MAX_MESSAGE_CHARS
  const chunks = chunkForTelegram(text || '(empty reply)', limit)
  for (let i = 0; i < chunks.length; i++) {
    await bot.api.sendMessage(chat_id, chunks[i]!, {
      ...(i === 0 && opts?.reply_to != null ? { reply_parameters: { message_id: opts.reply_to } } : {}),
      ...(opts?.thread != null ? { message_thread_id: opts.thread } : {}),
    }).catch((err: any) => process.stderr.write(`telegram-pi: sendReply failed: ${err?.message}\n`))
  }
}

let lastInboundTs: string | null = null

// ============================================================================
// Progressive streaming relay
// ============================================================================
//
// pi streams tokens as `message_update` events whose assistantMessageEvent is a
// `text_delta` (handleSessionEvent appends the delta into s.text). We edit a
// Telegram message in place as it grows, so the user watches the reply form.
// The authoritative final text is set from session.prompt()'s resolution in
// runPrompt via finalizeStream. Streams are keyed by chat_id (one pi session
// per chat).

const EDIT_THROTTLE_MS = 1100

type StreamState = {
  chat_id: string
  reply_to?: number
  thread?: number
  text: string                     // accumulated assistant text
  msgIds: number[]                 // telegram message id per chunk
  sentChunks: string[]             // last text set on each chunk's message
  lastEditAt: number
  timer: ReturnType<typeof setTimeout> | null
  started: boolean
  finalized: boolean
  finalText: string | null
  flushing: boolean
  dirty: boolean
}

const streams = new Map<string, StreamState>()   // chat_id -> stream

function newStream(chat_id: string, reply_to?: number, thread?: number): StreamState {
  const s: StreamState = {
    chat_id, reply_to, thread, text: '',
    msgIds: [], sentChunks: [],
    lastEditAt: 0, timer: null, started: false, finalized: false,
    finalText: null, flushing: false, dirty: false,
  }
  streams.set(chat_id, s)
  return s
}

function targetText(s: StreamState): string {
  return s.finalText ?? s.text.trim()
}

function scheduleFlush(s: StreamState): void {
  if (s.timer || s.finalized) return
  const wait = Math.max(0, EDIT_THROTTLE_MS - (Date.now() - s.lastEditAt))
  s.timer = setTimeout(() => { s.timer = null; void flushStream(s) }, wait)
}

// Render the current target text into one-or-more Telegram messages, editing in
// place. chunkForTelegram splits greedily from the front, so as text grows by
// appending only the tail chunk changes; sentChunks[] dedup skips no-op edits.
async function flushStream(s: StreamState): Promise<void> {
  if (s.flushing) { s.dirty = true; return }
  s.flushing = true
  try {
    const full = targetText(s)
    if (!full && !s.started) return
    const limit = loadAccess().textChunkLimit ?? TG_MAX_MESSAGE_CHARS
    const chunks = chunkForTelegram(full || '…', limit)
    s.lastEditAt = Date.now()
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      if (i < s.msgIds.length) {
        if (s.sentChunks[i] === chunk) continue
        try {
          await bot.api.editMessageText(s.chat_id, s.msgIds[i]!, chunk)
        } catch (err: any) {
          const d = String(err?.description ?? err?.message ?? err)
          if (!/not modified/i.test(d)) process.stderr.write(`telegram-pi: stream edit failed: ${d}\n`)
        }
        s.sentChunks[i] = chunk
      } else {
        try {
          const sent = await bot.api.sendMessage(s.chat_id, chunk, {
            ...(i === 0 && s.reply_to != null ? { reply_parameters: { message_id: s.reply_to } } : {}),
            ...(s.thread != null ? { message_thread_id: s.thread } : {}),
          })
          s.msgIds[i] = sent.message_id
          s.sentChunks[i] = chunk
          if (!s.started) { s.started = true; stopTypingLoop(s.chat_id) }
        } catch (err) {
          process.stderr.write(`telegram-pi: stream send failed: ${err}\n`)
        }
      }
    }
  } finally {
    s.flushing = false
    if (s.dirty) { s.dirty = false; void flushStream(s) }
  }
}

// Lock in the authoritative text and flush one last time, so the final Telegram
// state always matches pi's response even if some stream events were missed.
async function finalizeStream(s: StreamState, finalText: string): Promise<void> {
  const text = finalText.trim() ? finalText : (s.text.trim() || '(pi returned no text)')
  // DIVE-341: render the authoritative text minus any opt-out marker, then attach
  // the Yes/No keyboard to the LAST chunk's message after the final flush.
  const { stripped, keyboard: ynKeyboard } = yesNoButtons(text)
  s.finalText = stripped
  s.finalized = true
  if (s.timer) { clearTimeout(s.timer); s.timer = null }
  await flushStream(s)
  if (s.dirty) { await new Promise(r => setTimeout(r, 50)); await flushStream(s) }
  // DIVE-708/717: a choice-list keyboard takes precedence over Yes/No, but only
  // when the reply landed as a single chunk (the tap resolves from that message).
  const optRes = s.msgIds.length === 1 ? optionButtons(text) : {}
  const keyboard = optRes.keyboard ?? ynKeyboard
  if (keyboard && s.msgIds.length) {
    const lastId = s.msgIds[s.msgIds.length - 1]!
    await bot.api.editMessageReplyMarkup(s.chat_id, lastId, { reply_markup: keyboard })
      .catch((err: any) => process.stderr.write(`telegram-pi: keyboard attach failed: ${err?.message}\n`))
    if (optRes.keyboard && optRes.labels) rememberOptions(lastId, optRes.labels)
  }
  streams.delete(s.chat_id)
  stopTypingLoop(s.chat_id)
}

function dropStream(chat_id: string): void {
  const s = streams.get(chat_id)
  if (s?.timer) { clearTimeout(s.timer); s.timer = null }
  streams.delete(chat_id)
}

const BOT_COMMANDS: Array<{ command: string; description: string; menuHidden?: boolean }> = [
  { command: 'help',    description: 'Show commands' },
  { command: 'status',  description: 'Model, session' },
  { command: 'stop',    description: 'Abort current turn' },
  { command: 'restart', description: 'Restart the agent' },
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

// /team is a hidden alias: still dispatched and shown in /help, but kept off the
// BotFather command-menu picker.
const MENU_COMMANDS = BOT_COMMANDS.filter(c => !c.menuHidden)

function helpText(): string {
  return [
    `*telegram-pi* v${PLUGIN_VERSION} — bridge for the pi CLI`,
    ``, `commands:`,
    ...BOT_COMMANDS.map(c => `  /${c.command} — ${c.description}`),
    ``,
    `everything else you send is forwarded to pi as a prompt.`,
    `mutating tools (bash/write/edit) ask for a 🔐 tap before they run.`,
    `docs: github.com/5dive-ai/5dive-plugins/tree/main/plugins/telegram-pi`,
  ].join('\n')
}

const SERVER_STARTED_AT = Date.now()

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

function execText(cmd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    require('child_process').execFile(cmd, args, { timeout: 4000 }, (err: any, out: string) => {
      resolve(err ? null : (String(out || '').split('\n')[0].trim() || null))
    })
  })
}

function fmtVer(raw: string): string {
  const m = raw.match(/\d+\.\d+(?:\.\d+)?[\w.+-]*/)
  return m ? `v${m[0]}` : raw
}

function agentName(): string {
  try {
    const user = require('os').userInfo().username as string
    if (user.startsWith('agent-')) return user.slice('agent-'.length)
  } catch {}
  return 'unknown'
}

function run5dive(args: string[], timeout = 8000): Promise<{ ok: boolean; data?: any; error?: { message?: string } }> {
  return new Promise((resolve, reject) => {
    require('child_process').execFile('sudo', ['-n', '5dive', ...args], { timeout },
      (err: any, stdout: string) => {
        if (err && !stdout) return reject(err)
        try { resolve(JSON.parse(stdout)) } catch (e) { reject(e) }
      })
  })
}

async function read5diveInfo(): Promise<{ cliVersion?: string; authProfile?: string; model?: string } | null> {
  try {
    const j = await run5dive(['agent', 'info', agentName(), '--json'])
    if (!j.ok || !j.data) return null
    return { cliVersion: j.data.cliVersion ?? undefined, authProfile: j.data.authProfile ?? undefined, model: j.data.model ?? undefined }
  } catch { return null }
}

function agentUptimeMs(): number {
  const name = agentName()
  if (name !== 'unknown') {
    try {
      const out = require('child_process').execFileSync('tmux',
        ['display-message', '-t', `agent-${name}`, '-p', '#{session_created}'], { timeout: 3000 }).toString().trim()
      const created = Number(out) * 1000
      if (created > 0) return Date.now() - created
    } catch {}
  }
  return Date.now() - SERVER_STARTED_AT
}

async function statusText(senderName: string): Promise<string> {
  const lines = [`Paired as ${senderName}.`, '']
  lines.push(`status: 🟢 pi (in-process SDK)`)
  const mdl = currentModel()
  lines.push(`model: ${mdl ? `${mdl.providerID}/${mdl.modelID}` : '(pi default)'}`)
  lines.push(`active chats: ${engines.size}`)
  lines.push(`uptime: ${formatDuration(agentUptimeMs())}`)
  const info = await read5diveInfo()
  if (info?.cliVersion) {
    const v0 = info.cliVersion.replace(/^[A-Za-z][A-Za-z0-9-]*\s+/, '').trim() || info.cliVersion
    lines.push(`pi: ${/^\d/.test(v0) ? 'v' + v0 : v0}`)
  }
  lines.push(`plugin: v${PLUGIN_VERSION}`)
  const fiveVer = await execText('sudo', ['-n', '5dive', '--version'])
  if (fiveVer) lines.push(`5dive: ${fmtVer(fiveVer)}`)
  lines.push(`account: ${info?.authProfile || 'default'}`)
  return lines.join('\n')
}

async function listAgents(): Promise<string> {
  return new Promise(resolve => {
    require('child_process').execFile('sudo', ['-n', '5dive', 'agent', 'list', '--json'], { timeout: 5000 },
      (err: any, stdout: string) => {
        if (err) return resolve(`⚠️ \`5dive agent list\` failed: ${err.message}`)
        try {
          const env = JSON.parse(stdout) as { ok: boolean; data: any[] }
          if (!env.ok || !Array.isArray(env.data) || env.data.length === 0) return resolve('no agents found')
          const self = agentName()
          const lines = [`*agents on this host* (${env.data.length}):`, '']
          for (const a of env.data) {
            const me = a.name === self ? ' ← me' : ''
            const dot = a.active === 'active' ? '🟢' : '⚪'
            lines.push(`${dot} \`${a.name}\` — ${a.type}${a.channels && a.channels !== 'none' ? ` · ${a.channels}` : ''}${me}`)
          }
          resolve(lines.join('\n'))
        } catch (e) { resolve(`⚠️ couldn't parse \`5dive agent list\`: ${e}`) }
      })
  })
}

// --- /tasks: tappable list + single-task detail (host-shared queue) ---
function taskAssignedToMe(assignee: string | null | undefined): boolean {
  if (!assignee) return false
  const me = agentName()
  if (!me || me === 'unknown') return false
  return assignee === me || assignee === `agent-${me}`
}

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
  // DIVE-3267: this used to read `t.need_type`. In the other forks a comment above it
  // called that presence "a clean needs-a-human flag"; here it was bare, which is the
  // same claim with nothing to disagree with. It is not true either way: need_type
  // present means HAS AN UNANSWERED GATE, and a gate routed to an agent seat is one of
  // those. So "Needs you" listed every open gate in the fleet as an act-on-me row —
  // the same defect DIVE-3224 fixed one command over in /inbox.
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
  let keyboard: InlineKeyboard | undefined
  if (t.status !== 'done' && t.status !== 'cancelled') {
    keyboard = new InlineKeyboard()
    if (t.assignee) keyboard.text('▶️ Do now', `donow:${t.id}`)
    keyboard.text('🔺 Escalate', `esc:${t.id}`)
    keyboard.row()
    keyboard.text('✅ Done', `tdone:${t.id}`).text('🚫 Cancel', `tcancel:${t.id}`)
  }
  return { text: lines.join('\n'), keyboard }
}

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
  } catch (err) { return `⚠️ Failed to add task: ${err instanceof Error ? err.message : String(err)}` }
}

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
  } catch (err) { return `⚠️ Failed to read org chart: ${err instanceof Error ? err.message : String(err)}` }
}

async function restartAgent(name: string, ackUpdateId?: number): Promise<void> {
  if (name === 'unknown') return
  if (ackUpdateId != null) {
    try { await bot.api.getUpdates({ offset: ackUpdateId + 1, limit: 1, timeout: 0 }) } catch {}
  }
  await new Promise<void>(resolve => {
    require('child_process').execFile('sudo', ['-n', '5dive', 'agent', 'restart', name], { timeout: 10_000 }, () => resolve())
  })
}

// /model — show or switch the pi model. Written to ~/.pi/agent/settings.json
// (defaultProvider/defaultModel), then the chat's engine is disposed so the next
// message rebuilds the session onto the new model (pi reads model at session start).
async function handleModelCommand(chat_id: string, arg: string): Promise<string> {
  const name = arg.trim()
  if (!name) {
    const cur = currentModel()
    return `*model* — pi\n\ncurrent: \`${cur ? `${cur.providerID}/${cur.modelID}` : '(pi default)'}\`\n\n`
      + `Switch with \`/model <provider>/<modelId>\` (e.g. \`anthropic/claude-sonnet-5\`) — applies to your next message.`
  }
  const slash = name.indexOf('/')
  if (!/^[A-Za-z0-9._:\/-]+$/.test(name) || slash <= 0) {
    return `⚠️ \`${name}\` isn't a \`<provider>/<modelId>\` id.`
  }
  const provider = name.slice(0, slash), model = name.slice(slash + 1)
  try { setModel(provider, model) }
  catch (e) { return `⚠️ couldn't save model: ${e instanceof Error ? e.message : String(e)}` }
  await disposeEngine(chat_id)
  return `🔁 model → \`${provider}/${model}\` (applies to your next message)`
}

async function abortChat(chat_id: string): Promise<string> {
  const e = engines.get(chat_id)
  if (!e) return 'Nothing running for this chat.'
  try { await e.session.abort() } catch (err) {
    return `⚠️ abort failed: ${err instanceof Error ? err.message : String(err)}`
  }
  dropStream(chat_id)
  stopTypingLoop(chat_id)
  return '✋ aborted the current turn.'
}

// ── /login: pi authenticates via env-injected API keys (DIVE-1200), not a device
// flow, so there's nothing to self-serve here — point at the dashboard/CLI. ─────
function loginHint(): string {
  return 'pi authenticates via an API key set at create time (or on the dashboard). '
    + 'There is no device-login flow. To change providers/keys use the 5dive dashboard '
    + 'or `5dive agent auth set pi --provider=<p> --api-key=<key>`, then /restart.'
}

// Returns true if handled as a slash command (don't forward to pi).
async function handleSlashCommand(ctx: Context, text: string): Promise<boolean> {
  const m = text.match(/^\/([a-z][a-z0-9_]*)(?:@([\w]+))?(?:\s|$)/i)
  if (!m) return false
  const cmd = m[1]!.toLowerCase()
  const targetBot = m[2]?.toLowerCase()
  if (targetBot && targetBot !== botUsername.toLowerCase()) return false
  if (!BOT_COMMANDS.some(c => c.command === cmd)) return false

  const chat_id = String(ctx.chat!.id)
  const reply_to = ctx.message?.message_id
  const updateId = ctx.update.update_id
  const cmdArg = text.slice(m[0]!.length).trim()
  const md = (t: string) => bot.api.sendMessage(chat_id, t, {
    parse_mode: 'Markdown', ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
  })

  try {
    switch (cmd) {
      case 'help': await md(helpText()); return true
      case 'status': {
        const sender = ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from?.id ?? 'you')
        await bot.api.sendMessage(chat_id, await statusText(sender),
          reply_to ? { reply_parameters: { message_id: reply_to } } : undefined)
        return true
      }
      case 'ping':
        await bot.api.sendMessage(chat_id, `pong — telegram-pi v${PLUGIN_VERSION}`,
          reply_to ? { reply_parameters: { message_id: reply_to } } : undefined)
        return true
      case 'stop': await md(await abortChat(chat_id)); return true
      case 'restart': {
        const name = agentName()
        await bot.api.sendMessage(chat_id, `restarting agent \`${name}\` — back in ~2s`, {
          parse_mode: 'Markdown', ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        }).catch(() => {})
        await restartAgent(name, updateId)
        return true
      }
      case 'model': await md(await handleModelCommand(chat_id, cmdArg)); return true
      case 'team':
      case 'agents': await md(await listAgents()); return true
      case 'tasks': {
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
      case 'task': await md(await addTask(cmdArg, ctx.from?.username || 'telegram')); return true
      case 'org': await md(await orgTree(cmdArg)); return true
      case 'start':
        await md(
          'This bot bridges Telegram to your pi session.\n\n' +
          'Already paired? Just type. Messages here reach the pi session, and any ' +
          'command that writes to the box (bash/write/edit) asks you to approve it first.\n\n' +
          'Not paired yet? Send me a message to get a pairing code, then have the ' +
          'server operator run `5dive agent pair <agent> --code=<code>`. You can also ' +
          'be added from the 5dive dashboard (Telegram access).\n\n' +
          'Try `/help` for the full command list.')
        return true
    }
  } catch (err) {
    process.stderr.write(`telegram-pi: /${cmd} reply failed: ${err}\n`)
  }
  return true
}

// ============================================================================
// Inbound → pi prompt
// ============================================================================

async function ingest(ctx: Context, text: string): Promise<void> {
  const verdict = gate(ctx)
  if (!verdict.allowed) {
    if ('pair' in verdict && verdict.pair) {
      const { code, chatId, isResend } = verdict.pair
      const lead = isResend ? 'Still pending' : 'Pairing required'
      await bot.api.sendMessage(chatId,
        `${lead} — give this code to the 5dive operator to approve you:\n\n` +
        `\`${code}\`\n\n` + `They run: 5dive agent pair <agent> --code=${code}`,
        { parse_mode: 'Markdown' }).catch(() => {})
    }
    return
  }
  if (await handleSlashCommand(ctx, text)) return

  lastInboundTs = new Date().toISOString()
  const chat = ctx.chat!
  const chat_id = String(chat.id)
  const reply_to = ctx.message?.message_id
  const threadId = ctx.message?.message_thread_id

  const ack = verdict.access.ackReaction
  if (ack && reply_to != null) {
    void bot.api.setMessageReaction(chat_id, reply_to, [{ type: 'emoji', emoji: ack as ReactionTypeEmoji['emoji'] }]).catch(() => {})
  }

  await runPrompt(chat_id, text, { reply_to, thread: threadId })
}

// Forward one prompt to the chat's pi session and relay the streamed reply. Split
// out of ingest() so a synthetic prompt (a Yes/No or option button tap) rides the
// same session/stream/finalize path a typed message takes.
async function runPrompt(chat_id: string, text: string, opts: { reply_to?: number; thread?: number }): Promise<void> {
  const { reply_to, thread } = opts
  startTypingLoop(chat_id)
  let engine: ChatEngine | undefined
  try {
    engine = await engineForChat(chat_id)
    const stream = newStream(chat_id, reply_to, thread)
    // Resolves when the turn ends. A mutating tool mid-turn blocks on a Telegram
    // tap (see buildPermExtension) — that tap is a separate update, which is why
    // runIngest fires this un-awaited so the grammy update loop stays free.
    await engine.session.prompt(text)
    const finalText = stream.text.trim() || lastAssistantText(engine.session)
    await finalizeStream(stream, finalText)
  } catch (err) {
    dropStream(chat_id)
    stopTypingLoop(chat_id)
    await sendReply(chat_id, `⚠️ pi error: ${err instanceof Error ? err.message : String(err)}`, { reply_to, thread })
  }
}

// IMPORTANT: do NOT await ingest() here. grammy processes updates sequentially —
// it won't fetch the next update until the current handler resolves. A pi turn
// blocks until it ends, and a turn that hits a permission gate can't end until
// the user TAPS a button — but that tap is the next update, which can't be
// processed while we're still awaiting the turn. Awaiting would deadlock. Firing
// the turn async keeps the update loop free so callbacks/new messages flow.
const runIngest = (ctx: Context, text: string) =>
  void ingest(ctx, text).catch(err => process.stderr.write(`telegram-pi: ingest failed: ${err}\n`))

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
// against access.json allowFrom before sending. This fork is polling-only (no
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

// /task_<id> — tappable deep link from the /tasks list. Registered BEFORE the
// message bridge so the tap opens the detail and is NOT forwarded as a prompt.
bot.hears(/^\/task_(\d+)\b/, async ctx => {
  const senderId = String(ctx.from?.id ?? '')
  if (!loadAccess().allowFrom.includes(senderId)) return
  const m = /^\/task_(\d+)\b/.exec(ctx.message?.text ?? '')
  if (!m) return
  const detail = await buildTaskDetail(Number(m[1]))
  await ctx.reply(detail.text, detail.keyboard ? { reply_markup: detail.keyboard } : undefined)
})

bot.on('message:text', ctx => { runIngest(ctx, ctx.message.text) })
bot.on('message:photo', ctx => {
  runIngest(ctx, ctx.message.caption ?? '(photo — image input not yet wired)')
})
bot.on('message:document', ctx => {
  runIngest(ctx, ctx.message.caption ?? `(document: ${ctx.message.document.file_name ?? 'file'} — file input not yet wired)`)
})

bot.catch(err => { process.stderr.write(`telegram-pi: handler error (polling continues): ${err.error}\n`) })

// ============================================================================
// Callback routing — buttons (perm gate / yn / options / task actions)
// ============================================================================

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

  // 🔐 tool-permission tap (piperm:<verdict>:<id>) — resolves the pending
  // requestToolApproval() promise, unblocking (or blocking) the pi tool call.
  const pm = data.match(/^piperm:(once|always|reject):(.+)$/)
  if (pm) {
    const verdict = pm[1] as PermVerdict
    const id = pm[2]!
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const pending = pendingToolPerms.get(id)
    pendingToolPerms.delete(id)
    if (pending) pending.resolve(verdict)
    await ctx.answerCallbackQuery({ text: verdict === 'reject' ? '❌ rejected' : `✅ ${verdict}` }).catch(() => {})
    if (pending?.message_id != null) {
      const who = ctx.from.username ?? ctx.from.first_name ?? senderId
      await bot.api.editMessageText(pending.chat_id, pending.message_id,
        `${verdict === 'reject' ? '❌ rejected' : `✅ allowed (${verdict})`} by ${who}`, { reply_markup: undefined }).catch(() => {})
    }
    return
  }

  // DIVE-341: Yes/No question tap — inject 'yes'/'no' through the same prompt path.
  const ynM = /^yn:(yes|no)$/.exec(data)
  if (ynM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const value = ynM[1]!
    const msg = ctx.callbackQuery.message
    const chat_id = String(msg?.chat.id ?? ctx.from.id)
    const thread = msg && 'is_topic_message' in msg && msg.is_topic_message && msg.message_thread_id != null
      ? msg.message_thread_id : undefined
    void runPrompt(chat_id, value, { thread }).catch(err =>
      process.stderr.write(`telegram-pi: yn ingest failed: ${err}\n`))
    await ctx.editMessageReplyMarkup().catch(() => {})
    await ctx.answerCallbackQuery({ text: value === 'yes' ? '👍 Yes' : '👎 No' }).catch(() => {})
    return
  }

  // DIVE-708/717: choice-list button tap (opt:<index>).
  const optM = OPT_RE.exec(data)
  if (optM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const idx = Number(optM[1])
    const msg = ctx.callbackQuery.message
    const labels = (msg ? optionLabelsByMsg.get(msg.message_id) : undefined)
      ?? (msg && 'text' in msg && typeof msg.text === 'string' ? parseOptions(msg.text).map(o => o.label) : [])
    const value = labels[idx]
    if (value == null) {
      await ctx.answerCallbackQuery({ text: 'That option is no longer available.' }).catch(() => {})
      return
    }
    const chat_id = String(msg?.chat.id ?? ctx.from.id)
    const thread = msg && 'is_topic_message' in msg && msg.is_topic_message && msg.message_thread_id != null
      ? msg.message_thread_id : undefined
    void runPrompt(chat_id, value, { thread }).catch(err =>
      process.stderr.write(`telegram-pi: opt ingest failed: ${err}\n`))
    if (msg) optionLabelsByMsg.delete(msg.message_id)
    await ctx.editMessageReplyMarkup().catch(() => {})
    const ackLabel = value.length > 40 ? value.slice(0, 39) + '…' : value
    await ctx.answerCallbackQuery({ text: `✓ ${ackLabel}` }).catch(() => {})
    return
  }

  // DIVE-449: Escalate tap under a /task_<id> detail.
  const escM = /^esc:(\d+)$/.exec(data)
  if (escM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const taskId = escM[1]!
    try {
      const r = await run5dive(['task', 'escalate', taskId, '--json'], 8000)
      const pri = r.ok ? (r.data?.priority ?? 'high') : 'high'
      await ctx.answerCallbackQuery({ text: `🔺 Escalated — priority ${pri}` }).catch(() => {})
      await ctx.editMessageReplyMarkup({
        reply_markup: new InlineKeyboard().text('▶️ Do now', `donow:${taskId}`),
      }).catch(() => {})
    } catch {
      await ctx.answerCallbackQuery({ text: "Couldn't escalate — open the dashboard." }).catch(() => {})
    }
    return
  }

  // DIVE-503: Do now tap — ping the assignee to pick it up immediately.
  const dnM = /^donow:(\d+)$/.exec(data)
  if (dnM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
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
  const tdM = /^tdone:(\d+)$/.exec(data)
  if (tdM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
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
  const tcM = /^tcancel:(\d+)$/.exec(data)
  if (tcM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
    const taskId = tcM[1]!
    await ctx.answerCallbackQuery({ text: 'Tap "Confirm cancel" to cancel this task.' }).catch(() => {})
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard()
        .text('⚠️ Confirm cancel', `tcancelc:${taskId}`)
        .text('↩︎ Keep', `tkeep:${taskId}`),
    }).catch(() => {})
    return
  }
  const tccM = /^tcancelc:(\d+)$/.exec(data)
  if (tccM) {
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
      return
    }
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
    const senderId = String(ctx.from.id)
    if (!loadAccess().allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
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
  // DIVE-2374: the `tna:` (tap-to-answer) GATE route, ported from telegram base +
  // grok. It was not stale here, it was ABSENT: this router never matched `tna:`,
  // so no gate of any type -- decision/approval/secret/manual, nonce or not --
  // could ever be cleared from Telegram on this runtime. It fell through to the
  // bottom of the handler and died silently. Keep this branch LAST, and keep the
  // parse-then-authorise order: an unmatched pattern must not reach an auth check
  // that answers a callback we do not own.
  const tnaM = TNA_RE.exec(data)
  if (!tnaM) return
  const tnaSender = String(ctx.from?.id ?? '')
  if (!loadAccess().allowFrom.includes(tnaSender)) {
    await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
    return
  }
  const tnaTaskId = tnaM[1]!
  const tnaToken = tnaM[2]!
  // DIVE-916: per-gate HUMAN nonce carried in callback_data -> --human-proof.
  const tnaProof = tnaM[3]
  let tnaIdent: string | null = null
  try {
    const show = await run5dive(['task', 'show', tnaTaskId, '--json'], 5000)
    const task = show.ok ? show.data?.task : undefined
    // Branch logic lives in resolveTnaAnswer (DIVE-369, byte-identical across
    // every plugin, pinned headless by test/tna-harness.test.ts). Thin I/O adapter.
    // DIVE-2846: the ident is what a human can look up; the callback carries
    // only the internal id. Keep it so a failure names the right task.
    if (typeof (task as any)?.ident === 'string') tnaIdent = (task as any).ident
    const r = resolveTnaAnswer(task, tnaToken)
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
    // DIVE-1115: mark EVERY verified-human tap --human (allowFrom vetted the
    // tapper just above) so a decision/manual tap does not record a bare AGENT
    // name in need_answered_by -- which the zero-human KPI counts as non-human.
    // --human-proof rides along only when the gate minted a nonce (hard gates do,
    // decisions do not), so an older CLI on the box never sees an unknown flag.
    const extraArgs = tapEvidenceArgs(tnaProof, {
      uid: ctx.callbackQuery.from?.id,
      username: ctx.callbackQuery.from?.username,
      messageId: ctx.callbackQuery.message?.message_id,
      osUser: process.env.USER,
    })
    // DIVE-2623: run5dive() RESOLVES (never rejects) on a CLI refusal in --json
    // mode, unlike base's execFileP. Without this check an ok:false envelope
    // (e.g. a task_answer_closed_row refusal, DIVE-2228) fell through as if the
    // answer succeeded and the catch block below never ran.
    const answered = await run5dive(['task', 'answer', tnaTaskId, ...r.answerArgs, ...extraArgs, '--json'], 8000)
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
      const re = await run5dive(['task', 'show', tnaTaskId, '--json'], 5000)
      const t = re.ok ? re.data?.task : undefined
      landing = tapLanding(re.ok === true, t)
      if (typeof t?.ident === 'string') tnaIdent = t.ident
      answer = t?.need_answer ?? null
    } catch (reErr) {
      recheckDetail = describeTapError(reErr).detail
    }
    const copy = tapFailureCopy({ taskId: tnaTaskId, ident: tnaIdent, err: info, landing, answer, recheckDetail })
    recordTapFailure(copy.log)
    await ctx.answerCallbackQuery({ text: copy.toast }).catch(() => {})
    await ctx.reply(copy.chat).catch(() => {})
  }
})

// ============================================================================
// Boot
// ============================================================================

function shutdown() {
  shuttingDown = true
  try {
    // Only the active poller owns these files — never clear an incumbent's.
    if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) {
      unlinkSync(PID_FILE)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      try { unlinkSync(HEARTBEAT_FILE) } catch {}
    }
  } catch {}
  bot.stop().catch(() => {})
  for (const id of [...engines.keys()]) void disposeEngine(id)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

// DIVE-3752: signals and stdin EOF are not sufficient. When the parent chain
// (`claude` → `bun run` → us) is severed, neither fires reliably — but POSIX
// reparents us, so the ppid clause in ./lifecycle.ts catches it. No fork had
// that clause; only `plugins/telegram` did.
// This fork's own shutdown() stops the bot but never calls process.exit, so
// installLifecycle's force-exit backstop is what actually ends the process.
installLifecycle({ channel: 'telegram-pi', stateDir: STATE_DIR, cleanup: shutdown })

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
// backlog. This lineage is polling-only (no SEND_ONLY team-bot relay mode — cf
// DIVE-1428), so the banner always arms in the paired DM. Slow cadence — a pin
// only needs to survive scroll, not tick in real time; first run deferred so
// bot.api + access.json are settled.
setTimeout(() => void reconcileNeedsBanner(), 3000).unref()
setInterval(() => void reconcileNeedsBanner(), 60_000).unref()

void (async () => {
  // DIVE-818 single-flight acquisition (ported per DIVE-1241): wait until no
  // HEALTHY incumbent holds the slot, then claim it. A transient enumeration
  // spawn parks here harmlessly and is killed by its parent before it ever polls.
  async function acquireSlot(): Promise<void> {
    for (;;) {
      if (shuttingDown) return
      if (!incumbentHolds()) {
        try {
          const prev = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
          if (prev > 1 && prev !== process.pid && pidAlive(prev)) {
            process.stderr.write(`telegram-pi: reclaiming stale poller pid=${prev}\n`)
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
        // Telegram remembers the last allowed_updates for a token; pin ours so a
        // prior bridge on this token can't have narrowed out callback_query
        // (which would silently kill our permission/option buttons).
        allowed_updates: ['message', 'callback_query'],
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-pi: polling as @${info.username} (hosting pi via in-process SDK)\n`)
          for (const scope of [undefined, { type: 'all_private_chats' as const }]) {
            void bot.api.setMyCommands(MENU_COMMANDS, scope ? { scope } : undefined).catch(err => {
              process.stderr.write(`telegram-pi: setMyCommands(${scope?.type ?? 'default'}) failed: ${err}\n`)
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
        `telegram-pi: polling error attempt ${attempt}${is409 ? ' (409 Conflict)' : ''}: `
        + `${err instanceof Error ? err.message : String(err)}; retrying in ${wait}ms\n`)
      await new Promise(r => setTimeout(r, wait))
      // DIVE-1239: a 409 means another process is already polling this bot
      // token. Re-run single-flight acquisition so we PARK behind a HEALTHY
      // incumbent (fresh heartbeat) instead of thrashing getUpdates against it
      // forever. Without this, a second server.ts spawned by an overlapping
      // respawn fights the boot poller indefinitely — two live pollers on one
      // token = permanent 409 = the plugin goes deaf.
      if (is409) await acquireSlot()
    }
  }
})()

// Touch unused imports/helpers kept for parity with the fork family / future use.
void InputFile; void existsSync; void assertInStateDir
void assertAllowedChat; void PHOTO_EXTS; void MAX_ATTACHMENT_BYTES; void loginHint; void lastInboundTs
