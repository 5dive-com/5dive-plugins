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
import { homedir } from 'os'
import { join, extname, sep } from 'path'

const PLUGIN_VERSION = '0.1.11'

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

type AccessJson = {
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
}

const DEFAULT_ACCESS: AccessJson = { allowFrom: [], groups: {} }

function loadAccess(): AccessJson {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AccessJson>
    return {
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
    }
  } catch {
    return { ...DEFAULT_ACCESS }
  }
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
function gate(ctx: Context): { allowed: true; access: AccessJson } | { allowed: false } {
  const access = loadAccess()
  const chat = ctx.chat
  const from = ctx.from
  if (!chat || !from) return { allowed: false }

  const chatId = String(chat.id)
  const senderId = String(from.id)

  if (chat.type === 'private') {
    if (access.allowFrom.includes(senderId)) return { allowed: true, access }
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
  { command: 'help',    description: 'list bot commands and version' },
  { command: 'status',  description: 'show bridge health: token, allowlist, MCP server, last inbound' },
  { command: 'ping',    description: 'liveness check — replies with bot + plugin version' },
  { command: 'stop',    description: 'interrupt the current Codex turn (sends Ctrl-C to the pane)' },
  { command: 'restart', description: 'restart the Codex agent (systemd respawn brings it back in ~2s)' },
  { command: 'agents',  description: 'list sibling 5dive agents on this host' },
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

function statusText(): string {
  const access = loadAccess()
  let mcpPid = 0
  try { mcpPid = parseInt(readFileSync(PID_FILE, 'utf8'), 10) } catch {}
  const mcpAlive = pidAlive(mcpPid) && mcpPid === process.pid

  const lines = [
    `*telegram-codex* v${PLUGIN_VERSION}`,
    ``,
    `bot:        @${botUsername || '?'}`,
    `MCP poller: ${mcpAlive ? `✅ alive (pid ${process.pid})` : '⚠️  pid mismatch / stale'}`,
    `allowlist:  ${access.allowFrom.length} user(s), ${Object.keys(access.groups).length} group(s)`,
    `last inbound: ${lastInboundTs ?? '(none this session)'}`,
    ``,
    `state dir:  \`${STATE_DIR}\``,
  ]
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

  try {
    switch (cmd) {
      case 'help':
        await bot.api.sendMessage(chat_id, helpText(), {
          parse_mode: 'Markdown',
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      case 'status':
        await bot.api.sendMessage(chat_id, statusText(), {
          parse_mode: 'Markdown',
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
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
      case 'agents': {
        const list = await listAgents()
        await bot.api.sendMessage(chat_id, list, {
          parse_mode: 'Markdown',
          ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
        })
        return true
      }
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
  if (!verdict.allowed) return

  if (await handleSlashCommand(ctx, text)) return

  lastInboundTs = new Date().toISOString()

  const from = ctx.from!
  const chat = ctx.chat!
  const msgId = ctx.message?.message_id

  const imagePath = downloadImage ? await downloadImage() : undefined

  enqueueInbound({
    chat_id: String(chat.id),
    message_id: msgId != null ? String(msgId) : '0',
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
        + 'Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
          reply_to: {
            type: 'string',
            description: 'Message ID to thread under. Use message_id from an inbound message.',
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
        return { content: [{ type: 'text', text: formatInbound(msg) }] }
      }

      case 'reply': {
        const chat_id = String(args.chat_id)
        const text = String(args.text)
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
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

        const chunks = chunkForTelegram(text)
        const sentIds: number[] = []
        try {
          for (let i = 0; i < chunks.length; i++) {
            // Thread reply_to only on the first chunk — subsequent chunks
            // would all quote the same inbound, which is noisy.
            const sent = await bot.api.sendMessage(chat_id, chunks[i]!, {
              ...(i === 0 && reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
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
          const opts = reply_to != null ? { reply_parameters: { message_id: reply_to } } : undefined
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
// Boot
// ============================================================================

process.on('SIGTERM', () => { shuttingDown = true; bot.stop().catch(() => {}) })
process.on('SIGINT',  () => { shuttingDown = true; bot.stop().catch(() => {}) })

await mcp.connect(new StdioServerTransport())

startPermissionBridge()

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
          void bot.api.setMyCommands(BOT_COMMANDS).catch(err => {
            process.stderr.write(`telegram-codex: setMyCommands failed: ${err}\n`)
          })
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
