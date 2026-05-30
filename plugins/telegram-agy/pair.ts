#!/usr/bin/env bun
/**
 * Pairing CLI for the telegram-agy plugin.
 *
 * Usage:
 *   bun /path/to/telegram-agy/pair.ts [--token=<bot-token>] [--timeout=60]
 *
 * Without args:
 *   - Reads TELEGRAM_BOT_TOKEN from ~/.gemini/channels/telegram/.env
 *   - Looks up the bot's @username via getMe
 *   - Prints "DM @<username> now to pair"
 *   - Polls Telegram for the first inbound DM
 *   - Appends the sender's user_id to access.json.allowFrom (dedupe)
 *   - Sends a "✅ paired" reply, exits
 *
 * Pattern: CLI-initiated (server can't be a coordination point because the
 * agy MCP server lazy-spawns — running this while agy isn't is the
 * common case during first-time setup).
 *
 * Refuses to run if the MCP server is already polling (PID_FILE present and
 * alive) — two consumers on one getUpdates token conflict (409). The user
 * must stop their Antigravity session first, pair, then restart Antigravity.
 */

import { Bot, GrammyError } from 'grammy'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

function arg(name: string, fallback?: string): string | undefined {
  for (const a of process.argv.slice(2)) {
    if (a === `--${name}`) return ''
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3)
  }
  return fallback
}

const STATE_DIR = arg('state-dir')
  ?? process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.ANTIGRAVITY_HOME ?? process.env.GEMINI_HOME ?? join(homedir(), '.gemini'), 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'bot.pid')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = arg('token') ?? process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  console.error(
    `telegram-agy pair: bot token required.\n` +
    `  set TELEGRAM_BOT_TOKEN in ${ENV_FILE}, or pass --token=<...>`,
  )
  process.exit(1)
}

// 409 Conflict guard: Telegram allows one getUpdates consumer per token.
try {
  const pid = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (pid > 1) {
    process.kill(pid, 0)
    console.error(
      `telegram-agy pair: another poller is already running (pid ${pid}).\n` +
      `  stop your Antigravity session first, then re-run this command.`,
    )
    process.exit(2)
  }
} catch {}

const timeoutSec = Math.max(10, Math.min(300, Number(arg('timeout') ?? 60)))

type AccessJson = {
  allowFrom: string[]
  groups: Record<string, { requireMention: boolean; allowFrom: string[] }>
}

function loadAccess(): AccessJson {
  try {
    const parsed = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<AccessJson>
    return {
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
    }
  } catch {
    return { allowFrom: [], groups: {} }
  }
}

function saveAccess(a: AccessJson) {
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2))
  chmodSync(tmp, 0o600)
  // rename is atomic on POSIX — readers never see a half-written file
  renameSync(tmp, ACCESS_FILE)
}

const bot = new Bot(TOKEN)

let me: { username?: string; id?: number }
try {
  me = await bot.api.getMe()
} catch (err) {
  console.error(`telegram-agy pair: getMe failed — bad token?\n  ${err}`)
  process.exit(3)
}

console.log(`bot: @${me.username} (id ${me.id})`)
console.log(`DM @${me.username} from your Telegram account within ${timeoutSec}s to pair...`)

const paired = await new Promise<{ user_id: string; chat_id: string; first_name?: string } | null>(resolve => {
  let done = false
  const timer = setTimeout(() => {
    if (done) return
    done = true
    bot.stop().catch(() => {})
    resolve(null)
  }, timeoutSec * 1000)

  bot.on('message', async ctx => {
    if (done) return
    if (!ctx.from || !ctx.chat) return
    if (ctx.chat.type !== 'private') return // pair via DM only — never from groups
    done = true
    clearTimeout(timer)
    const user_id = String(ctx.from.id)
    const chat_id = String(ctx.chat.id)
    resolve({ user_id, chat_id, first_name: ctx.from.first_name })
    try {
      await ctx.reply(`✅ paired — your user_id ${user_id} is now on the allowlist.`)
    } catch {}
    await bot.stop().catch(() => {})
  })

  process.on('SIGINT', () => {
    if (done) return
    done = true
    clearTimeout(timer)
    bot.stop().catch(() => {})
    resolve(null)
  })

  void bot.start({ drop_pending_updates: true }).catch(err => {
    if (done) return
    done = true
    clearTimeout(timer)
    const is409 = err instanceof GrammyError && err.error_code === 409
    if (is409) {
      console.error(
        `telegram-agy pair: 409 Conflict — another bot poller is using this token.\n` +
        `  stop your Antigravity session (or any other process polling this token), then retry.`,
      )
    } else {
      console.error(`telegram-agy pair: bot.start failed: ${err}`)
    }
    resolve(null)
  })
})

if (!paired) {
  console.error(`\ntimeout — no DM received in ${timeoutSec}s. nothing changed.`)
  process.exit(4)
}

const access = loadAccess()
if (access.allowFrom.includes(paired.user_id)) {
  console.log(`already paired — ${paired.user_id} was on the allowlist. nothing changed.`)
  process.exit(0)
}

access.allowFrom.push(paired.user_id)
saveAccess(access)

console.log(
  `\n✅ paired:\n` +
  `  user_id: ${paired.user_id}${paired.first_name ? ` (${paired.first_name})` : ''}\n` +
  `  chat_id: ${paired.chat_id}\n` +
  `  access.json updated: ${ACCESS_FILE}`,
)
