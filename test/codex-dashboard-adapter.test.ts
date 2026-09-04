import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'plugins', 'dashboard', 'server.ts')
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  expect(predicate()).toBe(true)
}

describe('Codex dashboard adapter end to end', () => {
  test('spools pending and durable drops, ACKs, preserves routing, and sends attachments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-dashboard-adapter-'))
    const dashboardState = join(root, '.claude', 'channels', 'dashboard')
    const dispatcherState = join(root, '.codex', 'channels', 'dispatcher')
    const sharedOutbox = join(root, 'downloads')
    mkdirSync(sharedOutbox, { recursive: true })
    const attachment = join(root, 'report.txt')
    writeFileSync(attachment, 'dashboard attachment\n')

    let pending = [{
      id: 71, text: 'queued while offline', from: 'owner', chat_id: 'dashboard',
      image_path: '/tmp/inbound.png',
    }]
    const acknowledgements: number[][] = []
    const outbound: any[] = []
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/server/messages/pending') return Response.json({ pending })
        if (url.pathname === '/server/messages/pending/ack') {
          const body = await req.json() as { ids: number[] }
          acknowledgements.push(body.ids)
          pending = pending.filter(message => !body.ids.includes(message.id))
          return Response.json({ ok: true })
        }
        if (url.pathname === '/server/messages/event') {
          outbound.push(await req.json())
          return Response.json({ id: 99 })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const child = Bun.spawn(['bun', SERVER], {
      env: {
        ...process.env,
        CODEX_DISPATCHER_ADAPTER: 'dashboard',
        CODEX_DISPATCHER_STATE_DIR: dispatcherState,
        DASHBOARD_STATE_DIR: dashboardState,
        DASHBOARD_OUTBOX: sharedOutbox,
        DASHBOARD_API_BASE: `http://127.0.0.1:${api.port}`,
        CONNECTORD_TOKEN: 'test-token-abcdefghijkl',
        USER: 'agent-codexdash',
      },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    cleanups.push(() => { child.kill(); api.stop(true); rmSync(root, { recursive: true, force: true }) })

    const dispatcherInbox = join(dispatcherState, 'inbox')
    await waitFor(() => existsSync(dispatcherInbox) && readdirSync(dispatcherInbox).length === 1)
    expect(acknowledgements).toEqual([[71]])
    const first = JSON.parse(readFileSync(join(dispatcherInbox, readdirSync(dispatcherInbox)[0]!), 'utf8'))
    expect(first).toMatchObject({
      id: 'dashboard:pending:71', text: 'queued while offline', image_path: '/tmp/inbound.png',
      route: { source: 'dashboard', chat_id: 'dashboard' },
    })

    const agentInbox = join(dashboardState, 'agent-inbox')
    const tmp = join(agentInbox, '.drop.tmp')
    writeFileSync(tmp, JSON.stringify({ text: 'live dashboard drop', chat_id: 'dashboard' }))
    renameSync(tmp, join(agentInbox, 'drop.json'))
    await waitFor(() => readdirSync(dispatcherInbox).length === 2)
    const inboxBodies = readdirSync(dispatcherInbox)
      .map(name => JSON.parse(readFileSync(join(dispatcherInbox, name), 'utf8')))
    expect(inboxBodies.some(message => message.id === 'dashboard:drop:drop.json'
      && message.route?.source === 'dashboard')).toBe(true)

    const dispatcherOutbox = join(dispatcherState, 'outbox', 'dashboard')
    const outTmp = join(dispatcherOutbox, '.reply.tmp')
    writeFileSync(outTmp, JSON.stringify({
      source: 'dashboard', chat_id: 'dashboard', text: 'Here is the report.', files: [attachment],
    }))
    renameSync(outTmp, join(dispatcherOutbox, 'reply.json'))
    await waitFor(() => outbound.length === 1)
    expect(outbound[0]).toMatchObject({
      agent: 'codexdash', body: 'Here is the report.', metadata: { chat_id: 'dashboard' },
    })
    const delivered = outbound[0].metadata.files[0]
    expect(delivered).toStartWith(`${sharedOutbox}/codexdash-`)
    expect(readFileSync(delivered, 'utf8')).toBe('dashboard attachment\n')
  }, 10_000)
})
