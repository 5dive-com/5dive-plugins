#!/usr/bin/env bun
/**
 * Dashboard channel for Claude Code (DIVE-841).
 *
 * Native-push MCP channel that connects an agent session to the 5dive web
 * dashboard's in-app chat (and, later, the mobile app — same protocol).
 *
 * Inbound (dashboard -> agent): the control plane POSTs to the box's shelld
 * /shell/inbox, which lands an atomic JSON drop (temp + rename, DIVE-343
 * contract) in ~/.claude/channels/dashboard/agent-inbox/. This server drains
 * that dir on boot, watches it live, and pushes each message into the session
 * via notifications/claude/channel — so a parked session wakes natively and a
 * message dropped while the plugin is down is delivered on next boot.
 *
 * Outbound (agent -> dashboard): the reply tool POSTs to the control-plane
 * messages API (POST /server/messages/event), authenticated by the box's
 * connectord token. No Telegram, no grammy — plain fetch.
 *
 * Origin-routing: this server is named "dashboard", so inbound arrives as
 * <channel source="dashboard" ...> and replies here can never leak onto the
 * telegram channel (and vice-versa) — one MCP server per channel name.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, mkdirSync, readdirSync, unlinkSync, watch, chmodSync, copyFileSync, openSync, closeSync, writeSync, statSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { installLifecycle, recordLifecycle } from './lifecycle.ts'

let PLUGIN_VERSION = '?'
try {
  PLUGIN_VERSION =
    JSON.parse(readFileSync(join(import.meta.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '?'
} catch {}

const STATE_DIR = process.env.DASHBOARD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'dashboard')
const DISPATCHER_ADAPTER = process.env.CODEX_DISPATCHER_ADAPTER === 'dashboard'
const DISPATCHER_STATE_DIR = process.env.CODEX_DISPATCHER_STATE_DIR
  ?? join(homedir(), '.codex', 'channels', 'dispatcher')
const DISPATCHER_INBOX_DIR = join(DISPATCHER_STATE_DIR, 'inbox')
const DISPATCHER_OUTBOX_DIR = join(DISPATCHER_STATE_DIR, 'outbox', 'dashboard')
const ENV_FILE = join(STATE_DIR, '.env')
const AGENT_INBOX_DIR = join(STATE_DIR, 'agent-inbox')
// DIVE-3574: the control plane drops a zero-byte marker here (via the box's
// shelld POST /shell/collect-now) to say "run your pending-collect now" instead
// of waiting out the 5-minute timer below. A SEPARATE dir from agent-inbox on
// purpose: a nudge carries no payload and must never be mistaken for a message
// drop-file, so the two ingesters can never read each other's files.
const COLLECT_NOW_DIR = join(STATE_DIR, 'collect-now')
// DIVE-3809: the drain's `draining`/`rerun` guard below is PER-PROCESS. Two
// plugin processes for the same agent (an overlapping restart, a stray
// supervisor respawn) each fetch the SAME pending rows and push every message
// into the session twice, because the ack lands only after the notifications
// are sent. This file is the cross-process arm of that guard: O_EXCL create
// wins the drain, everyone else skips this pass and picks it up on the next
// sweep. Refuted as the CAUSE of the loss DIVE-3806 observed (lifecycle.log
// showed exactly one live process across that window) — it is still a real
// race, and it is scope 3 of this row.
const DRAIN_LOCK = join(STATE_DIR, 'pending-drain.lock')
mkdirSync(AGENT_INBOX_DIR, { recursive: true, mode: 0o700 })
mkdirSync(COLLECT_NOW_DIR, { recursive: true, mode: 0o700 })
if (DISPATCHER_ADAPTER) {
  mkdirSync(DISPATCHER_INBOX_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(DISPATCHER_OUTBOX_DIR, { recursive: true, mode: 0o700 })
}

// Load ~/.claude/channels/dashboard/.env into process.env. Real env wins.
// Plugin-spawned servers don't get an env block — overrides live here
// (DASHBOARD_API_BASE for previews/tests, CONNECTORD_TOKEN off-box).
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const API_BASE = (process.env.DASHBOARD_API_BASE ?? 'https://api.5dive.com').replace(/\/+$/, '')
// Shared, claude-group-writable dir the box's file server can read back from
// (install/update.sh create it 2775 claude:claude). Reply attachments are
// copied here so the dashboard download always resolves.
const OUTBOX_DIR = process.env.DASHBOARD_OUTBOX ?? '/home/claude/chat-downloads'

// The box's connectord token authenticates outbound replies to the control
// plane. Standard location is /etc/5dive/connectord.env (root:claude 640;
// agent users are in the claude group). Env/.env override for tests.
//
// DIVE-3810: this file is REWRITTEN UNDER US while the agent runs — pairing a
// phone rotates the box token (shelld's /shell/rotate-token does the line
// surgery). A token read once at module scope therefore outlives the rotation
// that invalidates it, and from that instant the channel is deaf AND mute: all
// three calls below carry a dead credential. So `TOKEN` is mutable and gets
// re-read on rejection. shelld itself already treats it this way
// (`let TOKEN` + rotate-in-place); this plugin was the reader that did not.
const TOKEN_FILE = process.env.CONNECTORD_ENV_FILE ?? '/etc/5dive/connectord.env'
function loadConnectordToken(): string {
  // An explicit env override stays authoritative and is never reloaded: it is
  // set by a test or an off-box run, and nothing rotates it.
  //
  // RESIDUAL, stated rather than fixed: the ENV_FILE loader above copies
  // CONNECTORD_TOKEN out of ~/.claude/channels/dashboard/.env into process.env
  // BEFORE this runs, so a token that arrives that way is read here as an
  // override and is never reloaded — that seat is back in the DIVE-3810 bug
  // with no signal. No live box is affected today: pairing rotates the FILE,
  // and nothing in the provision or agent-create path writes CONNECTORD_TOKEN
  // into that .env at all (agent-create passes the dashboard channel an EMPTY
  // token on purpose, DIVE-841) — the box token is written once to
  // /etc/5dive/connectord.env by the installer and rotated there by shelld, so
  // this branch is only ever taken by a test or a deliberate off-box run.
  // Fixing it means deciding that the .env copy is rotatable too, which is a
  // different question from this one.
  if (process.env.CONNECTORD_TOKEN) return process.env.CONNECTORD_TOKEN
  try {
    for (const line of readFileSync(TOKEN_FILE, 'utf8').split('\n')) {
      const m = line.match(/^CONNECTORD_TOKEN=(.+)$/)
      if (m) return m[1].trim()
    }
  } catch {}
  return ''
}
let TOKEN = loadConnectordToken()
if (!TOKEN) {
  process.stderr.write(
    `dashboard channel: connectord token not found\n` +
    `  expected /etc/5dive/connectord.env (CONNECTORD_TOKEN=...) or CONNECTORD_TOKEN in ${ENV_FILE}\n`,
  )
  process.exit(1)
}

// The agent's short name — the unix user is agent-<name>. The main `claude`
// user maps to "claude". Matches the control plane's agent-name guard.
const AGENT = (process.env.USER ?? '').replace(/^agent-/, '')
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(AGENT)) {
  process.stderr.write(`dashboard channel: cannot derive agent name from USER="${process.env.USER ?? ''}"\n`)
  process.exit(1)
}

// --- DIVE-3810: the credential is mutable, and its failure has to be visible --
//
// Pairing a phone rewrites /etc/5dive/connectord.env while this process runs.
// Every surface a triager would check then says "healthy" — the process is
// alive, the MCP socket is ESTAB with empty queues, the control plane's
// /pending holds the messages with their text intact and delivered_at NULL,
// and the OTHER channel on the same agent keeps working because buzz does not
// use this token. The only signal was one stderr line that goes down the stdio
// socket into the harness and is written to no file on the box.
//
// So: reload on rejection (the cheapest correct fix — no watch, no timer, and
// it costs exactly one extra request on the request that was going to fail
// anyway), and write the state CHANGE to lifecycle.log, which is a file on the
// box that a human or an agent can read after the fact.
let authFailing = false

/** Re-read the token from disk. True only if it actually CHANGED. */
function reloadToken(): boolean {
  const next = loadConnectordToken()
  if (!next || next === TOKEN) return false
  TOKEN = next
  return true
}

