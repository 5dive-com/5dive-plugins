#!/usr/bin/env -S bun
// PreToolUse hook for telegram-relayed claude agents.
//
// Why: AskUserQuestion (numbered-options picker) and ExitPlanMode
// (plan-approval picker) render in the local tmux pane only — Telegram
// users never see them, and the agent blocks waiting for keyboard input
// that never arrives. Deny these tool calls with feedback instructing
// claude to inline the question/plan in a normal Telegram reply.
//
// Also stamps the silence-watchdog last-seen file so an external
// idle-ping cron (if any) can detect when the agent has gone quiet.
// No-op if the channels dir hasn't been created yet.

import { writeFileSync } from 'fs'
import { join } from 'path'
import { readPayload } from './lib/payload'
import { STATE_DIR } from './lib/paths'
import { emitDenyTool } from './lib/output'
import type { HookPayload } from './lib/types'

const payload = await readPayload<HookPayload>()

if (payload.tool_name === 'AskUserQuestion' || payload.tool_name === 'ExitPlanMode') {
  const tool = payload.tool_name
  emitDenyTool(
    tool,
    `${tool} is blocked in this Telegram-paired session: its picker UI renders only in the local terminal, so the Telegram user cannot see or respond to it and the session will hang.\n\nInstead, send your question (or plan) as a regular Telegram message via mcp__plugin_telegram_telegram__reply, with options written as numbered lines. Then wait for the user's next telegram message — that reply is the answer.`,
  )
}

try {
  writeFileSync(join(STATE_DIR, 'last-seen'), String(Date.now()))
} catch {
  // STATE_DIR may not exist (plugin loaded but never paired). Silent skip.
}

process.exit(0)
