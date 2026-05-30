# telegram-agy roadmap

Parity with `plugins/telegram/` (the Claude Code build) is the goal,
forked from `plugins/telegram-grok/` because Antigravity (`agy`) shares
the same poll-based inbound model (no Claude-Code `channel` push
protocol) — inbound arrives via the blocking `wait_for_message` tool.

## Up next

- **5dive provisioning** (main's lane): first-class
  `5dive agent <name> --type=antigravity --channels=telegram`. Needs the
  agent-create path to (a) add antigravity to the channel-capable list,
  (b) **seed the OAuth cred into the agent home** — `5dive agent auth
  login antigravity` writes `~/.gemini/antigravity-cli/antigravity-oauth-token`
  for the *host* (claude) user, not the agent, so headless `agy` boots to
  a Google login screen until that file is copied into
  `~agent-<name>/.gemini/antigravity-cli/` (chown, mode 600). Same gap
  grok's `auth.json` had.

## Still open

- **Hook firing under agy is unconfirmed.** `agy plugin validate` accepts
  all events (PreToolUse/PostToolUse/Stop/Notification/…) and the plugin
  installs them, but probe hooks did not fire under headless `agy -p`
  (no exec, no log). Likely TUI-only or wired differently — needs a live
  TUI verification. Until confirmed, keepalive does NOT rely on a Stop
  hook: the MCP server's own re-arm watchdog (tmux send-keys to session
  `agent-<name>` after idle) re-kicks the `wait_for_message` loop. The
  silence-watchdog is opt-in (`AGY_SILENCE_WATCHDOG_ENABLED=1`) anyway.
- ExecStopPost in 5dive's systemd unit for true crash-aware notification.

## agy plugin-runtime quirks (verified 2026-05-30, agy 1.0.3)

- **Plugin layout differs from Claude Code:** `plugin.json` at the plugin
  **root** (not `.claude-plugin/`), and **`mcp_config.json`** (not
  `.mcp.json`). `hooks/hooks.json` + `skills/<name>/SKILL.md` are the
  same shape as Claude. Validate with `agy plugin validate <path>`;
  install with `agy plugin install <path>` → copies to
  `~/.gemini/config/plugins/<name>/`.
- **Runtime plugin discovery only auto-wires skills + agents — NOT mcp
  servers or hooks.** So the MCP server must be declared in the **global**
  `~/.gemini/config/mcp_config.json` with an **absolute** `--cwd` pointing
  at the installed plugin dir. (Same absolute-path lesson as grok.)
- The global `~/.gemini/config/mcp_config.json` ships **empty (0 bytes)**;
  agy logs `unexpected end of JSON input` and MCP discovery breaks until
  it holds a valid `{"mcpServers":{…}}`.
- Default model is Gemini 3.5 Flash. The `wait_for_message → reply` loop
  works: agy re-enters `wait_for_message` autonomously after each turn.

## Won't port

These don't translate to agy's runtime, mentioned for completeness:

- **Permission/approval bridge** — agy launches with
  `--dangerously-skip-permissions`, so there are no prompts to bridge.
- `claude/channel/permission_request` protocol — Claude-Code specific.
- `/checkpoint`, `/resume` slash commands — Claude-specific session
  persistence. agy has `--continue` / `--conversation <id>`.
- `pretool-question.ts` — blocks `AskUserQuestion` / `ExitPlanMode` in
  Claude; agy has no equivalent tools.

## Shipped

- v0.1.0 — initial fork from `telegram-grok` adapted to Antigravity (agy):
  - outbound + blocking inbound (`wait_for_message`, default/max 50s),
    `reply`/`edit_message`/`react`/`download_attachment`, text chunking,
    typing indicator.
  - access control: allowlist + per-group `requireMention`, `bun pair.ts`
    pairing CLI, `access.json` knobs (`ackReaction`, `textChunkLimit`,
    `dmPolicy` incl. `pairing`/pending-code), forum-topic threading.
  - bot slash commands: `/help`, `/status`, `/ping`, `/stop` (tmux C-c),
    `/restart` (`5dive agent restart`), `/agents`, `/tasks`, `/task`,
    `/org`, `/start`.
  - lifecycle hooks (validate-clean; runtime firing TBD):
    `silence-watchdog` (PreToolUse, opt-in), `notify-stop` (Stop),
    `notification-relay` (Notification) — `AGY_*` env knobs, state under
    `~/.gemini/channels/telegram/` (honors `ANTIGRAVITY_HOME`/`GEMINI_HOME`).
  - agy plugin manifests: `plugin.json` (root), `mcp_config.json`,
    `hooks/hooks.json`, `skills/notify-user/`.
  - permission bridge removed (see "Won't port").
  - **verified live**: agy ran the wait_for_message loop end-to-end and
    replied to a real Telegram DM.
