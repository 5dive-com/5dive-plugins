#!/usr/bin/env bun
/**
 * Telegram MCP server for Codex CLI.
 *
 * Outbound tools (Codex → user):
 *   reply, edit_message, react, download_attachment
 *
 * Inbound tool (user → Codex):
 *   wait_for_message — blocking. Codex calls when idle; resolves when the
 *   bot receives an allowed DM/group message.
 *
 * State: ~/.codex/channels/telegram/{access.json, .env, inbox/, bot.pid}
 *
 * Sibling to ../telegram/ (the Claude Code build). Forked rather than shared
 * because the runtime contracts diverge — Codex has no channel-notification
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
  realpathSync, renameSync, readdirSync, watch, existsSync, unlinkSync,
} from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join, extname, sep } from 'path'

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return String(pkg.version ?? 'unknown')
  } catch { return 'unknown' }
})()

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(homedir(), '.codex', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const PERMS_DIR = join(STATE_DIR, 'permissions')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const PID_FILE = join(STATE_DIR, 'bot.pid')
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
mkdirSync(PERMS_DIR, { recursive: true, mode: 0o700 })

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
if (!TOKEN) {
  process.stderr.write(
    `telegram-codex: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

// Telegram allows exactly one getUpdates consumer per token. Replace any
// stale poller left over from a crashed prior run.
try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0)
    process.stderr.write(`telegram-codex: replacing stale poller pid=${stale}\n`)
    process.kill(stale, 'SIGTERM')
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram-codex: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram-codex: uncaught exception: ${err}\n`)
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

function loadAccess(): AccessJson {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AccessJson>
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
  } catch {
    return { ...DEFAULT_ACCESS, pending: {} }
  }
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
    process.stderr.write(`telegram-codex: saveAccess failed: ${err}\n`)
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
      .catch((err: any) => process.stderr.write(`telegram-codex: stall auto-reply failed: ${err?.message}\n`))
    return
  }
  const next = waiters.shift()
  if (next) {
    if (next.timer) clearTimeout(next.timer)
    next.resolve(msg)
  } else {
    inboxQueue.push(msg)
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
let botUsername = ''
let shuttingDown = false

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// Telegram clears the "typing…" indicator ~5s after each sendChatAction.
// Re-send every 4s per chat from when Codex picks up an inbound (via
// wait_for_message) until the next reply lands, with a 5min ceiling so a
// crashed turn never loops forever. Without this, a thinking Codex looks
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

// Telegram sendMessage caps at 4096 characters per message. Codex turns
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
// never appear in the wait_for_message queue and Codex doesn't see them.
//
// Codex itself owns commands that need to manipulate its session (model
// switching, stop, restart, checkpoint). Those would require IPC into the
// running session and are out of scope here.
const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'help',    description: 'Show commands' },
  { command: 'status',  description: 'Pairing, usage, model' },
  { command: 'stop',    description: 'Interrupt task' },
  { command: 'restart', description: 'Respawn codex' },
  { command: 'agents',  description: 'Team' },
  { command: 'tasks',   description: 'List open tasks' },
  { command: 'task',    description: 'Add a task — /task add <title>' },
  { command: 'org',     description: 'Show the agent org chart' },
  { command: 'model',   description: 'Pick model' },
  { command: 'ping',    description: 'Liveness check' },
  { command: 'start',   description: 'Pair this chat' },
]

function helpText(): string {
  const lines = [
    `*telegram-codex* v${PLUGIN_VERSION} — bridge for OpenAI Codex CLI`,
    ``,
    `commands:`,
    ...BOT_COMMANDS.map(c => `  /${c.command} — ${c.description}`),
    ``,
    `everything else you send routes to Codex via wait_for_message.`,
    `docs: github.com/5dive-com/5dive-plugins/tree/main/plugins/telegram-codex`,
  ]
  return lines.join('\n')
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

const SERVER_STARTED_AT = Date.now()
const CLI_BIN = 'codex'

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
// CLI runtime allows. Codex has no session-status / usage cache like claude's,
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

async function interruptCodex(): Promise<string> {
  const name = agentName()
  if (name === 'unknown') return '⚠️ cannot determine agent name; not running under a 5dive systemd unit'
  return new Promise(resolve => {
    // `tmux send-keys -t <session> C-c` interrupts whatever the foreground
    // process in that pane is doing. Codex's loop in 5dive-agent-start is
    //   while true; do codex; sleep 2; done
    // so C-c kills the current codex run, sleep fires, then a fresh
    // codex starts. From the user's POV the session is back in <5s.
    const child = require('child_process').execFile('tmux',
      ['send-keys', '-t', `agent-${name}`, 'C-c'],
      { timeout: 5000 },
      (err: any) => {
        if (err) resolve(`⚠️ tmux send-keys failed: ${err.message}`)
        else resolve(`✋ sent Ctrl-C to agent \`${name}\` — current Codex turn interrupted`)
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

// /tasks — list open tasks from the shared 5dive queue.
async function listTasks(): Promise<string> {
  try {
    const j = await run5dive(['task', 'ls', '--json'])
    if (!j.ok || !Array.isArray(j.data?.tasks)) return '⚠️ `5dive task ls` returned unexpected output.'
    const tasks = j.data.tasks
    if (tasks.length === 0) return 'No open tasks.\n\nAdd one with `/task add <title>`.'
    const lines = tasks.map((t: any) => {
      const pri = t.priority && t.priority !== 'medium' ? ` (${t.priority})` : ''
      const who = t.assignee ? ` · ${t.assignee}` : ''
      return `• \`${t.ident}\` [${t.status}]${pri} ${t.title}${who}`
    })
    return `*Open tasks:*\n\n${lines.join('\n')}`
  } catch (err) {
    return `⚠️ Failed to list tasks: ${err instanceof Error ? err.message : String(err)}`
  }
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

async function restartAgent(name: string): Promise<void> {
  if (name === 'unknown') return
  await new Promise<void>(resolve => {
    // `sudo 5dive agent restart <name>` is the canonical path — it
    // touches the systemd unit, not the tmux session directly, so the
    // unit's audit log and restart counter stay consistent.
    require('child_process').execFile('sudo',
      ['-n', '5dive', 'agent', 'restart', name],
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
const CLI_LABEL = 'Codex'
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

// Returns true if this message was handled as a slash command (caller
// should NOT enqueue it for Codex).
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
        await bot.api.sendMessage(chat_id, `pong — telegram-codex v${PLUGIN_VERSION}`, {
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      case 'stop': {
        const result = await interruptCodex()
        await bot.api.sendMessage(chat_id, result, {
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      }
      case 'restart': {
        // Send the reply BEFORE restarting — our own process is the MCP
        // server, but the systemd unit owns the Codex pane that runs us.
        // 5dive agent restart kills + respawns the pane; depending on
        // 5dive's implementation it may or may not also terminate us.
        // Sending first keeps the user informed even in the kill-us case.
        const name = agentName()
        await bot.api.sendMessage(chat_id, `restarting agent \`${name}\` — back in ~2s`, {
          parse_mode: 'Markdown',
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        }).catch(() => {})
        await restartAgent(name)
        return true
      }
      case 'model': {
        const r = await handleModelCommand(cmdArg)
        await md(r.text)
        if (r.switchTo) await restartAgent(agentName())
        return true
      }
      case 'agents': {
        const list = await listAgents()
        await bot.api.sendMessage(chat_id, list, {
          parse_mode: 'Markdown',
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      }
      case 'tasks':
        await md(await listTasks())
        return true
      case 'task':
        await md(await addTask(cmdArg, ctx.from?.username || 'telegram'))
        return true
      case 'org':
        await md(await orgTree(cmdArg))
        return true
      case 'start':
        await md(
          'This bot bridges Telegram to an OpenAI Codex session.\n\n' +
          'To pair:\n' +
          '1. Run `bun pair.ts` in the telegram-codex plugin dir to get your user id allowlisted\n' +
          '2. After that, messages here reach that Codex session.\n\n' +
          'Try `/help` for the full command list.',
        )
        return true
    }
  } catch (err) {
    process.stderr.write(`telegram-codex: /${cmd} reply failed: ${err}\n`)
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
      process.stderr.write(`telegram-codex: photo download failed: ${err}\n`)
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
  process.stderr.write(`telegram-codex: handler error (polling continues): ${err.error}\n`)
})

// ============================================================================
// Permission bridge (Codex PermissionRequest hook ↔ Telegram inline buttons)
//
// hooks/request-permission.ts writes req-<id>.json under permissions/. We
// watch the dir; on each new req we post a Telegram message with [✅ allow]
// [❌ deny] buttons, register the {callback_data → request_id} mapping, and
// (on tap) write res-<id>.json with the user's decision + edit the message
// to show who answered. The hook reads res-<id>.json and returns to Codex.
//
// Why file-IPC over a socket: one moving part fewer, survives MCP server
// restarts (pending requests resume as soon as the watcher comes back), and
// the codex hook is a short-lived process that can't easily hold a socket.
// ============================================================================

type PendingApproval = {
  reqId: string
  chat_id: string
  message_id: number
}

const pendingApprovals = new Map<string, PendingApproval>() // key = callback prefix

function shortToolDesc(req: any): string {
  const tool = req.tool_name ?? 'tool'
  if (tool === 'Bash' && req.tool_input?.command) {
    return `\`$ ${String(req.tool_input.command).slice(0, 300)}\``
  }
  const inputStr = JSON.stringify(req.tool_input ?? {}, null, 2).slice(0, 500)
  return `\`${tool}\`\n\`\`\`\n${inputStr}\n\`\`\``
}

async function broadcastApproval(reqPath: string) {
  let req: any
  try {
    req = JSON.parse(readFileSync(reqPath, 'utf8'))
  } catch (err) {
    process.stderr.write(`telegram-codex: bad req file ${reqPath}: ${err}\n`)
    return
  }
  const reqId = String(req.id ?? '')
  if (!reqId) return

  const access = loadAccess()
  if (access.allowFrom.length === 0) {
    process.stderr.write(`telegram-codex: no allowFrom entries, can't ask anyone for approval (req ${reqId})\n`)
    return
  }

  const body =
    `🔐 *Codex wants to run:*\n${shortToolDesc(req)}\n\n` +
    `_cwd: ${req.cwd ?? '?'} · model: ${req.model ?? '?'}_`

  const kb = new InlineKeyboard()
    .text('✅ allow', `tgcodex:allow:${reqId}`)
    .text('❌ deny',  `tgcodex:deny:${reqId}`)

  // DM the first allowFrom user. (We pick one chat to avoid double-decisions
  // from multiple recipients racing each other on the same request.)
  const chat_id = access.allowFrom[0]
  try {
    const sent = await bot.api.sendMessage(chat_id, body, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    })
    pendingApprovals.set(reqId, { reqId, chat_id, message_id: sent.message_id })
  } catch (err) {
    process.stderr.write(`telegram-codex: failed to send approval prompt for ${reqId}: ${err}\n`)
  }
}

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data ?? ''
  const m = data.match(/^tgcodex:(allow|deny):(.+)$/)
  if (!m) return
  const behavior = m[1] as 'allow' | 'deny'
  const reqId = m[2]!

  // Re-gate the responder: anyone tapping must be in allowFrom — otherwise
  // a leaked button-share link could let a stranger answer.
  const senderId = String(ctx.from.id)
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'not authorised', show_alert: true }).catch(() => {})
    return
  }

  const pending = pendingApprovals.get(reqId)
  pendingApprovals.delete(reqId)

  // Write the response file (the hook polls for it).
  const resPath = join(PERMS_DIR, `res-${reqId}.json`)
  const user = ctx.from.username ?? ctx.from.first_name ?? senderId
  writeFileSync(resPath, JSON.stringify({ behavior, user, ts: new Date().toISOString() }))

  // Acknowledge to the button-tapper.
  await ctx.answerCallbackQuery({ text: behavior === 'allow' ? '✅ allowed' : '❌ denied' }).catch(() => {})

  // Edit the original message to show who decided + remove the buttons.
  if (pending) {
    const label = behavior === 'allow' ? `✅ allowed by ${user}` : `❌ denied by ${user}`
    await bot.api.editMessageText(pending.chat_id, pending.message_id, label, { reply_markup: undefined })
      .catch(() => {})
  }
})

// Initial sweep + fs.watch on permissions/. fs.watch fires on req-*.json
// creation; we re-stat to confirm the file is fully written before parsing.
function startPermissionBridge() {
  for (const f of readdirSync(PERMS_DIR)) {
    if (f.startsWith('req-') && f.endsWith('.json')) void broadcastApproval(join(PERMS_DIR, f))
  }
  watch(PERMS_DIR, (event, filename) => {
    if (!filename || !filename.startsWith('req-') || !filename.endsWith('.json')) return
    const full = join(PERMS_DIR, filename)
    if (!existsSync(full)) return
    // Tiny debounce — a hook that's still writing when watch fires would
    // otherwise produce a half-parse and a "deny" decision.
    setTimeout(() => { if (existsSync(full)) void broadcastApproval(full) }, 100)
  })
}

// ============================================================================
// MCP server
// ============================================================================

const mcp = new Server(
  { name: 'telegram-codex', version: PLUGIN_VERSION },
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
        + "Codex CLI's normal stdin prompt for chats routed through this bot. "
        + "Returns a <telegram chat_id=... message_id=... user=...> block with the "
        + "message body. Use the chat_id and message_id in subsequent reply/react calls. "
        + "If no message arrives before the timeout, returns <telegram timeout=true/> — "
        + "loop and call again immediately; idle polling is cheap.",
      inputSchema: {
        type: 'object',
        properties: {
          timeout_seconds: {
            type: 'number',
            description:
              "Max seconds to wait before returning <telegram timeout=true/>. Default 90, max 90 — "
              + "capped because Codex's MCP layer kills any tool call that runs past ~120s, "
              + "which drops the inbound message that arrived right at the boundary. "
              + "Loop and call again instead of asking for longer.",
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
        const requested = Number(args.timeout_seconds ?? 90)
        const seconds = Math.max(1, Math.min(90, isFinite(requested) ? requested : 90))
        const msg = await dequeueOrWait(seconds * 1000)
        if (!msg) {
          return { content: [{ type: 'text', text: `<telegram timeout=true seconds=${seconds}/>` }] }
        }
        // Codex now has a message to work on — keep "typing…" visible until
        // it sends `reply` (or the 5min ceiling).
        startTypingLoop(msg.chat_id)
        try { writeFileSync(LAST_INBOUND_FILE, String(Date.now())) } catch {}
        return { content: [{ type: 'text', text: formatInbound(msg) }] }
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
        const chunks = chunkForTelegram(text, accessForReply.textChunkLimit ?? TG_MAX_MESSAGE_CHARS)
        const sentIds: number[] = []
        try {
          for (let i = 0; i < chunks.length; i++) {
            // Thread reply_to only on the first chunk — subsequent chunks
            // would all quote the same inbound, which is noisy.
            const sent = await bot.api.sendMessage(chat_id, chunks[i]!, {
              ...(i === 0 && reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
              ...(message_thread_id != null ? { message_thread_id } : {}),
              ...(parseMode ? { parse_mode: parseMode } : {}),
            })
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
// model-inference span: a reasoning model (e.g. gpt-5.5) can reason 60–120s+ in
// ONE span that writes nothing to the rollout, so newestTurnMtimeMs() goes stale
// mid-turn and a lower threshold kicks a busy agent off its task (customer bug
// 5dive-exact-swallow). 180s covers typical reasoning; a genuinely-wedged
// session is still caught (just slower) and backstopped by sendStallAlert.
// Tunable up to 600s for agents that reason even longer.
// ============================================================================
const REARM_DISABLED = process.env.TELEGRAM_REARM_DISABLED === '1'
const REARM_IDLE_MS = Math.max(20_000, Math.min(600_000,
  Number(process.env.TELEGRAM_REARM_IDLE_MS ?? 180_000)))
const REARM_CHECK_MS = 15_000
const REARM_KICK_TEXT =
  'Resume your Telegram listen loop: call wait_for_message now and keep looping '
  + '(on each message reply, then call wait_for_message again; on timeout call it '
  + 'again immediately). This is an automated re-arm — do not send a Telegram reply about it.'

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
    return { cause: 'listen loop wedged', detail: 'agent is idle outside wait_for_message and won’t re-arm' }
  } catch {
    return { cause: 'not responding', detail: 'could not read the agent pane' }
  }
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
    process.stderr.write('telegram-codex: stall detected but no allowFrom owner to alert\n')
    return
  }
  for (const id of owners) {
    bot.api.sendMessage(id, text).catch((err: any) =>
      process.stderr.write(`telegram-codex: stall alert to ${id} failed: ${err?.message}\n`))
  }
  stallAlerted = true
  try { writeFileSync(LAST_STALL_ALERT_FILE, String(Date.now())) } catch {}
  process.stderr.write(`telegram-codex: stall alert sent (${cause}) to ${owners.length} owner(s)\n`)
}

// Loop recovered — drop the dedup flag so a future stall alerts again.
function clearStallAlert(): void {
  if (!stallAlerted) return
  stallAlerted = false
  try { if (existsSync(LAST_STALL_ALERT_FILE)) unlinkSync(LAST_STALL_ALERT_FILE) } catch {}
}

function kickListenLoop(): void {
  const name = agentName()
  if (name === 'unknown') return
  const cp = require('child_process')
  // Type the prompt as a literal line, then submit. Two send-keys calls because
  // codex's TUI occasionally drops an Enter folded into the same call.
  cp.execFile('tmux', ['send-keys', '-t', `agent-${name}`, '-l', REARM_KICK_TEXT],
    { timeout: 5_000 }, (err: any) => {
      if (err) { process.stderr.write(`telegram-codex: rearm send-keys failed: ${err.message}\n`); return }
      setTimeout(() => {
        cp.execFile('tmux', ['send-keys', '-t', `agent-${name}`, 'Enter'], { timeout: 5_000 }, () => {})
      }, 400)
    })
}

// Newest agent-turn mtime (ms) — the "still doing real work" signal used by the
// watchdog below. Codex writes a transcript line every turn to
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl; the re-arm prompt only lands in
// history.jsonl, so rollout files are the clean PRIMARY and history.jsonl the
// fallback (covers the first turn before a rollout exists). Returns 0 if none.
const CODEX_SESSIONS_DIR = join(STATE_DIR, '..', '..', 'sessions')
const CODEX_HISTORY_FILE = join(STATE_DIR, '..', '..', 'history.jsonl')
function newestTurnMtimeMs(): number {
  try {
    const cp = require('child_process')
    const out: string = cp.execFileSync('find',
      [CODEX_SESSIONS_DIR, '-name', 'rollout-*.jsonl', '-printf', '%T@\\n'],
      { timeout: 4_000, encoding: 'utf8' })
    const secs = out.split('\n').reduce((m: number, l: string) => Math.max(m, Number(l) || 0), 0)
    if (secs > 0) return Math.round(secs * 1000)
  } catch { /* fall through to history.jsonl */ }
  try { return statSync(CODEX_HISTORY_FILE).mtimeMs } catch { return 0 }
}

