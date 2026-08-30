// DIVE-3810: pairing a phone rotates the box's connectord token while the agent
// is running, and the dashboard channel held the one it read at boot.
//
// This drives the REAL plugins/dashboard/server.ts as a subprocess against a
// stub control plane that rejects a stale bearer, exactly as the live one does,
// and rotates the token FILE underneath the running process — the thing
// shelld's /shell/rotate-token does. A static assertion that a reload exists
// cannot tell you the channel recovers; only a running process that was 401ing
// and then delivers can.
//
// Both directions are exercised on purpose. The row's defect is one cause with
// two symptoms — the channel goes deaf (collect) AND mute (the agent's reply) —
// and a fix applied to the collect path alone would still leave the customer
// talking to a wall.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
// server.ts gives the harness a 5s head start before its first drain and before
// the watchers install; everything here waits that out.
const BOOT_MS = 5_000
const OLD_TOKEN = 'tok-old-abcdefghijkl'
const NEW_TOKEN = 'tok-new-mnopqrstuvwx'

type Harness = {
  dir: string
  pendingHits: number
  rejected: number
  events: Array<{ body: string }>
  delivered: string[]
  stop: () => void
  nudge: () => void
  enqueue: (msgs: Array<{ id: number; text: string }>) => void
  rotate: (next: string) => void
  reply: (text: string) => void
  lifecycleLines: () => string[]
  waitFor: (pred: () => boolean, ms: number) => Promise<boolean>
}

async function start(pending: Array<{ id: number; text: string }>): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'token-rotation-'))
  const envFile = join(dir, 'connectord.env')
  writeFileSync(envFile, `CONNECTORD_TOKEN=${OLD_TOKEN}\nOTHER=keep-me\n`)

  let accepted = OLD_TOKEN
  let queue = [...pending]
  const delivered: string[] = []
  const events: Array<{ body: string }> = []
  const h = { pendingHits: 0, rejected: 0 }

  const api = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      // The control plane's own behaviour: a stale bearer is a 401, on every
      // route, whatever the payload.
      if (req.headers.get('authorization') !== `Bearer ${accepted}`) {
        h.rejected++
        return new Response('unauthorized', { status: 401 })
      }
      if (url.pathname === '/server/messages/pending') {
        h.pendingHits++
        return Response.json({ pending: queue })
      }
      if (url.pathname === '/server/messages/pending/ack') {
        const body = (await req.json()) as { ids: number[] }
        queue = queue.filter(m => !body.ids.includes(m.id))
        return Response.json({ ok: true })
      }
      if (url.pathname === '/server/messages/event') {
        const body = (await req.json()) as { body: string }
        events.push({ body: body.body })
        return Response.json({ id: events.length })
      }
      return new Response('not found', { status: 404 })
    },
  })

  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      DASHBOARD_STATE_DIR: dir,
      DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
      // Deliberately NOT CONNECTORD_TOKEN: an explicit env override is
      // authoritative and never reloaded, so setting it here would test the one
      // path the rotation cannot reach.
      CONNECTORD_ENV_FILE: envFile,
      CONNECTORD_TOKEN: undefined as unknown as string,
      USER: 'agent-dev',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  proc.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'token-rotation-test', version: '0' },
      },
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
          if (msg.method === 'notifications/claude/channel') {
            delivered.push(String(msg.params?.content ?? ''))
          }
          if (msg.id === 1) {
            proc.stdin.write(
              JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
            )
            proc.stdin.flush()
          }
        } catch {}
      }
    }
  })()

  const nudgeDir = join(dir, 'collect-now')
  let replyId = 100
  return {
    dir,
    get pendingHits() { return h.pendingHits },
    get rejected() { return h.rejected },
    events,
    delivered,
    stop: () => {
      proc.kill()
      api.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
    enqueue: msgs => { queue = [...queue, ...msgs] },
    nudge: () => {
      mkdirSync(nudgeDir, { recursive: true })
      writeFileSync(join(nudgeDir, 'nudge'), '')
    },
    // Line surgery over the file, then flip the control plane — byte-for-byte
    // the shape of shelld's rotate-token (it keeps the other lines).
    rotate: next => {
      const kept = readFileSync(envFile, 'utf8')
        .split('\n')
        .filter(l => l && !l.startsWith('CONNECTORD_TOKEN='))
      writeFileSync(envFile, [`CONNECTORD_TOKEN=${next}`, ...kept].join('\n') + '\n')
      accepted = next
    },
    reply: text => {
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: replyId++,
          method: 'tools/call',
          params: { name: 'reply', arguments: { chat_id: 'dashboard', text } },
        }) + '\n'
      )
      proc.stdin.flush()
    },
    lifecycleLines: () => {
      const p = join(dir, 'lifecycle.log')
      if (!existsSync(p)) return []
      return readFileSync(p, 'utf8').split('\n').filter(Boolean)
    },
    waitFor: async (pred, ms) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (pred()) return true
        await Bun.sleep(25)
      }
      return pred()
    },
  } as Harness
}

