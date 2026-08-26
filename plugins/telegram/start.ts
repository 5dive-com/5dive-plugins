// plugins/telegram/start.ts — the launcher's VOICE (DIVE-3752).
//
// [[no-beacon-has-three-states-and-only-the-process-table-separates-them]]
// measured the shape of the 2026-08-26 outage: three seats, INCLUDING the
// coordinator, deaf for 2h33m with 9 human gates pending, and the only signal
// available to a human or to the DIVE-1434 canary was an ABSENT heartbeat. An
// absence cannot say which of three failures produced it — the channel never
// started, a dependency step ate the poller, or the poller is up and not
// bumping — and the launcher's stderr goes nowhere either of them reads. A
// failure encoded as *nothing there* is the same defect as
// [[absence-encoded-as-a-value-is-read-as-presence]].
//
// This file is the smallest thing that can speak. It is the `start` script's
// entry point instead of `server.ts`, and it imports NOTHING but node builtins
// and ./lifecycle.ts — so it still loads, and can still write a record, in
// exactly the case `server.ts` cannot: when `server.ts` throws on import
// because its dependencies are missing. That case used to be silent.
//
// Read the records with:  tail ~/.claude/channels/telegram/lifecycle.log

import { homedir } from 'node:os'
import { join } from 'node:path'
import { recordLifecycle } from './lifecycle.ts'

const CHANNEL = 'telegram'
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')

recordLifecycle(STATE_DIR, 'start', CHANNEL, 'launcher: loading server.ts')

try {
  // Never resolves while the server is healthy — `server.ts` ends in a
  // top-level `await mcp.connect(...)`. It rejects when the module fails to
  // load, which is the whole point of catching it here.
  await import('./server.ts')
} catch (err) {
  recordLifecycle(STATE_DIR, 'crash', CHANNEL, `launcher: server.ts failed to load: ${err}`)
  process.exit(1)
}
