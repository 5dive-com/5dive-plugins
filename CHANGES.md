# Changes from upstream

Tracks the diff between `plugins/telegram/` and upstream
`anthropics/claude-plugins-official/external_plugins/telegram/`.

## v0.1.1

### Added — bot slash commands

- **`/help`** — full command listing (replaces upstream's two-line version).
- **`/status`** — pairing line **plus** session health for paired senders:
  uptime, model, last activity, cwd, claude version (read from
  `~/.claude/sessions/<pid>.json`), plugin version, and the host's
  `5dive` CLI version when the binary is on PATH. Pairing-only output
  preserved for un-paired senders.
- **`/stop`** — interrupt the agent's current task. Sends `C-c` to the tmux
  pane the running claude session lives in.
- **`/restart`** — `SIGTERM` claude; systemd's respawn loop brings it back
  within ~2s. Useful when claude is stuck.
- **`/agents`** — list sibling agents on the same host via
  `sudo -n 5dive agent list --json`. Marks "← you" against the agent owning
  the bot. Requires the agent user to have passwordless sudo for 5dive (the
  default on 5dive-managed hosts).
- **`/tasks`**, **`/task add <title>`**, **`/org`** — drive the host-shared
  task queue + agent org chart via `sudo -n 5dive task|org … --json`.
  `paired-5dive`-scoped (hidden + no-op on upstream-only hosts). Task titles
  are passed after `--` and `created_by` is the sender's Telegram @handle.
- **Forum-topic capture on inbound + reply** — inbound `<channel>` meta now
  carries `message_thread_id` when a message comes from a non-General topic
  in a supergroup (e.g. a "#5dive" thread). The `reply` tool accepts a
  matching `message_thread_id` arg that's passed through to Telegram's
  sendMessage/sendPhoto/sendDocument, so replies land in the same topic
  instead of falling back to the supergroup's General channel.
- All slash commands are registered via `setMyCommands` so Telegram surfaces
  them in the autocomplete menu.

### Added — v0.1.0 carried over

- Bundled lifecycle hooks (`hooks/pretool-question.sh`, `hooks/stop-reply-check.sh`)
  declared via `hooks/hooks.json` — eliminates the need for `5dive-cli` to
  patch hooks into `settings.json` externally.

### Deferred

- `stop-failure-telegram.sh` — coupled to `/usr/local/lib/5dive/resume-after-reset.sh`.
- Multi-agent routing (1 bot ↔ N agents).
- CLI-agnostic plugin variants (codex / opencode / etc.).
- `/route`, `/spawn`, `/quiet`, `/verbose`, `/usage` — slash command shortlist
  for v2.

### Notes

The "channels" feature (the system-reminder injection on inbound messages)
is gated by claude's internal channel allowlist. For our fork to work as a
channel surface, the host needs `/etc/claude-code/managed-settings.json`
with an `allowedChannelPlugins` entry for `telegram@5dive-plugins`. Without
it the plugin still loads as a regular MCP server (tools callable, but no
auto-injection of inbound messages). 5dive-managed hosts get this
allowlist via the 5dive-cli installer; standalone OSS users currently need
to write the managed-settings file themselves.