function recordAuth(reason: string): void {
  recordLifecycle(STATE_DIR, 'auth', 'dashboard', reason)
}

/**
 * Every control-plane call goes through here so no call site can hold a stale
 * credential — a fix applied at one of the three would leave the channel half
 * deaf. `what` names the call in the record.
 *
 * On 401/403 the token is re-read; if (and only if) it changed, the request is
 * retried ONCE with the new one. A rejection that survives a reload is a real
 * rejection and is returned to the caller unchanged — this must not turn an
 * auth failure into a retry loop.
 */
async function authedFetch(url: string, what: string, init: RequestInit = {}): Promise<Response> {
  const send = () =>
    fetch(url, {
      ...init,
      headers: { ...((init.headers as Record<string, string>) ?? {}), authorization: `Bearer ${TOKEN}` },
    })
  let res = await send()
  if (res.status !== 401 && res.status !== 403) {
    if (authFailing) {
      authFailing = false
      recordAuth(`credential accepted again on ${what} (${res.status})`)
    }
    return res
  }
  if (reloadToken()) {
    // Drain the rejected body so the retry is not racing a live stream.
    void res.text().catch(() => '')
    res = await send()
    if (res.status !== 401 && res.status !== 403) {
      authFailing = false
      recordAuth(`token rotated on disk (${TOKEN_FILE}); reloaded and retried ${what} ok`)
      return res
    }
  }
  if (!authFailing) {
    authFailing = true
    recordAuth(
      `${what} rejected ${res.status} and reloading ${TOKEN_FILE} did not fix it — ` +
        `dashboard chat is deaf and mute until this clears`,
    )
  }
  return res
}

