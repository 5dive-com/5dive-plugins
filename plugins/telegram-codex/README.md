# telegram-codex MCP

A Telegram bridge for [OpenAI Codex CLI](https://github.com/openai/codex),
delivered as a stdio MCP server.

Sibling to the [`telegram/`](../telegram/) plugin (which targets Claude
Code). Forked rather than shared because the runtime contracts diverge —
Codex has no channel-notification protocol, so inbound delivery here is
poll-based via a `wait_for_message` tool instead of pushed via channels.

## What you get

Five MCP tools available to Codex:

- `wait_for_message` — block until the user sends a DM/group message.
- `reply` — send a new Telegram message (text, MarkdownV2, file attachments).
- `edit_message` — patch a prior bot message in place (silent, no push).
- `react` — emoji reaction on an inbound message.
- `download_attachment` — fetch a file by `file_id` into the local inbox.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Codex CLI](https://github.com/openai/codex) — `npm i -g @openai/codex`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

**1. Install the server**

```sh
git clone https://github.com/5dive-com/5dive-plugins
cd 5dive-plugins/plugins/telegram-codex
bun install
```

**2. Save the bot token**

```sh
mkdir -m 700 -p ~/.codex/channels/telegram
cat > ~/.codex/channels/telegram/.env <<EOF
TELEGRAM_BOT_TOKEN=123456789:AAH...
EOF
chmod 600 ~/.codex/channels/telegram/.env
```

**3. Seed the allowlist**

Two options:

**3a. Pair via the bot (recommended)**

```sh
bun pair.ts
```

The CLI prints `DM @<botname> from your Telegram account within 60s to
pair...`. Send any message to your bot from the Telegram account you
want allowed. The CLI captures your user_id, writes
`~/.codex/channels/telegram/access.json`, and replies "✅ paired" in
the chat.

Re-run anytime to add another user to the allowlist. Conflicts with a
running Codex MCP server (one getUpdates consumer per token) — stop
Codex first, pair, then restart.

**3b. Hand-write access.json**

```json
{
  "allowFrom": ["123456789"],
  "groups": {
    "-1001234567890": { "requireMention": false, "allowFrom": [] }
  }
}
```

- `allowFrom` — Telegram user IDs allowed to DM the bot. In a DM the
  `chat_id` equals the user ID.
- `groups` — group/supergroup chat IDs (negative) and per-group policy.
  - `requireMention: true` only routes messages that `@mention` the bot
    (or quote-reply to it).
  - `allowFrom: []` falls back to the top-level `allowFrom` list; a
    non-empty list overrides per group.

Messages from anyone not on the lists are silently dropped before they
reach `wait_for_message`. Group access can only be configured by
hand-writing access.json — the `pair.ts` CLI handles DMs only.

**4. Wire into Codex**

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.telegram]
command = "bun"
args = ["/absolute/path/to/5dive-plugins/plugins/telegram-codex/server.ts"]
```

**5. Add the comms playbook**

Drop the contents of [`AGENTS.md`](./AGENTS.md) into your
`~/.codex/AGENTS.md` so the model knows when and how to use the tools.

**6a. (Optional) Wire the "approve risky commands from Telegram" bridge**

Codex's `PermissionRequest` hook fires every time it wants to run a command
that exceeds its current `approval_policy` / `sandbox_mode`. The
`request-permission.ts` hook in this plugin routes that prompt to your
Telegram bot — a message with **✅ allow / ❌ deny** inline buttons. Tap one
and Codex proceeds (or doesn't).

```toml
[features]
hooks = true

