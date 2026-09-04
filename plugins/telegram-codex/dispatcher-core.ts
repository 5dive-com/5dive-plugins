export type DispatchSource = 'telegram' | 'dashboard' | 'agent'

export type DispatchRoute = {
  source: DispatchSource
  chat_id: string
  message_thread_id?: string
}

export type DispatchMessage = {
  id: string
  text: string
  route: DispatchRoute
  image_path?: string
  received_at?: string
}

export type DispatcherState = {
  threadId?: string
  seen: string[]
  pending: DispatchMessage[]
  active?: { turnId: string; routeKey: string; route: DispatchRoute; message: DispatchMessage }
}

export interface RpcPort {
  request(method: string, params: Record<string, unknown>): Promise<any>
}

export interface StateStore {
  load(): DispatcherState | null
  save(state: DispatcherState): void
}

export interface DispatchSink {
  publish(route: DispatchRoute, text: string, meta: { turnId: string; itemId?: string; kind: 'message' | 'error' }): Promise<void>
}

const MAX_SEEN = 512
const ATTACHMENT_LINE = /^\[\[5dive-attachment:(\/[^\]\r\n]+)\]\]$/

export function parseOutboundMessage(raw: string): { text: string; files: string[] } {
  const files: string[] = []
  const lines = raw.split(/\r?\n/).filter(line => {
    const match = line.trim().match(ATTACHMENT_LINE)
    if (!match) return true
    if (files.length < 10 && !files.includes(match[1]!)) files.push(match[1]!)
    return false
  })
  return { text: lines.join('\n').trim(), files }
}

function routeKey(route: DispatchRoute): string {
  return `${route.source}:${route.chat_id}:${route.message_thread_id ?? ''}`
}

function inputFor(message: DispatchMessage): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [{ type: 'text', text: message.text, text_elements: [] }]
  if (message.image_path?.startsWith('/')) input.push({ type: 'localImage', path: message.image_path })
  return input
}

/**
 * The transport-independent part of the Codex channel dispatcher.
 *
 * One source conversation owns a turn. More input from that same source steers
 * the active turn; input from a different source waits for the next turn. This
 * is deliberately stricter than broadcasting one turn to every channel: a
 * Telegram response must never leak into dashboard chat (or vice versa).
 */
export class ChannelDispatcher {
  private state: DispatcherState
  private serial: Promise<unknown> = Promise.resolve()
  private itemText = new Map<string, string>()

  constructor(
    private readonly rpc: RpcPort,
    private readonly store: StateStore,
    private readonly sink: DispatchSink,
    private readonly cwd: string,
  ) {
    this.state = store.load() ?? { seen: [], pending: [] }
  }

  snapshot(): DispatcherState {
    return structuredClone(this.state)
  }

  async initialize(): Promise<void> {
    await this.enqueueSerial(async () => {
      const interrupted = this.state.active
      this.state.active = undefined
      if (this.state.threadId) {
        try {
          await this.rpc.request('thread/resume', { threadId: this.state.threadId })
        } catch {
          this.state.threadId = undefined
        }
      }
      if (!this.state.threadId) {
        const started = await this.rpc.request('thread/start', {
          cwd: this.cwd,
          serviceName: '5dive-channel-dispatcher',
          developerInstructions:
            'Messages arrive from 5dive channels. Respond normally in assistant messages; the dispatcher routes those messages back to the originating channel. Do not call wait_for_message or channel reply tools. To attach a local file, include a separate [[5dive-attachment:/absolute/path]] line after a non-empty caption; the dispatcher removes the directive and sends the file only to the originating channel.',
        })
        const id = started?.thread?.id
        if (typeof id !== 'string' || !id) throw new Error('thread/start returned no thread id')
        this.state.threadId = id
      }
      this.persist()
      if (interrupted) {
        await this.sink.publish(
          interrupted.route,
          'The local Codex dispatcher restarted before the previous turn completed. Please resend that message if you still need a response.',
          { turnId: interrupted.turnId, kind: 'error' },
        )
      }
      await this.startNext()
    })
  }

