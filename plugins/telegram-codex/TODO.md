# telegram-codex roadmap

Parity with `plugins/telegram/` (the Claude Code build) is the goal. Items
ordered by UX criticality unless noted.

## Up next

## Still open

- 5dive `--channels=telegram` codex provisioning (handed off to main).
- ExecStopPost in 5dive's systemd unit for true crash-aware notification.

## Won't port

These don't translate to Codex's runtime, mentioned for completeness:

- `claude/channel/permission_request` protocol — we use a hook-based
  bridge instead (shipped in v0.1.3).
- `/checkpoint`, `/resume` slash commands — Claude-specific session
  persistence. Codex has its own `codex resume` CLI.
- `pretool-question.ts` — blocks `AskUserQuestion` / `ExitPlanMode` in
  Claude. Codex has no equivalent tools.

## Shipped

- v0.1.0 — outbound + blocking inbound, preconfigured allowlist
- v0.1.1 — `Stop` hook for turn-complete pings
- v0.1.2 — `bun pair.ts` pairing CLI
- v0.1.3 — `PermissionRequest` → Telegram approval bridge with inline buttons
- v0.1.4 — bot slash commands (`/help`, `/status`, `/ping`) + setMyCommands;
  `wait_for_message` capped at 90s (Codex's MCP tool-call timeout)
- v0.1.5 — `reply` chunks text >4000 chars across multiple messages
- v0.1.6 — Stop hook suppresses ping when `reply` was sent in the last 30s
  (override via `CODEX_NOTIFY_SUPPRESS_MS`)
- v0.1.7 — typing indicator (`startTypingLoop`/`stopTypingLoop`) between
  `wait_for_message` dequeue and `reply`; 5min ceiling
- v0.1.8 — silence watchdog `PreToolUse` hook (`CODEX_SILENCE_WATCHDOG_MS`,
  default 120000); single ping per silence window
- v0.1.9 — `Notification` hook relays error-flavored notifications to
  Telegram (`CODEX_NOTIFY_RELAY_ALL=1` to relay everything; pattern match
  on error/failed/timeout/rate-limit etc. by default). True crash-aware
  notification still pending — needs ExecStopPost in 5dive's unit (main's
  territory).
- v0.1.10 — `/stop` (tmux C-c) + `/restart` (`5dive agent restart`) bot
  commands.
- v0.1.11 — `/agents` bot command (wraps `5dive agent list --json`,
  marks self).
- v0.2.0 — configurable `access.json` knobs: `ackReaction`,
  `textChunkLimit`, `dmPolicy`.
- v0.2.1 — `notify-user` SKILL.md ported from the Claude build,
  adapted for Codex's `wait_for_message`/`reply` loop semantics.