const mcp = new Server(
  { name: 'dashboard', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: [
      'The sender reads the 5dive dashboard chat (web/mobile app), not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
      '',
      'Inbound arrives as <channel source="dashboard" chat_id="dashboard" user="..." ts="...">. Pass chat_id back to reply. If the tag has image_path, Read that path (an uploaded file). To share a file back, pass its absolute path in the reply files array — the dashboard serves it as a download.',
      '',
      'Replies to source="dashboard" messages must use THIS reply tool, never the telegram one — each channel routes to its own surface.',
    ].join('\n'),
  },
)

let dispatcherInboxSeq = 0
function deliverInbound(id: string, text: string, meta: Record<string, unknown>): Promise<void> {
  if (!DISPATCHER_ADAPTER) {
    return mcp.notification({ method: 'notifications/claude/channel', params: { content: text, meta } })
  }
  const seq = `${Date.now()}-${process.pid}-${dispatcherInboxSeq++}`
  const tmp = join(DISPATCHER_INBOX_DIR, `.${seq}.tmp`)
  const dest = join(DISPATCHER_INBOX_DIR, `${seq}.json`)
  writeFileSync(tmp, JSON.stringify({
    id,
    text,
    route: { source: 'dashboard', chat_id: String(meta.chat_id ?? 'dashboard') },
    ...(typeof meta.image_path === 'string' ? { image_path: meta.image_path } : {}),
    received_at: meta.ts,
  }) + '\n', { mode: 0o600 })
  renameSync(tmp, dest)
  return Promise.resolve()
}

// --- Inbound: agent-inbox drop-dir -> notifications/claude/channel ---------
//
// Drop-file contract (one JSON object per file, name ending in `.json`):
//   { "text": "...",                // REQUIRED, non-empty
//     "from": "dashboard",          // optional sender label -> user/user_id
//     "chat_id": "dashboard",       // optional reply-routing target
//     "ts": "2026-07-02T10:00:00Z", // optional ISO timestamp (default: now)
//     "image_path": "/abs/path" }   // optional uploaded-file path on this box
// Writers MUST write atomically — temp name, then rename to `*.json` — so the
// watcher never reads a half-written file (shelld's /shell/inbox does this).
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
    process.stderr.write(`dashboard channel: bad agent-inbox file ${name}: not JSON\n`); return
  }
  const text = typeof obj?.text === 'string' ? obj.text : ''
  if (!text.trim()) {
    process.stderr.write(`dashboard channel: agent-inbox file ${name} has no text\n`); return
  }
  const from = typeof obj?.from === 'string' && obj.from ? obj.from : 'dashboard'
  void deliverInbound(`dashboard:drop:${name}`, text, {
        chat_id: typeof obj?.chat_id === 'string' && obj.chat_id ? obj.chat_id : 'dashboard',
        message_id: '0',
        user: from,
        user_id: from,
        ts: typeof obj?.ts === 'string' && obj.ts ? obj.ts : new Date().toISOString(),
        ...(typeof obj?.image_path === 'string' && obj.image_path.startsWith('/')
          ? { image_path: obj.image_path } : {}),
  }).catch(err => {
    process.stderr.write(`dashboard channel: failed to deliver inbound to Claude: ${err}\n`)
  })
}

