// DIVE-3809 scope 3: the drain guard must serialise ACROSS PROCESSES.
//
// server.ts's `draining`/`rerun` pair is module state — it serialises the three
// callers inside ONE process and is blind to a second one. Two plugin processes
// for the same agent (an overlapping restart, a stray respawn) each fetch the
// SAME pending rows and push every message into the session TWICE, because the
// ack only lands after the notifications are sent.
//
// DIVE-3806 REFUTED this as the cause of the loss it observed — lifecycle.log
// showed exactly one live process across that window — so this is not a fix for
// that. It is a real race, it is scope 3, and dashboard-collect-now.test.ts
// cannot see it: that harness runs a single process, so it grades the
// per-process half and would stay green with the lock deleted.
//
// The arm therefore runs TWO real server.ts processes against ONE stub control
// plane and ONE shared state dir, and counts pushes across BOTH.
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const BOOT_MS = 5_000

function spawnPlugin(dir: string, port: number, delivered: string[]) {
  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: dir,
      DASHBOARD_API_BASE: `http://127.0.0.1:${port}`,
      CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
      USER: 'agent-dev',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lock-test', version: '0' } },
    }) + '\n'
  )
  proc.stdin.flush()
  void (async () => {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.method === 'notifications/claude/channel') delivered.push(String(msg.params?.content ?? ''))
          if (msg.id === 1) {
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
            proc.stdin.flush()
          }
        } catch {}
      }
    }
  })()
  return proc
}

async function waitFor(pred: () => boolean, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(25)
  }
  return pred()
}

describe('cross-process drain lock (DIVE-3809)', () => {
  test('two plugin processes on one state dir push each message EXACTLY once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drain-lock-'))
    const delivered: string[] = []
    let queue = [
      { id: 1, text: 'first' },
      { id: 2, text: 'second' },
    ]
    let pendingHits = 0
    // Snapshot at REQUEST time then delay, exactly as dashboard-collect-now
    // does: a stub that re-reads after the delay hands the second drain the
    // state AFTER the first one's ack and silently removes the race.
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/server/messages/pending') {
          pendingHits++
          const snapshot = queue
          await Bun.sleep(900)
          return Response.json({ pending: snapshot })
        }
        if (url.pathname === '/server/messages/pending/ack') {
          const body = (await req.json()) as { ids: number[] }
          queue = queue.filter(m => !body.ids.includes(m.id))
          return Response.json({ ok: true })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const a = spawnPlugin(dir, api.port, delivered)
    const b = spawnPlugin(dir, api.port, delivered)
    try {
      // Both boot drains fire ~5s after start, i.e. genuinely overlapping.
      await waitFor(() => delivered.length >= 2, BOOT_MS + 10_000)
      // Settle: give a second (unserialised) drain every chance to double-push.
      await Bun.sleep(3_000)
      const counts = new Map<string, number>()
      for (const d of delivered) counts.set(d, (counts.get(d) ?? 0) + 1)
      expect(delivered.length).toBeGreaterThanOrEqual(2)
      expect([...counts.entries()].filter(([, n]) => n > 1)).toEqual([])
      expect(pendingHits).toBeGreaterThan(0)
    } finally {
      a.kill(); b.kill(); api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)

  test('a stale lock left by a killed drain is broken, not honoured forever', async () => {
    // The failure this forecloses: a lock file is the classic way to turn an
    // intermittent loss into a permanent one. A drain killed mid-flight leaves
    // the file behind, and if nothing breaks it the collect path is wedged for
    // the life of the box — strictly worse than the bug being fixed.
    const dir = mkdtempSync(join(tmpdir(), 'stale-lock-'))
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, 'pending-drain.lock')
    writeFileSync(lock, '999999 stale\n')
    // Age it well past the 2-minute staleness bound. utimesSync, not `touch
    // -d` — bun's built-in shell does not implement that flag.
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(lock, old, old)
    const delivered: string[] = []
    let queue = [{ id: 7, text: 'after a crash' }]
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/server/messages/pending') return Response.json({ pending: queue })
        if (url.pathname === '/server/messages/pending/ack') {
          const body = (await req.json()) as { ids: number[] }
          queue = queue.filter(m => !body.ids.includes(m.id))
          return Response.json({ ok: true })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const p = spawnPlugin(dir, api.port, delivered)
    try {
      const got = await waitFor(() => delivered.length >= 1, BOOT_MS + 10_000)
      expect(got).toBe(true)
      expect(delivered[0]).toBe('after a crash')
      // And the drain cleaned up after itself, so the next pass is not blocked.
      expect(existsSync(lock)).toBe(false)
    } finally {
      p.kill(); api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)
})