[[hooks.PermissionRequest]]

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "bun /absolute/path/to/5dive-plugins/plugins/telegram-codex/hooks/request-permission.ts"
timeout = 180
async = false
```

Behavior notes:

- **Fail-closed.** If the MCP server isn't running (no Telegram bridge),
  or no one taps a button before the 120s default timeout, the hook
  returns `deny`. Codex's native UI then takes over — you're never
  silently auto-approved.
- The MCP server must be live for the bridge to work. In practice this
  means Codex must have called at least one telegram tool earlier in the
  session (the MCP server lazy-spawns). For one-shot Codex runs where
  the very first action is privileged, the bridge will fall through to
  Codex's native UI.
- **Hook trust gate.** On the first session after wiring this hook,
  Codex shows a one-time "Hook needs review" TUI prompt. Press `2` (or
  `t`) to trust. Codex persists the decision in `[hooks.state]` of the
  config.
- **Override timeout** with `CODEX_TG_APPROVAL_TIMEOUT_MS` env (range
  5000–600000).
- **Bypass entirely** with `CODEX_TG_APPROVAL_DISABLED=1` env — useful
  for unattended runs where you want Codex's own approval policy to be
  authoritative without going to Telegram.

This is useless if your `approval_policy = "never"` / `sandbox_mode =
"danger-full-access"`. The bridge only matters when Codex actually
needs to ask.

**6b. (Optional) Wire the "turn complete" ping**

To get a Telegram ping every time Codex finishes a turn, add the `Stop`
hook to `~/.codex/config.toml`:

```toml
[features]
hooks = true

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "bun /absolute/path/to/5dive-plugins/plugins/telegram-codex/hooks/notify-stop.ts"
async = false
```

Codex 0.134 doesn't support `async = true` — keep it sync. The hook
fires once per Codex turn and runs in under a second.

Override the message text per-session with `CODEX_NOTIFY_TEXT=...`;
silence pings entirely with `CODEX_NOTIFY_DISABLED=1` (useful when
you're already talking to the bot via `wait_for_message`/`reply` and
the Stop ping would be duplicate).

**7. Run Codex**

```sh
codex
```

DM your bot. Codex calls `wait_for_message`, your DM resolves it, Codex
replies via the `reply` tool. Done.

## Differences from the Claude Code build

| Concern               | `telegram/` (Claude Code)              | `telegram-codex/` (this)         |
| --------------------- | -------------------------------------- | -------------------------------- |
| Inbound delivery      | `claude/channel` JSON-RPC notification | `wait_for_message` blocking tool |
| Permission relay      | `claude/channel/permission` protocol   | `PermissionRequest` hook + buttons |
| Slash commands        | `/telegram:configure`, `:access`, …    | not yet (Codex plugin API TBD)   |
| Lifecycle hooks       | PreToolUse, Stop, etc.                 | `Stop` hook ships in `hooks/`    |
| State dir             | `~/.claude/channels/telegram/`         | `~/.codex/channels/telegram/`    |
| Pairing flow          | code via DM → `/telegram:access pair`  | `bun pair.ts` standalone CLI     |

## Roadmap

- v0.1.0 — outbound + blocking inbound, preconfigured allowlist
- v0.1.1 — `Stop` hook for "turn complete" Telegram ping
- v0.1.2 — pairing CLI (`bun pair.ts`) for one-shot user-id capture
- v0.1.3 — approval-mode bridge: `PermissionRequest` → Telegram buttons
- v0.1.4 — bot slash commands (`/help`, `/status`, `/ping`) + setMyCommands menu; wait_for_message capped at 90s to stay inside Codex's MCP-call timeout
- v0.1.5 — `reply` chunks text >4000 chars across multiple Telegram messages (paragraph→line→word→hard cut), so long Codex outputs no longer fail with 400 Bad Request
- v0.1.6 — Stop hook suppresses the "turn complete" ping when Codex sent a `reply` within the last 30s (the user already knows). Override via `CODEX_NOTIFY_SUPPRESS_MS` env (0 disables suppression)
- v0.1.7 — typing indicator (re-sends `sendChatAction` every 4s between `wait_for_message` and `reply`, with a 5min ceiling) so a thinking Codex looks different from a hung one
- v0.1.8 — silence watchdog `PreToolUse` hook — pings "🟡 still working — N tool calls in, Xs since last reply" when Codex has been silent past `CODEX_SILENCE_WATCHDOG_MS` (default 120000). Single ping per silence window — the hook resets its own clock so spam is impossible.
- v0.1.9 — `Notification` hook relays error-flavored notifications (rate limit, API failure, timeout) to Telegram with a `⚠️ codex: …` prefix. Relay-all override via `CODEX_NOTIFY_RELAY_ALL=1`; disable via `CODEX_NOTIFY_RELAY_DISABLED=1`
- v0.1.10 — `/stop` bot command sends Ctrl-C via tmux to interrupt the current Codex turn; `/restart` invokes `sudo 5dive agent restart <name>` so the systemd unit respawns the session in ~2s. Both gated on allowFrom
- v0.1.11 — `/agents` lists sibling 5dive agents on the host (active/inactive, type, channel, marks self). Wraps `sudo 5dive agent list --json`
- v0.2.0 — configurable knobs in `access.json`: `ackReaction` (emoji on every inbound, off by default), `textChunkLimit` (override the 4000-char chunker cap, range 500–4096), `dmPolicy` (allowlist/static — reserved for forward parity)
- v0.2.1 — `notify-user` skill (`skills/notify-user/SKILL.md`) — Codex-adapted comms playbook covering cadence, the wait_for_message loop, files/images/reactions, the approval bridge, and security. Description trimmed under Codex's 1024-char SKILL.md limit. (this)
