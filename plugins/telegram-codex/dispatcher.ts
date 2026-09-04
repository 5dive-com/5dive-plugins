#!/usr/bin/env bun
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  unlinkSync, watch, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ChannelDispatcher, type DispatchMessage, type DispatchRoute } from './dispatcher-core.ts'
import { installLifecycle, recordLifecycle } from './lifecycle.ts'

const STATE_DIR = process.env.CODEX_DISPATCHER_STATE_DIR
  ?? join(homedir(), '.codex', 'channels', 'dispatcher')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const OUTBOX_DIR = join(STATE_DIR, 'outbox')
const STATE_FILE = join(STATE_DIR, 'state.json')
const WORKDIR = process.env.CODEX_DISPATCHER_WORKDIR ?? process.cwd()
const CODEX_BIN = process.env.CODEX_BIN ?? 'codex'
const BUN_BIN = process.execPath
const CHANNELS = new Set((process.env.CODEX_DISPATCHER_CHANNELS ?? 'telegram').split(',').filter(Boolean))

for (const dir of [STATE_DIR, INBOX_DIR, OUTBOX_DIR, join(OUTBOX_DIR, 'telegram'), join(OUTBOX_DIR, 'dashboard')]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  onNotification: (method: string, params: any) => void = () => {}

  constructor() {
    this.child = spawn(CODEX_BIN, [
      'app-server',
      // Channel adapters own both directions. An empty table prevents a
      // configured legacy MCP bridge from starting a second channel consumer;
      // replacing the table also avoids parsing stale MCP transport settings.
      '-c', 'mcp_servers={}',
      '--stdio',
    ], {
      cwd: WORKDIR,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buf = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      buf += chunk
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl < 0) break
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: any
        try { msg = JSON.parse(line) } catch {
          process.stderr.write(`codex-dispatcher: invalid app-server JSON: ${line.slice(0, 200)}\n`)
          continue
        }
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
          const waiter = this.pending.get(Number(msg.id))
          if (!waiter) continue
          this.pending.delete(Number(msg.id))
          if (msg.error) waiter.reject(new Error(String(msg.error.message ?? 'app-server request failed')))
          else waiter.resolve(msg.result)
        } else if (msg.id != null && typeof msg.method === 'string') {
          // The dispatcher has no local approval UI. Preserve the configured
          // app-server policy and fail closed instead of overriding it to
          // danger-full-access or leaving a server request hanging forever.
          let result: Record<string, unknown> | null = null
          if (msg.method === 'item/commandExecution/requestApproval'
            || msg.method === 'item/fileChange/requestApproval') result = { decision: 'decline' }
          if (msg.method === 'execCommandApproval' || msg.method === 'applyPatchApproval') {
            result = { decision: { denied: { rejection: 'dispatcher has no interactive approval client' } } }
          }
          const response = result
            ? { id: msg.id, result }
            : { id: msg.id, error: { code: -32601, message: 'dispatcher does not handle this server request' } }
          this.child.stdin.write(`${JSON.stringify(response)}\n`)
        } else if (typeof msg.method === 'string') {
          this.onNotification(msg.method, msg.params)
        }
      }
    })
    this.child.stderr.pipe(process.stderr)
    this.child.once('exit', (code, signal) => {
      const err = new Error(`app-server exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
      for (const waiter of this.pending.values()) waiter.reject(err)
      this.pending.clear()
      if (!shuttingDown) {
        process.stderr.write(`codex-dispatcher: ${err.message}; supervisor will restart\n`)
        process.exit(code || 1)
      }
    })
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, err => {
        if (err) { this.pending.delete(id); reject(err) }
      })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  stop(): void { this.child.kill('SIGTERM') }
}

function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

function stateStore() {
  return {
    load() {
      try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return null }
    },
    save(state: unknown) {
      atomicJson(STATE_FILE, state)
      try { chmodSync(STATE_FILE, 0o600) } catch {}
    },
  }
}

let outSeq = 0
async function publish(route: DispatchRoute, text: string, meta: Record<string, unknown>): Promise<void> {
  process.stdout.write(`${text}\n`)
  if (route.source === 'agent') return
  const dir = join(OUTBOX_DIR, route.source)
  const file = join(dir, `${Date.now()}-${process.pid}-${outSeq++}.json`)
  atomicJson(file, { ...route, text, ...meta })
}

const rpc = new JsonRpcProcess()
const dispatcher = new ChannelDispatcher(rpc, stateStore(), { publish }, WORKDIR)
rpc.onNotification = (method, params) => {
  void dispatcher.notification(method, params).catch(err => fatal(`event ${method} failed: ${err}`))
}

async function initialize(): Promise<void> {
  await rpc.request('initialize', {
    clientInfo: { name: '5dive_channel_dispatcher', title: '5dive Channel Dispatcher', version: '0.1.0' },
    capabilities: null,
  })
  rpc.notify('initialized', {})
  await dispatcher.initialize()
  process.stderr.write(`codex-dispatcher: ready thread=${dispatcher.snapshot().threadId} cwd=${WORKDIR}\n`)
}

function ingest(name: string): void {
  if (!name.endsWith('.json')) return
  const full = join(INBOX_DIR, name)
  let raw = ''
  try { raw = readFileSync(full, 'utf8') } catch { return }
  let msg: DispatchMessage
  try { msg = JSON.parse(raw) } catch {
    process.stderr.write(`codex-dispatcher: invalid inbox JSON ${name}\n`)
    try { unlinkSync(full) } catch {}
    return
  }
  if (!msg?.id || !msg?.text?.trim() || !msg?.route?.source || !msg?.route?.chat_id) {
    process.stderr.write(`codex-dispatcher: incomplete inbox message ${name}\n`)
    try { unlinkSync(full) } catch {}
    return
  }
  if (!['telegram', 'dashboard', 'agent'].includes(msg.route.source)) {
    process.stderr.write(`codex-dispatcher: invalid inbox source ${name}\n`)
    try { unlinkSync(full) } catch {}
    return
  }
  void dispatcher.submit(msg).then(outcome => {
    try { unlinkSync(full) } catch {}
    process.stderr.write(`codex-dispatcher: ${outcome} ${msg.id} source=${msg.route.source}\n`)
  }).catch(err => {
    // Keep the file: a run-loop restart will retry it after app-server recovers.
    process.stderr.write(`codex-dispatcher: dispatch failed for ${msg.id}: ${err}\n`)
    setTimeout(() => ingest(name), 1000).unref?.()
  })
}

function startInbox(): void {
  const drain = () => { try { for (const f of readdirSync(INBOX_DIR)) ingest(f) } catch {} }
  drain()
  watch(INBOX_DIR, (_event, name) => { if (name) ingest(String(name)) })
  setInterval(drain, 15_000).unref?.()
}

const children: ChildProcessWithoutNullStreams[] = []
function startAdapter(file: string, extraEnv: Record<string, string>): void {
  const child = spawn(BUN_BIN, [file], {
    cwd: WORKDIR,
    env: { ...process.env, CODEX_DISPATCHER_STATE_DIR: STATE_DIR, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  children.push(child)
  child.once('exit', (code, signal) => {
    if (!shuttingDown) fatal(`channel adapter ${file} exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
  })
}