describe('dashboard token rotation (DIVE-3810)', () => {
  test('a token rotated under a running plugin is picked up — inbound recovers with no restart', async () => {
    const h = await start([{ id: 1, text: 'before the rotation' }])
    try {
      expect(await h.waitFor(() => h.delivered.includes('before the rotation'), BOOT_MS + 8_000)).toBe(true)

      // Pairing a phone: connectord.env is rewritten while this process runs.
      h.rotate(NEW_TOKEN)
      h.enqueue([{ id: 2, text: 'after the rotation' }])
      h.nudge()

      // On the shipped code this never arrives: the plugin 401s every collect
      // until someone restarts the agent.
      expect(await h.waitFor(() => h.delivered.includes('after the rotation'), 15_000)).toBe(true)
      // And it was actually rejected first — otherwise this passes for the
      // trivial reason that the stale credential still worked.
      expect(h.rejected).toBeGreaterThan(0)
    } finally {
      h.stop()
    }
  }, 40_000)

  test('the agent can still SPEAK after the rotation — the mute half of the same defect', async () => {
    const h = await start([])
    try {
      await h.waitFor(() => h.pendingHits >= 1, BOOT_MS + 8_000)
      h.rotate(NEW_TOKEN)
      h.reply('are you still there?')
      expect(await h.waitFor(() => h.events.length >= 1, 15_000)).toBe(true)
      expect(h.events[0].body).toBe('are you still there?')
    } finally {
      h.stop()
    }
  }, 40_000)

  test('the failure reaches a file on the box, and one episode writes one record', async () => {
    // The row's second requirement: a stderr line that goes down the stdio
    // socket into the harness is written nowhere and is not a signal. A
    // credential that is dead for good must leave a readable trace, and a
    // 5-minute poll against a dead credential must not fill the log with it.
    //
    // The message is enqueued only AFTER the credential is dead, so its arrival
    // can only come from the reload. Enqueuing it before boot makes the final
    // assertion pass on the boot drain and grades nothing.
    const h = await start([])
    try {
      expect(await h.waitFor(() => h.pendingHits >= 1, BOOT_MS + 8_000)).toBe(true)

      // Rotate the CONTROL PLANE only, leaving a stale token on disk: a reload
      // cannot fix this one. That is the genuinely-broken case, and it is the
      // one that has to be legible after the fact.
      h.rotate(NEW_TOKEN)
      writeFileSync(join(h.dir, 'connectord.env'), `CONNECTORD_TOKEN=${OLD_TOKEN}\n`)
      h.enqueue([{ id: 1, text: 'arrives only after the reload' }])
      const before = h.rejected
      h.nudge()
      expect(await h.waitFor(() => h.rejected > before, 10_000)).toBe(true)
      expect(await h.waitFor(() => h.lifecycleLines().some(l => l.includes('\tauth\t')), 10_000)).toBe(true)
      expect(h.delivered).not.toContain('arrives only after the reload')

      const auth = h.lifecycleLines().filter(l => l.includes('\tauth\t'))
      expect(auth.length).toBe(1)
      expect(auth[0]).toContain('dashboard')
      expect(auth[0]).toMatch(/deaf and mute/)

      // A second nudge against the same dead credential is the same episode,
      // not a second record — otherwise the 5-minute poll turns the log into
      // one line per poll for as long as the box lives.
      h.nudge()
      await Bun.sleep(2_000)
      expect(h.lifecycleLines().filter(l => l.includes('\tauth\t')).length).toBe(1)

      // And when the on-disk token catches up, the channel recovers with no
      // restart and the recovery is recorded too — an episode that only ever
      // opens cannot be read as closed.
      writeFileSync(join(h.dir, 'connectord.env'), `CONNECTORD_TOKEN=${NEW_TOKEN}\n`)
      h.nudge()
      expect(await h.waitFor(() => h.delivered.includes('arrives only after the reload'), 15_000)).toBe(true)
      const auth2 = h.lifecycleLines().filter(l => l.includes('\tauth\t'))
      expect(auth2.length).toBe(2)
      expect(auth2[1]).toMatch(/rotated on disk/)
    } finally {
      h.stop()
    }
  }, 60_000)

  test('ALL THREE control-plane calls go through the reloading path, not just the one driven above', () => {
    // Arming one call site is not arming the caller: collect, ack and the
    // outbound reply each carry the credential, and a fix applied to the one a
    // test happens to drive leaves the channel half broken. Assert it of the
    // source, because no single scenario reaches all three.
    const src = readFileSync(SERVER, 'utf8')
    for (const route of [
      '/server/messages/pending?agent=',
      '/server/messages/pending/ack',
      '/server/messages/event',
    ]) {
      // Only the occurrences that are actually a URL — every real call builds
      // it as `${API_BASE}<route>`. Matching the first mention instead would
      // grade the file header, which names two of these routes in prose.
      const sites: number[] = []
      for (let i = src.indexOf(route); i > -1; i = src.indexOf(route, i + 1)) {
        if (src.slice(i - '${API_BASE}'.length, i) === '${API_BASE}') sites.push(i)
      }
      expect(sites.length).toBeGreaterThan(0)
      for (const at of sites) {
        // The call that owns this route must be an authedFetch. Look back from
        // the route to the nearest fetch-ish call, and check which one it is.
        const before = src.slice(Math.max(0, at - 400), at)
        expect(before.lastIndexOf('authedFetch(')).toBeGreaterThan(before.lastIndexOf('await fetch('))
      }
    }
    // And the bearer header is built in exactly ONE place — the helper.
    expect(src.split('authorization: `Bearer ${TOKEN}`').length - 1).toBe(1)
    // The token must stay mutable: a `const` here is the whole defect.
    expect(src).toMatch(/\nlet TOKEN = loadConnectordToken\(\)/)
  })
})
