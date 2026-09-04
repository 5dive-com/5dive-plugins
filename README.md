# 5dive-plugins

Claude Code plugin marketplace maintained by [5dive](https://5dive.ai?utm_source=github&utm_medium=referral&utm_campaign=5dive-plugins-readme).

The `telegram` plugin pairs an agent CLI with a Telegram bot — DM the bot, the
agent answers. The original targets Claude Code; the **runtime forks** below
bring the same bridge to other agent CLIs that lack Claude Code's `channel`
push protocol.

| Plugin | Runtime | Inbound model | Notes |
| --- | --- | --- | --- |
| [`telegram`](./plugins/telegram) | Claude Code | `channel` push | The baseline. Fork of Anthropic's `telegram` plugin, extended with 5dive auto-relay, stop-reply gating, and ask-user-question routing. |
| [`telegram-codex`](./plugins/telegram-codex) | OpenAI Codex | app-server dispatcher | Persistent local dispatcher for Telegram/dashboard; MCP polling remains a fallback. |
| [`telegram-grok`](./plugins/telegram-grok) | xAI Grok | `wait_for_message` poll | MCP server. Runs `--always-approve` (no permission bridge). |
| [`telegram-agy`](./plugins/telegram-agy) | Google Antigravity | `wait_for_message` poll | MCP server. Plugin manifest + MCP wired global+absolute in `~/.gemini/config`. |
| [`telegram-opencode`](./plugins/telegram-opencode) | opencode | HTTP + `/event` SSE | **Not an MCP fork** — a long-running relay over `opencode serve`. No watchdog/hooks/file-IPC needed (the server pushes events). |

The remaining poll-based forks share one codebase shape and move in lockstep, checked
by [`test/parity.test.ts`](./test) and the [`generator/`](./generator) (DIVE-9) —
a new poll-based runtime is a config block, not a hand-fork. `telegram-codex`
now has an app-server dispatcher in addition to its generated fallback; `telegram-opencode`
is a deliberate exception: opencode's headless server makes a relay simpler than
an MCP fork (see its README + [the spike](./plugins/telegram-opencode-SPIKE.md)).

## Install

```text
/plugin marketplace add 5dive-ai/5dive-plugins
/plugin install telegram@5dive-plugins
```

## Anthropic Teams accounts

On an Anthropic Teams account, the channel-plugin allowlist is controlled by your org admin via remote managed-settings — local `/etc/claude-code/managed-settings.json` is ignored. Without an admin-set allowlist, `claude` silently drops inbound Telegram messages and the startup log shows:

```
Channel notifications skipped: plugin telegram@5dive-plugins is not on the approved channels allowlist
```

**Fix:** your org admin opens [claude.ai](https://claude.ai/) and navigates to **Admin Settings → Claude Code → Managed settings (settings.json) → click "Manage"**, then pastes the JSON below into the Managed settings textarea and saves:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "plugin": "telegram", "marketplace": "5dive-plugins" },
    { "plugin": "telegram", "marketplace": "claude-plugins-official" },
    { "plugin": "discord",  "marketplace": "claude-plugins-official" }
  ]
}
```

Notes:

- `channelsEnabled: true` is required on Claude Code 2.1.150+. Without it the allowlist is silently inert.
- Once any org-level allowlist exists, Claude Code stops reading Anthropic's default ledger — so include every channel plugin your team uses, not just `5dive-plugins`. Drop any you don't need.
- Single-user (non-Teams) installs don't hit this — `5dive`'s `install.sh` writes `/etc/claude-code/managed-settings.json` locally and that's all Claude Code needs.

## Attribution

The `telegram` plugin is forked from Anthropic's
[`claude-plugins-official`](https://github.com/anthropics/claude-plugins-official)
under Apache License 2.0. See [`NOTICE`](./NOTICE) and
[`plugins/telegram/LICENSE`](./plugins/telegram/LICENSE).
