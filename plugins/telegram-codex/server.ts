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
import { Bot, GrammyError, InputFile, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import {
  readFileSync, writeFileSync, mkdirSync, chmodSync, statSync,
  realpathSync, renameSync,
} from 'fs'
import { homedir } from 'os'
import { join, extname, sep } from 'path'

const PLUGIN_VERSION = '0.1.0'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(homedir(), '.codex', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const PID_FILE = join(STATE_DIR, 'bot.pid')

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

  const from = ctx.from!
  const chat = ctx.chat!
  const msgId = ctx.message?.message_id

  // Fire-and-forget ack reaction so the user sees the bot received the msg.
  if (msgId != null) {
    void bot.api.setMessageReaction(String(chat.id), msgId, [
      { type: 'emoji', emoji: '👀' },
    ]).catch(() => {})
  }

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
        + "message body. Use the chat_id and message_id in subsequent reply/react calls.",
      inputSchema: {
        type: 'object',
        properties: {
          timeout_seconds: {
            type: 'number',
            description: 'Max seconds to wait before returning {timeout: true}. Default 300, max 1800.',
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
        const requested = Number(args.timeout_seconds ?? 300)
        const seconds = Math.max(1, Math.min(1800, isFinite(requested) ? requested : 300))
        const msg = await dequeueOrWait(seconds * 1000)
        if (!msg) {
          return { content: [{ type: 'text', text: `<telegram timeout=true seconds=${seconds}/>` }] }
        }
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
        for (const f of files) {
          assertInStateDir(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
          }
        }

        const sent = await bot.api.sendMessage(chat_id, text, {
          ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        })
        const sentIds = [sent.message_id]

        for (const f of files) {
          const ext = extname(f).toLowerCase()
          const input = new InputFile(f)
          const opts = reply_to != null ? { reply_parameters: { message_id: reply_to } } : undefined
          const out = PHOTO_EXTS.has(ext)
            ? await bot.api.sendPhoto(chat_id, input, opts)
            : await bot.api.sendDocument(chat_id, input, opts)
          sentIds.push(out.message_id)
        }

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

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-codex: polling as @${info.username}\n`)
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