// Drain any files dropped while the server was down, then watch for new ones.
// fs.watch can coalesce or double-fire events; ingestInboxFile unlinks first so
// a duplicate event is a harmless no-op and a missed event is caught by the
// periodic sweep below (belt and braces — inotify can drop under pressure).
function startAgentInbox(): void {
  const drain = () => { try { for (const f of readdirSync(AGENT_INBOX_DIR)) ingestInboxFile(f) } catch {} }
  drain()
  try {
    watch(AGENT_INBOX_DIR, (_evt, fname) => { if (fname) ingestInboxFile(String(fname)) })
    process.stderr.write(`dashboard channel v${PLUGIN_VERSION}: watching agent-inbox at ${AGENT_INBOX_DIR}\n`)
  } catch (err) {
    process.stderr.write(`dashboard channel: agent-inbox watch failed: ${err}\n`)
  }
  setInterval(drain, 15_000).unref()
}

// DIVE-3574: watch the collect-now dir and drain on a nudge. The marker is
// deliberately NOT consumed — shelld rewrites one fixed path in place, so every
// nudge fires an inotify event whether or not the file already exists, and
// nothing has to survive a delete race. Events are coalesced over a short
// window because fs.watch can double-fire on a single write and a burst of
// messages is one collect, not several.
//
// Best-effort by design: if this watch never installs, or inotify drops the
// event under pressure, the unchanged 5-minute timer still collects. Nothing
// here may become load-bearing.
function startCollectNowWatch(): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = () => {
    if (timer) return
    timer = setTimeout(() => { timer = null; void drainPending() }, 250)
    timer.unref?.()
  }
  try {
    watch(COLLECT_NOW_DIR, () => fire())
    process.stderr.write(`dashboard channel v${PLUGIN_VERSION}: watching collect-now at ${COLLECT_NOW_DIR}\n`)
  } catch (err) {
    process.stderr.write(`dashboard channel: collect-now watch failed (falling back to the 5-min poll): ${err}\n`)
  }
}

// DIVE-848 offline heal: a message sent while this box was unreachable never
// produced a drop file — it sits in the control plane with delivered_at NULL.
// Pull those on boot (and on a slow sweep), push them into the session, then
// ack so they stamp COLLECTED. Ack only AFTER the notifications are sent; a
// crash in between redelivers rather than losing the message. A row whose
// drop landed but whose collected-stamp write failed may arrive twice — rare
// and preferable to silence.
// DIVE-3809: the ack no longer stamps delivered_at. It could never attest
// delivery, and stamping the column `/pending` reads meant one wrong ack
// deleted the only copy. A collected row is now merely hidden for a TTL and
// comes back, bounded by an attempt count. Note the consequence for the
// empty-text branch below: it acks a row it never pushed, so such a row is
// re-offered until the attempt bound retires it — bounded and visible, where
// before it was silently destroyed.
// DIVE-3574: drainPending is now reachable from three places (boot, the 5-min
// timer, and a collect nudge that can fire several times a second while someone
// types in the dashboard) where it used to be reachable from two that could
// never overlap. Two concurrent drains fetch the SAME pending rows and push
// each message into the session twice, because the ack only lands after the
// notifications are sent — so serialise. `rerun` remembers that a nudge arrived
// mid-drain and gives it one more pass, which is what keeps a message that
// landed after the fetch from waiting out the full timer.
let draining = false
let rerun = false

// A drain that dies mid-flight (SIGKILL, box reboot) leaves the lock file
// behind, and a stale lock that nothing clears would wedge the collect path
// permanently — the exact failure shape this row exists to remove. So the lock
// is TIME-BOUNDED: older than this and it is treated as abandoned and broken.
// One drain is a fetch + N notifications + an ack, all with short timeouts;
// two minutes is far past any healthy pass.
const DRAIN_LOCK_STALE_MS = 2 * 60_000