let shuttingDown = false
function fatal(message: string): never {
  process.stderr.write(`codex-dispatcher: ${message}\n`)
  recordLifecycle(STATE_DIR, 'crash', 'codex-dispatcher', message)
  shutdown(1)
  throw new Error(message)
}
function shutdown(code = 0): void {
  if (!shuttingDown) {
    shuttingDown = true
    for (const child of children) child.kill('SIGTERM')
    rpc.stop()
  }
  setTimeout(() => process.exit(code), 100)
}

// The dispatcher owns the channel lifetime in the primary mode. Keep the
// lifecycle record, stdin-EOF handlers, and real-ppid orphan watchdog on that
// owner rather than on the adapter children it supervises.
installLifecycle({
  channel: 'codex-dispatcher',
  stateDir: STATE_DIR,
  cleanup: () => shutdown(0),
})

await initialize()
startInbox()
if (CHANNELS.has('telegram')) {
  startAdapter(join(import.meta.dir, 'server.ts'), { CODEX_DISPATCHER_ADAPTER: 'telegram' })
}
if (CHANNELS.has('dashboard')) {
  startAdapter(join(import.meta.dir, '..', 'dashboard', 'server.ts'), {
    CODEX_DISPATCHER_ADAPTER: 'dashboard',
    DASHBOARD_STATE_DIR: process.env.DASHBOARD_STATE_DIR
      ?? join(homedir(), '.codex', 'channels', 'dashboard'),
  })
}
