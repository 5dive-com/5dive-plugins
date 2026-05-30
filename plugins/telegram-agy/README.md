# telegram-agy MCP

A Telegram bridge for [Google Antigravity CLI](https://antigravity.google), delivered as a stdio
MCP server.

Sibling to the [`telegram/`](../telegram/) plugin (Claude Code),
[`telegram-codex/`](../telegram-codex/) (OpenAI Codex), and
[`telegram-grok/`](../telegram-grok/) (xAI Grok). Forked from the Grok
build because Antigravity shares the same runtime contract: it has no
Claude-Code `channel` push protocol, so inbound delivery is **poll-based**
via a `wait_for_message` tool rather than pushed.

## What you get

Five MCP tools available to Antigravity:

- `wait_for_message` — block until the user sends a DM/group message.
- `reply` — send a new Telegram message (text, MarkdownV2, file attachments).
- `edit_message` — patch a prior bot message in place (silent, no push).
- `react` — emoji reaction on an inbound message.
- `download_attachment` — fetch a file by `file_id` into the local inbox.

Plus bundled lifecycle hooks (silence watchdog, turn-complete ping, error
relay) and a `notify-user` comms-playbook skill.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- Antigravity CLI — `curl -fsSL https://antigravity.google | bash`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

**1. Install the server**

```sh
git clone https://github.com/5dive-com/5dive-plugins
cd 5dive-plugins/plugins/telegram-agy
bun install
```

**2. Save the bot token**

```sh
mkdir -m 700 -p ~/.gemini/channels/telegram
cat > ~/.gemini/channels/telegram/.env <<EOF
TELEGRAM_BOT_TOKEN=123456789:AAH...
EOF
chmod 600 ~/.gemini/channels/telegram/.env
```

**3. Seed the allowlist**

**3a. Pair via the bot (recommended)**

```sh
bun pair.ts
```

DM your bot from the Telegram account you want allowed; the CLI captures
your user_id, writes `~/.gemini/channels/telegram/access.json`, and replies
"✅ paired". Re-run to add more users. Conflicts with a running MCP server
(one getUpdates consumer per token) — stop Antigravity first, pair, then restart.

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

**4. Install the plugin + wire the MCP server**

Antigravity has a Claude-style plugin system. Install this directory:

```sh
agy plugin install /absolute/path/to/5dive-plugins/plugins/telegram-agy
```

That copies the plugin to `~/.gemini/config/plugins/telegram-agy/` (and
runs its `start` script, so `bun install` lands the deps there). The
plugin's bundled **skill** is auto-discovered from there.

**But the MCP server must be wired into the global config** — agy's
runtime plugin discovery only auto-loads skills/agents, **not** a
plugin's `mcp_config.json` or hooks (see [quirks](#agy-quirks)). Add the
server to `~/.gemini/config/mcp_config.json` with an **absolute** `--cwd`
pointing at the installed plugin dir:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "bun",
      "args": ["run", "--cwd", "/home/you/.gemini/config/plugins/telegram-agy", "--shell=bun", "--silent", "start"]
    }
  }
}
```

> ⚠️ This file ships **empty** (0 bytes); agy logs `unexpected end of JSON
> input` and MCP discovery stays broken until it holds valid JSON. agy
> runs with `--dangerously-skip-permissions`, so there's no separate trust
> step.

**5. Add the comms playbook**

The bundled `notify-user` skill is auto-discovered once the plugin is
installed. For a non-plugin install, copy `skills/notify-user/SKILL.md`
into `~/.gemini/skills/` (or `~/.agents/skills/`), or drop
[`AGENTS.md`](./AGENTS.md) into your Antigravity rules/memory, so the
model knows when and how to use the tools.

**6. Run Antigravity**

```sh
agy
```

DM your bot. Antigravity calls `wait_for_message`, your DM resolves it, Antigravity
replies via the `reply` tool. Done.

<a name="agy-quirks"></a>
## Antigravity (agy) plugin-runtime quirks

Confirmed live on agy 1.0.3:

- **Plugin layout differs from Claude Code.** `plugin.json` lives at the
  plugin **root** (not `.claude-plugin/`), and the MCP manifest is
  **`mcp_config.json`** (not `.mcp.json`). `hooks/hooks.json` and
  `skills/<name>/SKILL.md` match Claude. Validate with `agy plugin
  validate <path>`.
- **Runtime plugin discovery only auto-wires skills + agents — not MCP
  servers or hooks.** `agy plugin validate/install` *processes* the MCP
  and hook manifests, but the running CLI does not load them from the
  plugin dir. So the MCP server must be declared in the **global**
  `~/.gemini/config/mcp_config.json` with an absolute `--cwd` (see step 4).
- **The global `~/.gemini/config/mcp_config.json` ships empty (0 bytes)** →
  agy logs `unexpected end of JSON input` until it holds valid JSON.
- **No `config.toml`.** agy configures MCP via
  `~/.gemini/config/mcp_config.json` and settings via
  `~/.gemini/antigravity-cli/settings.json`.
- **Runs `--dangerously-skip-permissions`** — no trust prompt to bridge.
- **Hook runtime firing is not yet confirmed** under agy. validate accepts
  every event and the manifest installs, but probe hooks did not fire in
  headless `agy -p`. Keepalive does not depend on a Stop hook — the MCP
  server's own re-arm watchdog (tmux send-keys to session `agent-<name>`)
  re-kicks the `wait_for_message` loop after idle.

## Lifecycle hooks

Declared in the plugin's `hooks/hooks.json` (events: PreToolUse, Stop,
Notification). ⚠️ Runtime firing under agy is unconfirmed (see quirks
above) — these are shipped validate-clean but should not be relied on
until verified in a live TUI session. All hooks are non-blocking and read
the same state dir as the server:

| Hook | Event | What it does | Knobs |
| ---- | ----- | ------------ | ----- |
| `silence-watchdog.ts` | `PreToolUse` | **Off by default** (v0.1.5+) — the notify-user skill carries the "still alive" signal via progress edits. Opt in with `AGY_SILENCE_WATCHDOG_ENABLED=1`. When enabled, pings `⏳ still working…` after `AGY_SILENCE_WATCHDOG_MS` (default 600s) of silence; backs off 1× / 10× / 15× cap so long silent runs don't ping every 10 min | `AGY_SILENCE_WATCHDOG_ENABLED`, `AGY_SILENCE_WATCHDOG_DISABLED`, `AGY_SILENCE_WATCHDOG_MS` |

`PLUGIN_VERSION` (reported by `/ping`, `/status`, `setMyCommands`) is read from `package.json` at server startup, so PATCH bumps don't require a second edit in `server.ts`.
| `notify-stop.ts` | `Stop` | "🟢 agy: turn complete" ping; suppressed if a reply was sent in the last 30s | `AGY_NOTIFY_DISABLED`, `AGY_NOTIFY_TEXT`, `AGY_NOTIFY_SUPPRESS_MS` |
| `notification-relay.ts` | `Notification` | Relays error-flavored notifications (rate limit, API error, crash) with a `⚠️ agy:` prefix | `AGY_NOTIFY_RELAY_ALL`, `AGY_NOTIFY_RELAY_DISABLED` |

## Differences from the Claude Code and Codex builds

| Concern | `telegram/` (Claude) | `telegram-codex/` | `telegram-agy/` (this) |
| ------- | -------------------- | ----------------- | ----------------------- |
| Inbound delivery | `claude/channel` push | `wait_for_message` poll | `wait_for_message` poll |
| Permission relay | `claude/channel/permission` | `PermissionRequest` hook + buttons | none — Antigravity runs `--dangerously-skip-permissions` |
| Wiring | Claude plugin | `~/.codex/config.toml` | `agy plugin install` + global `~/.gemini/config/mcp_config.json` (absolute path) |
| State dir | `~/.claude/channels/telegram/` | `~/.codex/channels/telegram/` | `~/.gemini/channels/telegram/` (honors `ANTIGRAVITY_HOME`) |
| Lifecycle hooks | PreToolUse, Stop, … | Stop (+ more) | PreToolUse, Stop, Notification |
| Pairing flow | code via DM → `/telegram:access pair` | `bun pair.ts` | `bun pair.ts` |

See [`TODO.md`](./TODO.md) for the roadmap and the "Won't port" list.