// Returns true if THIS process now holds the lock. Never throws: a filesystem
// that cannot support the lock must degrade to today's per-process-only
// behaviour, not stop the customer's message from being collected.
function acquireDrainLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(DRAIN_LOCK, 'wx')
      try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`) } catch {}
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        process.stderr.write(`dashboard channel: drain lock unavailable (${err}); per-process guard only\n`)
        return true
      }
      // Held. Break it only if it is provably stale, then retry the create
      // once — if another process wins that race, we simply skip this pass.
      try {
        const age = Date.now() - statSync(DRAIN_LOCK).mtimeMs
        if (age <= DRAIN_LOCK_STALE_MS) return false
        process.stderr.write(`dashboard channel: breaking stale drain lock (age ${Math.round(age / 1000)}s)\n`)
        unlinkSync(DRAIN_LOCK)
      } catch { return false }
    }
  }
  return false
}

function releaseDrainLock(): void {
  try { unlinkSync(DRAIN_LOCK) } catch {}
}

async function drainPending(): Promise<void> {
  if (draining) { rerun = true; return }
  draining = true
  try {
    // Cross-process (DIVE-3809). Skipping is safe and NOT a lost message: the
    // holder is draining the same rows right now, and anything it misses is
    // re-offered by the control plane once the collect TTL expires.
    if (!acquireDrainLock()) {
      process.stderr.write('dashboard channel: another process holds the drain lock; skipping this pass\n')
      return
    }
    try {
      await drainPendingOnce()
    } finally {
      releaseDrainLock()
    }
  } finally {
    draining = false
  }
  if (rerun) { rerun = false; await drainPending() }
}

async function drainPendingOnce(): Promise<void> {
  let items: Array<{ id: number; text: string; from?: string; chat_id?: string; ts?: string; image_path?: string }>
  try {
    const res = await authedFetch(
      `${API_BASE}/server/messages/pending?agent=${encodeURIComponent(AGENT)}`,
      'pending fetch',
    )
    if (!res.ok) throw new Error(`${res.status}`)
    items = ((await res.json()) as { pending?: typeof items }).pending ?? []
  } catch (err) {
    process.stderr.write(`dashboard channel: pending fetch failed: ${err}\n`)
    return
  }
  if (items.length === 0) return
  const acked: number[] = []
  for (const m of items) {
    if (typeof m?.text !== 'string' || !m.text.trim()) { acked.push(m.id); continue }
    try {
      await deliverInbound(`dashboard:pending:${m.id}`, m.text, {
            chat_id: typeof m.chat_id === 'string' && m.chat_id ? m.chat_id : 'dashboard',
            message_id: '0',
            user: m.from ?? 'dashboard',
            user_id: m.from ?? 'dashboard',
            ts: m.ts ?? new Date().toISOString(),
            ...(typeof m.image_path === 'string' && m.image_path.startsWith('/')
              ? { image_path: m.image_path } : {}),
      })
      acked.push(m.id)
    } catch (err) {
      process.stderr.write(`dashboard channel: pending push failed for ${m.id}: ${err}\n`)
    }
  }
  if (acked.length === 0) return
  try {
    const ack = await authedFetch(`${API_BASE}/server/messages/pending/ack`, 'pending ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: AGENT, ids: acked }),
    })
    // DIVE-3810: a non-2xx ack must reach the catch below. Without this the
    // rows are logged as collected while the control plane still holds them
    // uncollected — the exact split this row exists to close.
    if (!ack.ok) throw new Error(`${ack.status}`)
    // DIVE-3809: "collected", not "delivered" or "healed". This ack attests
    // that the notification's bytes entered the stdout pipe — the SDK's send()
    // has no reject path, and a client with nothing subscribed drops the
    // notification silently — so it can never say the session displayed it.
    // The control plane now re-offers a collected row whose TTL expires.
    process.stderr.write(`dashboard channel: collected ${acked.length} pending message(s) (collection is not display)\n`)
  } catch (err) {
    process.stderr.write(`dashboard channel: pending ack failed (row stays uncollected; re-offered next sweep): ${err}\n`)
  }
}

// --- Outbound: reply tool -> control-plane messages API --------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply in the 5dive dashboard chat. Pass chat_id from the inbound message (normally "dashboard"). ' +
        'Optionally pass files (absolute paths on this box) to offer as downloads in the chat.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths on this box to attach as downloadable files.',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

async function sendDashboardReply(args: { chat_id?: unknown; text?: unknown; files?: unknown }): Promise<string> {
  const text = typeof args.text === 'string' ? args.text : ''
  if (!text.trim()) throw new Error('text is required')
  const chatId = typeof args.chat_id === 'string' && args.chat_id ? args.chat_id : 'dashboard'
  // Attached files must be readable by the dashboard's file server, which
  // runs as the `claude` user — a path inside this agent's 0700 home dir
  // downloads as "failed" in the chat (lodar hit exactly that). Copy each
  // file into the shared group-writable outbox and attach the copy; if the
  // copy fails (outbox missing on an old box), fall back to the original
  // path so behavior degrades to today's, not worse.
  const rawFiles = Array.isArray(args.files)
    ? args.files.filter((f): f is string => typeof f === 'string' && f.startsWith('/')).slice(0, 10)
    : []
  const files = rawFiles.map(f => {
    try {
      const dest = join(OUTBOX_DIR, `${AGENT}-${Date.now()}-${f.split('/').pop() ?? 'file'}`)
      copyFileSync(f, dest)
      chmodSync(dest, 0o664)
      return dest
    } catch (err) {
      process.stderr.write(`dashboard channel: outbox copy failed for ${f}: ${err}\n`)
      return f
    }
  })

  const res = await authedFetch(`${API_BASE}/server/messages/event`, 'outbound reply', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      agent: AGENT,
      body: text,
      metadata: { chat_id: chatId, ...(files.length ? { files } : {}) },
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`dashboard reply failed: control plane returned ${res.status} ${detail.slice(0, 200)}`)
  }
  const j = (await res.json().catch(() => null)) as { id?: number } | null
  return `sent (id: ${j?.id ?? '?'})`
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') throw new Error(`unknown tool: ${req.params.name}`)
  const result = await sendDashboardReply(
    (req.params.arguments ?? {}) as { chat_id?: unknown; text?: unknown; files?: unknown },
  )
  return { content: [{ type: 'text', text: result }] }
})

const dispatcherOutboxBusy = new Set<string>()
function ingestDispatcherOutbox(name: string): void {
  if (!name.endsWith('.json') || dispatcherOutboxBusy.has(name)) return
  const full = join(DISPATCHER_OUTBOX_DIR, name)
  let obj: any
  try { obj = JSON.parse(readFileSync(full, 'utf8')) } catch { return }
  if (obj?.source !== 'dashboard' || !String(obj?.text ?? '').trim()) {
    process.stderr.write(`dashboard channel: invalid dispatcher outbox file ${name}\n`)
    try { unlinkSync(full) } catch {}
    return
  }
  dispatcherOutboxBusy.add(name)
  void sendDashboardReply({ chat_id: obj.chat_id, text: obj.text }).then(() => {
    try { unlinkSync(full) } catch {}
  }).catch(err => {
    process.stderr.write(`dashboard channel: dispatcher reply failed for ${name}: ${err}\n`)
    setTimeout(() => ingestDispatcherOutbox(name), 1_000).unref?.()
  }).finally(() => dispatcherOutboxBusy.delete(name))
}

function startDispatcherOutbox(): void {
  const drain = () => {
    try { for (const name of readdirSync(DISPATCHER_OUTBOX_DIR)) ingestDispatcherOutbox(name) } catch {}
  }
  drain()
  try {
    watch(DISPATCHER_OUTBOX_DIR, (_event, name) => { if (name) ingestDispatcherOutbox(String(name)) })
    process.stderr.write(`dashboard channel: dispatcher adapter watching ${DISPATCHER_OUTBOX_DIR}\n`)
  } catch (err) {
    process.stderr.write(`dashboard channel: dispatcher outbox watch failed: ${err}\n`)
  }
  setInterval(drain, 15_000).unref?.()
}

// DIVE-3752: same gap as buzz — this server ends in long-lived timers with no
// signal handler, no stdin handler and no exit path, so a severed parent chain
// leaves it running. The interval below is `.unref()`d, which does NOT save it:
// the MCP stdio transport holds stdin open and keeps the loop alive.
if (!DISPATCHER_ADAPTER) {
  installLifecycle({ channel: 'dashboard', stateDir: STATE_DIR })
  await mcp.connect(new StdioServerTransport())
} else {
  process.stderr.write('dashboard channel: app-server dispatcher adapter active; native MCP delivery is not running\n')
  startDispatcherOutbox()
}
// Claude Code registers channel-notification handling shortly AFTER the MCP
// connection comes up ("Channel notifications registered", ~20-50ms later) —
// a notification pushed inside that window is silently dropped (observed
// live: a pending-drain at connect+0ms acked a message the session never
// displayed). No ready signal is exposed, so give the harness a generous
// head start before the first drains. Mid-session paths (fs.watch, sweeps)
// are unaffected.
setTimeout(() => {
  startAgentInbox()
  startCollectNowWatch()
  void drainPending()
}, DISPATCHER_ADAPTER ? 0 : 5_000)
setInterval(() => void drainPending(), 5 * 60_000).unref()
