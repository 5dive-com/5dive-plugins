import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChannelDispatcher,
  parseOutboundMessage,
  type DispatchMessage,
  type DispatcherState,
  type RpcPort,
} from '../plugins/telegram-codex/dispatcher-core.ts'
import { writeDispatcherInbox } from '../plugins/dashboard/dispatcher-inbox.ts'

const telegram = (id: string, text = id): DispatchMessage => ({
  id,
  text,
  route: { source: 'telegram', chat_id: '42' },
})

function harness(initial: DispatcherState | null = null) {
  let saved = initial ? structuredClone(initial) : null
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const published: Array<{ route: any; text: string; meta: any }> = []
  let nextTurn = 1
  let failTurnStart = false
  const rpc: RpcPort = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'thread/resume') return { thread: { id: params.threadId } }
      if (method === 'turn/start') {
        if (failTurnStart) throw new Error('app-server unavailable')
        return { turn: { id: `turn-${nextTurn++}` } }
      }
      if (method === 'turn/steer') return { turnId: params.expectedTurnId }
      throw new Error(`unexpected ${method}`)
    },
  }
  const dispatcher = new ChannelDispatcher(
    rpc,
    {
      load: () => saved ? structuredClone(saved) : null,
      save: state => { saved = structuredClone(state) },
    },
    {
      publish: async (route, text, meta) => { published.push({ route, text, meta }) },
    },
    '/workspace',
  )
  return {
    dispatcher,
    requests,
    published,
    setFailTurnStart(value: boolean) { failTurnStart = value },
  }
}

