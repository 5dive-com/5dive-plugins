# Changes from upstream

Tracks the diff between `plugins/telegram/` and upstream
`anthropics/claude-plugins-official/external_plugins/telegram/`.

## v0.0.6+5dive.1 (in progress)

### Added
- **Bundled lifecycle hooks** (`plugins/telegram/hooks/`):
  - `pretool-question.sh` — denies `AskUserQuestion` and `ExitPlanMode` in
    telegram-paired sessions, since their pickers render only in the local
    terminal. Asks the agent to inline the question/plan as a normal
    Telegram reply instead.
  - `stop-reply-check.sh` — Stop-hook safety net for the "agent talked to
    the transcript instead of calling reply" failure mode. Auto-relays loose
    transcript text or blocks the Stop so the agent retries.
- `hooks/hooks.json` declaring both hooks with appropriate matchers.

### Unchanged
- `server.ts` (Bun MCP server)
- `skills/{access,configure}`
- `.mcp.json`, `.claude-plugin/plugin.json`, `package.json`
- `LICENSE` (Apache 2.0, preserved verbatim)

### Deferred
- `stop-failure-telegram.sh` — has a runtime dependency on
  `/usr/local/lib/5dive/resume-after-reset.sh`. Will land in a follow-up
  once decoupled from the 5dive-host install path.
- Multi-agent routing (1 bot ↔ N agents)
- CLI-agnostic plugin variants (codex / opencode / etc.)
