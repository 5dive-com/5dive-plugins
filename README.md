# 5dive-plugins

Claude Code plugin marketplace maintained by [5dive](https://5dive.com).

| Plugin | Purpose |
| --- | --- |
| [`telegram`](./plugins/telegram) | Telegram bridge for Claude Code — MCP server + access control + bundled lifecycle hooks. Fork of Anthropic's `telegram` plugin extended with 5dive auto-relay, stop-reply gating, and ask-user-question routing. |

## Install

```text
/plugin marketplace add 5dive-com/5dive-plugins
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
