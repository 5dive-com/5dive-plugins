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

## Attribution

The `telegram` plugin is forked from Anthropic's
[`claude-plugins-official`](https://github.com/anthropics/claude-plugins-official)
under Apache License 2.0. See [`NOTICE`](./NOTICE) and
[`plugins/telegram/LICENSE`](./plugins/telegram/LICENSE).