  async submit(message: DispatchMessage): Promise<'started' | 'steered' | 'queued' | 'duplicate'> {
    return this.enqueueSerial(async () => {
      if (this.state.seen.includes(message.id) || this.state.pending.some(m => m.id === message.id)
        || this.state.active?.message.id === message.id) return 'duplicate'

      if (this.state.active) {
        if (this.state.active.routeKey !== routeKey(message.route)) {
          this.state.pending.push(message)
          this.persist()
          return 'queued'
        }
        const result = await this.rpc.request('turn/steer', {
          threadId: this.requireThread(),
          expectedTurnId: this.state.active.turnId,
          clientUserMessageId: message.id,
          input: inputFor(message),
        })
        if (result?.turnId !== this.state.active.turnId) {
          throw new Error('turn/steer did not confirm the active turn')
        }
        this.markSeen(message.id)
        this.persist()
        return 'steered'
      }

      await this.startMessage(message)
      return 'started'
    })
  }

  async notification(method: string, params: any): Promise<void> {
    await this.enqueueSerial(async () => {
      if (method === 'item/agentMessage/delta') {
        const key = `${params?.turnId ?? ''}:${params?.itemId ?? ''}`
        this.itemText.set(key, (this.itemText.get(key) ?? '') + String(params?.delta ?? ''))
        return
      }
      if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
        const turnId = String(params?.turnId ?? '')
        if (!this.state.active || this.state.active.turnId !== turnId) return
        const itemId = String(params?.item?.id ?? '')
        const key = `${turnId}:${itemId}`
        const text = String(params.item.text ?? this.itemText.get(key) ?? '').trim()
        this.itemText.delete(key)
        if (text) await this.sink.publish(this.state.active.route, text, { turnId, itemId, kind: 'message' })
        return
      }
      if (method === 'turn/completed') {
        const turnId = String(params?.turn?.id ?? '')
        if (!this.state.active || this.state.active.turnId !== turnId) return
        const completed = this.state.active
        this.state.active = undefined
        if (params?.turn?.status !== 'completed') {
          const detail = String(params?.turn?.error?.message ?? params?.turn?.status ?? 'unknown app-server error')
          await this.sink.publish(completed.route, `Codex could not complete this turn: ${detail}`, {
            turnId, kind: 'error',
          })
        }
        for (const key of this.itemText.keys()) {
          if (key.startsWith(`${turnId}:`)) this.itemText.delete(key)
        }
        this.persist()
        await this.startNext()
      }
    })
  }

  private async startMessage(message: DispatchMessage): Promise<void> {
    const result = await this.rpc.request('turn/start', {
      threadId: this.requireThread(),
      clientUserMessageId: message.id,
      turnTrigger: `5dive:${message.route.source}`,
      input: inputFor(message),
    })
    const turnId = result?.turn?.id
    if (typeof turnId !== 'string' || !turnId) throw new Error('turn/start returned no turn id')
    this.state.active = { turnId, routeKey: routeKey(message.route), route: message.route, message }
    this.markSeen(message.id)
    this.persist()
  }

  private async startNext(): Promise<void> {
    if (this.state.active || this.state.pending.length === 0) return
    const next = this.state.pending.shift()!
    this.persist()
    try {
      await this.startMessage(next)
    } catch (err) {
      this.state.pending.unshift(next)
      this.persist()
      throw err
    }
  }

  private markSeen(id: string): void {
    this.state.seen.push(id)
    if (this.state.seen.length > MAX_SEEN) this.state.seen.splice(0, this.state.seen.length - MAX_SEEN)
  }

  private requireThread(): string {
    if (!this.state.threadId) throw new Error('dispatcher thread is not initialized')
    return this.state.threadId
  }

  private persist(): void {
    this.store.save(this.state)
  }

  private enqueueSerial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn, fn)
    this.serial = next.then(() => undefined, () => undefined)
    return next
  }
}
