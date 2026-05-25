import { spawnSync } from 'child_process'

// Capture tmux session context from $TMUX + `tmux display`. Returns null on
// any of: no $TMUX env, missing tmux binary, display query failed. Caller
// uses null as "no tmux context, skip tmux-only behavior".
export type TmuxCtx = { socket: string; target: string }

export function getTmuxContext(): TmuxCtx | null {
  const tmuxEnv = process.env.TMUX
  if (!tmuxEnv) return null
  const socket = tmuxEnv.split(',')[0]
  if (!socket) return null
  const r = spawnSync('tmux', ['display', '-p', '#{session_name}:#{window_index}.#{pane_index}'], {
    encoding: 'utf8',
  })
  if (r.status !== 0) return null
  const target = r.stdout.trim()
  if (!target) return null
  return { socket, target }
}

// `tmux capture-pane -p` — read the visible pane contents. Returns '' when
// tmux isn't running or the call failed. Used for last-resort scrapes
// (pre-rate-limit API error lines etc) that the transcript may not carry.
export function capturePane(): string {
  if (!process.env.TMUX) return ''
  const r = spawnSync('tmux', ['capture-pane', '-p'], { encoding: 'utf8' })
  if (r.status !== 0) return ''
  return r.stdout
}

export function capturePaneFor(ctx: TmuxCtx): string {
  const r = spawnSync('tmux', ['-S', ctx.socket, 'capture-pane', '-t', ctx.target, '-p'], {
    encoding: 'utf8',
  })
  if (r.status !== 0) return ''
  return r.stdout
}

export function sendKeys(ctx: TmuxCtx, ...keys: string[]): void {
  spawnSync('tmux', ['-S', ctx.socket, 'send-keys', '-t', ctx.target, ...keys])
}
