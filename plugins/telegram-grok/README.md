# telegram-grok MCP

A Telegram bridge for [xAI's Grok CLI](https://x.ai), delivered as a stdio
MCP server.

Sibling to the [`telegram/`](../telegram/) plugin (Claude Code) and
[`telegram-codex/`](../telegram-codex/) (OpenAI Codex). Forked from the
Codex build because Grok shares its runtime contract: Grok has no
Claude-Code `channel` push protocol, so inbound delivery is **poll-based**
via a `wait_for_message` tool rather than pushed.

## What you get

Five MCP tools available to Grok:

- `wait_for_message` — block until the user sends a DM/group message.
- `reply` — send a new Telegram message (text, MarkdownV2, file attachments).
- `edit_message` — patch a prior bot message in place (silent, no push).
- `react` — emoji reaction on an inbound message.
- `download_attachment` — fetch a file by `file_id` into the local inbox.

Plus bundled lifecycle hooks (silence watchdog, turn-complete ping, error
relay) and a `notify-user` comms-playbook skill.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- Grok CLI — `curl -fsSL https://x.ai/cli/install.sh | bash`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

**1. Install the server**

```sh
git clone https://github.com/5dive-com/5dive-plugins
cd 5dive-plugins/plugins/telegram-grok
bun install
```

**2. Save the bot token**

```sh
mkdir -m 700 -p ~/.grok/channels/telegram
cat > ~/.grok/channels/telegram/.env <<EOF
TELEGRAM_BOT_TOKEN=123456789:AAH...
EOF
chmod 600 ~/.grok/channels/telegram/.env
```

**3. Seed the allowlist**

**3a. Pair via the bot (recommended)**

```sh
bun pair.ts
```

DM your bot from the Telegram account you want allowed; the CLI captures
your user_id, writes `~/.grok/channels/telegram/access.json`, and replies
"✅ paired". Re-run to add more users. Conflicts with a running MCP server
(one getUpdates consumer per token) — stop Grok first, pair, then restart.

**3b. Hand-write access.json**

```json
{
  "allowFrom": ["123456789"],
  "groups": {
    "-1001234567890": { "requireMention": false, "allowFrom": [] }
  }
}
```

- `allowFrom` — Telegram user IDs allowed to DM the bot (in a DM the
  `chat_id` equals the user ID).
- `groups` — group/supergroup chat IDs (negative) and per-group policy:
  `requireMention: true` only routes messages that @mention (or
  quote-reply) the bot; `allowFrom: []` falls back to the top-level list.

Messages from anyone not on the lists are silently dropped before they
reach `wait_for_message`. Group access can only be set by hand-writing
access.json — `pair.ts` handles DMs only.

**4. Wire into Grok**

Grok reads the Claude plugin format natively, so there are two ways:

**Wire the MCP server via `~/.grok/config.toml`** — the method that works
on grok 0.1.x (see [Grok 0.1.x quirks](#grok-01x-quirks) below). Use an
absolute path:

```toml
[mcp_servers.telegram]
command = "bun"
args = ["/absolute/path/to/5dive-plugins/plugins/telegram-grok/server.ts"]
# wait_for_message defaults to 50s to stay under the 60s default below;
# raise both together if you want longer idle polls.
tool_timeouts = { wait_for_message = 60 }
```

`--always-approve` auto-trusts plugin/MCP commands, so there's no separate
`/plugins trust` step.

**Or as a plugin (forward-looking).** Grok discovers plugins from
`~/.grok/plugins/` (symlink or copy this dir) or a marketplace source and
loads the bundled `.mcp.json` + `hooks/hooks.json`. On grok 0.1.x,
`${GROK_PLUGIN_ROOT}` does NOT expand in `.mcp.json`, so the MCP server
path won't resolve this way yet — use the `config.toml` form above until
grok supports the variable in MCP configs.

**5. Add the comms playbook**

Install the `notify-user` skill (`skills/notify-user/SKILL.md`) into
`~/.grok/skills/`, or drop the contents of [`AGENTS.md`](./AGENTS.md) into
your Grok rules/memory, so the model knows when and how to use the tools.

**6. Run Grok**

```sh
grok
```

DM your bot. Grok calls `wait_for_message`, your DM resolves it, Grok
replies via the `reply` tool. Done.

## Grok 0.1.x quirks

Confirmed live on grok 0.1.x — both affect wiring:

- **`config.toml` `[[hooks.*]]` is ignored.** Grok loads hooks only from
  `~/.grok/hooks/*.json` (and a plugin's `hooks/hooks.json`). The TOML
  `[[hooks.Stop]]` form that Codex uses does nothing in grok.
- **`${GROK_PLUGIN_ROOT}` does not expand in `.mcp.json`** command/args
  (it does expand in hook `command` fields). Wire the MCP server with an
  absolute path in `config.toml` `[mcp_servers.telegram]` instead — the
  managed 5dive provisioning does exactly this.
- **`--always-approve` auto-trusts** plugin/MCP commands — no separate
  `/plugins trust` step needed.

## Lifecycle hooks

Wired via the plugin's `hooks/hooks.json`, or `~/.grok/hooks/*.json` for a
standalone install. **Note:** grok ignores `[[hooks.*]]` in `config.toml`
(unlike Codex) — hook configs must live in `~/.grok/hooks/*.json`. All
hooks are non-blocking and read the same state dir as the server:

| Hook | Event | What it does | Knobs |
| ---- | ----- | ------------ | ----- |
| `silence-watchdog.ts` | `PreToolUse` | Pings a quiet `⏳ still working…` after `GROK_SILENCE_WATCHDOG_MS` (default 120s) of silence | `GROK_SILENCE_WATCHDOG_DISABLED`, `GROK_SILENCE_WATCHDOG_MS` |
| `notify-stop.ts` | `Stop` | "🟢 grok: turn complete" ping; suppressed if a reply was sent in the last 30s | `GROK_NOTIFY_DISABLED`, `GROK_NOTIFY_TEXT`, `GROK_NOTIFY_SUPPRESS_MS` |
| `notification-relay.ts` | `Notification` | Relays error-flavored notifications (rate limit, API error, crash) with a `⚠️ grok:` prefix | `GROK_NOTIFY_RELAY_ALL`, `GROK_NOTIFY_RELAY_DISABLED` |

## Differences from the Claude Code and Codex builds

| Concern | `telegram/` (Claude) | `telegram-codex/` | `telegram-grok/` (this) |
| ------- | -------------------- | ----------------- | ----------------------- |
| Inbound delivery | `claude/channel` push | `wait_for_message` poll | `wait_for_message` poll |
| Permission relay | `claude/channel/permission` | `PermissionRequest` hook + buttons | none — Grok runs `--always-approve` |
| Wiring | Claude plugin | `~/.codex/config.toml` | Grok plugin (`.mcp.json` + `hooks.json`) or `~/.grok/config.toml` |
| State dir | `~/.claude/channels/telegram/` | `~/.codex/channels/telegram/` | `~/.grok/channels/telegram/` (honors `GROK_HOME`) |
| Lifecycle hooks | PreToolUse, Stop, … | Stop (+ more) | PreToolUse, Stop, Notification |
| Pairing flow | code via DM → `/telegram:access pair` | `bun pair.ts` | `bun pair.ts` |

See [`TODO.md`](./TODO.md) for the roadmap and the "Won't port" list.