function startRearmWatchdog(): void {
  if (REARM_DISABLED) return
  if (agentName() === 'unknown') return
  const timer = setInterval(() => {
    // Parked in wait_for_message → loop is armed and healthy.
    if (waiters.length > 0) { rearmKicks = 0; clearStallAlert(); return }
    const now = Date.now()
    // Liveness = the most recent of a Telegram-MCP call OR a real agent turn.
    // markActivity() only fires on Telegram tool calls, so an agent heads-down
    // on a task (shell/edits/`5dive task start`) leaves lastServerActivity stale
    // and would be wrongly kicked back into wait_for_message, abandoning the
    // task (customer bug 5dive-exact-swallow). Only pay for the turn-activity
    // stat once the cheap signal already looks stale.
    let idle = now - lastServerActivity
    if (idle >= REARM_IDLE_MS) {
      const lastTurn = newestTurnMtimeMs()
      if (lastTurn > 0) idle = Math.min(idle, now - lastTurn)
    }
    if (idle < REARM_IDLE_MS) return
    // Stalled out of the loop. Back off on repeated kicks (1×,2×,4×…cap 8×) so a
    // genuinely wedged session isn't spammed; a successful re-arm resets the count.
    const backoff = Math.min(8, 2 ** rearmKicks)
    if (idle < REARM_IDLE_MS * backoff) return
    process.stderr.write(`telegram-codex: listen loop idle ${Math.round(idle / 1000)}s, re-arming (kick #${rearmKicks + 1})\n`)
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

process.on('SIGTERM', () => { shuttingDown = true; bot.stop().catch(() => {}) })
process.on('SIGINT',  () => { shuttingDown = true; bot.stop().catch(() => {}) })

await mcp.connect(new StdioServerTransport())

startPermissionBridge()
startRearmWatchdog()

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-codex: polling as @${info.username}\n`)
          // Register the bot command menu so the TG app surfaces /<cmd>
          // suggestions. Failures are non-fatal — polling continues.
          // Write the menu to BOTH the default scope (groups + fallback) and
          // all_private_chats (DMs). A recycled bot token can carry a stale
          // all_private_chats menu that would otherwise shadow the default one
          // in DMs (Telegram resolves the most specific scope per chat).
          for (const scope of [undefined, { type: 'all_private_chats' as const }]) {
            void bot.api.setMyCommands(BOT_COMMANDS, scope ? { scope } : undefined).catch(err => {
              process.stderr.write(`telegram-codex: setMyCommands(${scope?.type ?? 'default'}) failed: ${err}\n`)
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
        `telegram-codex: polling error attempt ${attempt}${is409 ? ' (409 Conflict)' : ''}: `
        + `${err instanceof Error ? err.message : String(err)}; retrying in ${wait}ms\n`,
      )
      await new Promise(r => setTimeout(r, wait))
    }
  }
})()
