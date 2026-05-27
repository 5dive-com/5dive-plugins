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

Write `~/.codex/channels/telegram/access.json` with the chat/user IDs
allowed to talk to your bot:

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
reach `wait_for_message`.

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

**6. Run Codex**

```sh
codex
```

DM your bot. Codex calls `wait_for_message`, your DM resolves it, Codex
replies via the `reply` tool. Done.

## Differences from the Claude Code build

| Concern               | `telegram/` (Claude Code)              | `telegram-codex/` (this)         |
| --------------------- | -------------------------------------- | -------------------------------- |
| Inbound delivery      | `claude/channel` JSON-RPC notification | `wait_for_message` blocking tool |
| Permission relay      | `claude/channel/permission` protocol   | not yet (planned for v0.2)       |
| Slash commands        | `/telegram:configure`, `:access`, …    | not yet (Codex plugin API TBD)   |
| Lifecycle hooks       | PreToolUse, Stop, etc.                 | wire `[notify]` in config.toml   |
| State dir             | `~/.claude/channels/telegram/`         | `~/.codex/channels/telegram/`    |
| Pairing flow          | code via DM → `/telegram:access pair`  | preconfigured `access.json` only |

## Roadmap

- v0.1.x — outbound + blocking inbound, preconfigured allowlist (this)
- v0.2.0 — pairing flow (CLI: `bunx telegram-codex pair <code>`)
- v0.2.0 — `notify` integration for "Codex went idle / errored" pings
- v0.3.0 — approval-mode bridge so risky-command y/n prompts route to TG