describe('Codex app-server channel dispatcher', () => {
  test('extracts absolute attachment directives without leaking them into chat text', () => {
    expect(parseOutboundMessage('Report attached.\n[[5dive-attachment:/tmp/report.pdf]]')).toEqual({
      text: 'Report attached.', files: ['/tmp/report.pdf'],
    })
    expect(parseOutboundMessage('keep [[5dive-attachment:relative.txt]] inline')).toEqual({
      text: 'keep [[5dive-attachment:relative.txt]] inline', files: [],
    })
  })

  test('idle inbound starts a turn without model-owned polling', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    expect(await h.dispatcher.submit(telegram('tg-1', 'hello'))).toBe('started')

    expect(h.requests.map(r => r.method)).toEqual(['thread/start', 'turn/start'])
    expect(h.requests[1]?.params).toMatchObject({
      threadId: 'thread-1',
      clientUserMessageId: 'tg-1',
      turnTrigger: '5dive:telegram',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    })
    expect(h.requests[0]?.params).not.toHaveProperty('approvalPolicy')
    expect(h.requests[0]?.params).not.toHaveProperty('sandbox')
  })

  test('same-route input steers an active turn and another route waits', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    expect(await h.dispatcher.submit(telegram('tg-2'))).toBe('steered')
    expect(await h.dispatcher.submit({
      id: 'dash-1', text: 'dashboard', route: { source: 'dashboard', chat_id: 'dashboard' },
    })).toBe('queued')

    expect(h.requests[2]?.method).toBe('turn/steer')
    expect(h.requests[2]?.params).toMatchObject({ expectedTurnId: 'turn-1', clientUserMessageId: 'tg-2' })
    await h.dispatcher.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } })
    expect(h.requests.at(-1)).toMatchObject({ method: 'turn/start', params: { clientUserMessageId: 'dash-1' } })
  })

  test('streamed agent messages return only to the active source route', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    await h.dispatcher.notification('item/agentMessage/delta', {
      turnId: 'turn-1', itemId: 'item-1', delta: 'hello ',
    })
    await h.dispatcher.notification('item/agentMessage/delta', {
      turnId: 'turn-1', itemId: 'item-1', delta: 'there',
    })
    await h.dispatcher.notification('item/completed', {
      turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage' },
    })

    expect(h.published).toEqual([{
      route: { source: 'telegram', chat_id: '42' },
      text: 'hello there',
      meta: { turnId: 'turn-1', itemId: 'item-1', kind: 'message' },
    }])
  })

  test('restart resumes the thread, reports the interrupted turn, and drains queued work', async () => {
    const h = harness({
      threadId: 'thread-old',
      seen: ['tg-active'],
      active: {
        turnId: 'turn-old', routeKey: 'telegram:42:', route: telegram('tg-active').route,
        message: telegram('tg-active'),
      },
      pending: [{ id: 'dash-1', text: 'next', route: { source: 'dashboard', chat_id: 'dashboard' } }],
    })
    await h.dispatcher.initialize()

    expect(h.requests.map(r => r.method)).toEqual(['thread/resume', 'turn/start'])
    expect(h.published[0]?.text).toMatch(/restarted before the previous turn completed/i)
    expect(h.dispatcher.snapshot().active?.message.id).toBe('dash-1')
  })

  test('duplicate delivery ids never start or steer twice', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    await h.dispatcher.submit(telegram('tg-1'))
    expect(await h.dispatcher.submit(telegram('tg-1'))).toBe('duplicate')
    expect(h.requests.filter(r => r.method.startsWith('turn/'))).toHaveLength(1)
  })

  test('dispatcher failure leaves input retryable', async () => {
    const h = harness()
    await h.dispatcher.initialize()
    h.setFailTurnStart(true)
    await expect(h.dispatcher.submit(telegram('tg-retry'))).rejects.toThrow('app-server unavailable')
    expect(h.dispatcher.snapshot().seen).not.toContain('tg-retry')
    expect(h.dispatcher.snapshot().active).toBeUndefined()

    h.setFailTurnStart(false)
    expect(await h.dispatcher.submit(telegram('tg-retry'))).toBe('started')
  })

  test('dashboard adapter reports a synchronous spool failure as a rejection', async () => {
    let renamed = false
    const delivery = writeDispatcherInbox('/tmp/inbox.tmp', '/tmp/inbox.json', { text: 'hello' }, {
      write() { throw new Error('disk full') },
      rename() { renamed = true },
    })

    await expect(delivery).rejects.toThrow('disk full')
    expect(renamed).toBe(false)
  })

  test('dispatcher-mode boot writes a lifecycle start record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3960-lifecycle-'))
    const stateDir = join(dir, 'state')
    const fakeCodex = join(dir, 'fake-codex.ts')
    writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id == null) return
  const result = request.method === 'thread/start'
    ? { thread: { id: 'thread-lifecycle-test' } }
    : {}
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
})
`)
    chmodSync(fakeCodex, 0o755)

    const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'plugins', 'telegram-codex', 'dispatcher.ts')], {
      cwd: dir,
      env: {
        ...process.env,
        CODEX_BIN: fakeCodex,
        CODEX_DISPATCHER_CHANNELS: '',
        CODEX_DISPATCHER_STATE_DIR: stateDir,
        CODEX_DISPATCHER_WORKDIR: dir,
      },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })

    try {
      const record = join(stateDir, 'lifecycle.log')
      const deadline = Date.now() + 10_000
      let body = ''
      while (Date.now() < deadline) {
        try { body = readFileSync(record, 'utf8') } catch {}
        if (body.includes('\tstart\tcodex-dispatcher\t')) break
        await Bun.sleep(50)
      }
      expect(body).toContain('\tstart\tcodex-dispatcher\t')
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGTERM')
      await child.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  test('package entrypoint makes dispatcher primary and retains MCP fallback', async () => {
    const pkg = await Bun.file(new URL('../plugins/telegram-codex/package.json', import.meta.url)).json()
    const entry = await Bun.file(new URL('../plugins/telegram-codex/dispatcher.ts', import.meta.url)).text()
    expect(pkg.scripts.start).toBe('bun dispatcher.ts')
    expect(pkg.scripts['start:mcp-fallback']).toBe('bun server.ts')
    expect(pkg.files).toContain('dispatcher-core.ts')
    expect(pkg.files).toContain('lifecycle.ts')
    expect(entry).toContain("'-c', 'mcp_servers={}'")
    expect(entry).not.toContain('mcp_servers.telegram.enabled')
  })
})
