import { readFileSync, renameSync, writeFileSync } from 'fs'
import { SILENCE_FILE } from './paths'
import type { SilenceState } from './types'

export function loadSilence(): SilenceState {
  try {
    return JSON.parse(readFileSync(SILENCE_FILE, 'utf8')) as SilenceState
  } catch {
    return {}
  }
}

// Atomic write via tmp + rename so a concurrent reader (the MCP server)
// never sees a half-written file.
export function saveSilence(state: SilenceState): void {
  const tmp = `${SILENCE_FILE}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, SILENCE_FILE)
  } catch {
    // best-effort: a write failure here just means the next hook fire
    // reads stale state — not worth crashing the agent over.
  }
}
