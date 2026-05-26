# Telegram plugin — slash command expansion

Executable backlog. Work top-down: each task is independently shippable
in its own commit + plugin version bump. See [[plugin-version-cadence]]
— default to PATCH bumps for additive changes.

Source of inspiration: `NousResearch/hermes-agent` at
`/home/claude/projects/hermes-agent/` —
- `gateway/platforms/telegram.py` (5700 lines) — full TG impl
- `hermes_cli/commands.py` (1819 lines) — central `COMMAND_REGISTRY`
- `website/docs/reference/slash-commands.md` — command catalog

**Current command surface** (server.ts): `/start /help /status /stop
/restart /clear /model /effort /agents /account /goal`. `/agents` also
takes a `stop <name>` subcommand. `/goal` takes `status / pause /
resume / clear`.

## Shipped (excluded from backlog)

| ID    | Command                              | Version  |
| ----- | ------------------------------------ | -------- |
| T0    | Central command registry             | v0.3.0   |
| T1    | `/agents` (list)                     | v0.3.x   |
| T5b   | `/account` (auth profile switch)     | v0.4.10  |
| T6    | `/model`                             | v0.4.0   |
| T7    | `/effort`                            | v0.4.0   |
| T8    | `/goal` (+ status/pause/resume/clear) | v0.4.13–14 |
| —     | `/clear` (Claude built-in via TUI)   | v0.4.15  |
| —     | `/agents stop <name>`                | v0.4.15  |
| T15   | BotFather menu auto-sync             | v0.3.0   |
| T17a  | Silence-watchdog hook                | v0.3.2   |
| T17b  | Mandatory-load token trim            | v0.3.1   |

---

## Phase 1 — Multi-agent host commands (our edge)

Uniquely ours; Hermes can't do them because it doesn't know about the
5dive host. All shell out to `sudo 5dive ... --json` and parse the
envelope.

### T2 — `/dispatch <name> <message>`

Send a message to another agent on the host.

- Shell: `sudo 5dive agent send <name> "<message>"`
- The CLI auto-wraps `[5dive-msg from=<me>]` when called from an `agent-*`
  user — no need to add it manually
- Reject if `<name>` is self
- Scope: admin DM only

### T3 — `/spawn <name> [type]`

Create a worker agent.

- Shell: `sudo 5dive agent create <name> --type=${type:-claude} --json`
- Default type: `claude`
- Reply with the agent's bot username (if channel=telegram) for pairing
- Scope: admin DM only

### T4 — `/agents rm <name>` (subcommand of /agents)

Tear down a worker. Naturally extends today's `/agents stop <name>`.

- Shell: `sudo 5dive agent rm <name> --json`
- Refuse `<name> == self` (would kill the bot answering)
- Confirm-on-destructive: send "reply YES to confirm" first turn
- Scope: admin DM only

### T4b — `/agents start <name>` and `/agents restart <name>`

Symmetric with today's `/agents stop`. Wrappers over
`sudo 5dive agent {start,restart} <name> --json`. Cheap to ship together.

### T5 — `/doctor`

Host health summary.

- Shell: `sudo 5dive doctor --json`
- Render: `errors=N warnings=M` + bullet list of any failing checks
- Scope: admin DM only

---

## Phase 2 — Claude session commands

These touch the running agent. Two patterns:
- **Settings edit + restart** (model, effort): edit `~/.claude/settings.json`,
  then `systemd-run --on-active=1 --collect systemctl restart <svc>`.
- **In-session inject** (clear, goal, checkpoint): send the slash command
  or directive into the running Claude via tmux send-keys.

### T9 — `/checkpoint`

Save in-flight session state to a file so a fresh session (after
`/clear` or `/restart`) can resume without losing ephemeral context.
Distinct from auto-memory, which captures long-lived facts;
`/checkpoint` captures "what we're debugging right now" type state that
dies on context wipe.

NOT the original T9 (inter-agent handoff — we dropped that; if we ever
want it, name it differently to match hermes' `/handoff` semantics:
"hand off this session to another messaging platform").

**Subcommands:**

- `/checkpoint` (no args) — plugin sends a TUI directive: *"Write
  HANDOFF.md at the project root. Cover: what we're working on, what's
  done, what's next, blockers, key file paths. Be terse — this is for
  your future self after /clear."* Agent writes via Write tool.
- `/checkpoint resume` — after a fresh session, injects *"Read
  HANDOFF.md and continue from there."* into the running TUI.

**Future (v2):** SessionStart hook auto-detects HANDOFF.md presence and
injects it as a `<system-reminder>` so no explicit `/checkpoint resume`
needed. Risk: surprises if HANDOFF.md is stale.

**Naming rationale:** matches git/db vocab; "/handoff" implies a
recipient and conflicts with hermes' channel-switch meaning;
"/snapshot" is hermes' term for config/state snapshots — different
concept.

- Scope: admin DM only

### T10 — `/pwd` and `/cd <dir>`

Show or change Claude's cwd.

- `/pwd`: read from the running Claude session (cmdline `--workdir`?
  or `readlink /proc/<pid>/cwd`?). The plugin already has `/proc` parsing
  for model/effort — extend it.
- `/cd <dir>`: requires settings.json edit + restart (cwd is set at
  `claude` invocation time, not mid-session) — phrase this clearly in
  the reply
- Scope: admin DM only

---

## Phase 3 — Telegram channel commands (channel-level, no Claude)

These never touch the running Claude; they manipulate the bot/plugin's
own state in `~/.claude/channels/telegram/`.

### T11 — `/whoami`

Show: paired Telegram user, bot username (`getMe`), allowed scope
(admin/user/none), this agent's host name and type.

- Self-contained — no shell-out needed except `5dive doctor` for agent name
- Scope: any allowed user

### T12 — `/pause` and `/resume` (channel-level mute)

While paused, the plugin acks "(paused — `/resume` to re-enable)" but
doesn't forward to Claude. Distinct from `/goal pause` (which pauses
the standing /loop goal, not the channel).

- State: `~/.claude/channels/telegram/paused.flag`
- Scope: admin DM only

### T13 — `/commands` (paginated catalog)

Browse all commands and skills (Hermes pattern). Useful once the
registry has 15+ entries.

- Derived from `COMMAND_REGISTRY`
- Format: `cmd — description` grouped by section
- Scope: any allowed user

### T14 — `/sethome`

Pin the current chat as the home channel for **proactive** deliveries
(future: when the agent finishes a long task and wants to nudge you in
a specific chat, not necessarily the one that started it).

- State: `~/.claude/channels/telegram/home.json` → `{chatId}`
- No-op until we have a code path that wants to use it
- Scope: admin DM only

---

## Phase 4 — Polish

### T16 — Permission tiers

Hermes' `allow_admin_from` / `user_allowed_commands` model. Right now
the plugin is binary (paired user gets everything, others get nothing).
Add a `user` tier — read `~/.claude/channels/telegram/access.json` for
allowed-cmd list. Floor: `/help` and `/whoami` always allowed.

### T17 — Docs

Update `plugins/telegram/README.md` with the full command catalog. Mirror
into `5dive-blog/` if user wants public docs.

---

## Phase 5 — Marketing-user workflow accelerators

Contributed by agent-marketing (2026-05-24). Lens: "things I'd actually
use day-to-day living in this chat." Marketing's top-2 picks listed first.

### T18 — `/ack` (marketing top pick #1)

Fast "on it" reply that doesn't interrupt the agent's running task.

- **Pain point:** sender currently context-switches just to type "yep".
  Long task already running → typing a reply forces a turn, which
  interrupts the in-flight tool loop.
- Implementation: bot replies with a canned ack ("on it ✓") *without*
  forwarding to Claude. State: no Claude turn consumed.
- Optional: `/ack <text>` to include a short custom note that still
  doesn't forward
- Scope: any allowed user

### T19 — `/schedule <when> <text>` (marketing top pick #2)

Queue a message for future delivery — lets agents batch overnight
findings to land at the user's wake time, respecting quiet hours.

- `<when>` formats: `+30m`, `+2h`, `08:00`, `2026-05-25 09:00`
- Implementation: persist to `~/.claude/channels/telegram/scheduled.json`
  + a cron job (or `at`) that runs the plugin's deliver script at the
  due time
- Survives plugin restart (state is on disk)
- `/schedule list` and `/schedule cancel <id>` to manage
- Scope: admin DM only

### T20 — `/quiet [HH:MM-HH:MM]`

Set / show / clear the user's quiet-hours window. Plugin respects it
for proactive deliveries (not user-initiated replies).

- No arg: show current window
- `HH:MM-HH:MM` (24h): set window
- `/quiet off`: clear
- State: `~/.claude/channels/telegram/quiet.json` → `{start, end, tz}`
- Behavior: during quiet hours, `/schedule` defers proactive notifs
  to the window end; replies to user messages still go through
- Scope: admin DM only

### T25 — `/digest [n]` (compaction recovery)

Re-show the last `n` inbound messages from THIS chat (default ~10).
Telegram Bot API exposes no history endpoint, so after the agent's
context compacts it's blind to anything older than current scrollback.

- Source: pull from the local `~/.claude/channels/telegram/inbox/`
  directory (which the plugin already persists for photos/files);
  extend to also persist text messages
- Action: replay msgs back into the session as system context
- Scope: any allowed user

### Deferred (dismissed in 2026-05-26 review — phone-useful filter)

- ~~T21 `/usage`~~ — already surfaced in `/status`
- ~~T22 `/tasks`~~ — niche, inject-based
- ~~T23 `/diff`~~ — niche
- ~~T24 `/pin`~~ — risky surprise factor
- ~~T26 `/preview`~~ — niche
- ~~T27 `/draft`~~ — marketing-only

---

## Cross-cutting checklist (every task)

- [ ] Add to `COMMAND_REGISTRY`
- [ ] DM gate via `dmCommandGate(ctx)` (groups can leak)
- [ ] Bump `plugin.json` version (package.json no longer carries a version
      field — see [[plugin-version-single-source]])
- [ ] Run `./build.sh` in `5dive-cli` ONLY if a 5dive-cli wrapper changed
      (rare for plugin-only work)
- [ ] Smoke: pair a fresh chat, run the command, verify reply
- [ ] Commit author `lodar <markounik@gmail.com>` ([[git-author]])
- [ ] Push directly to main ([[commit-flow]])

## Open coordination

- **Plugin rollout** — until customer-VM installers ship the plugin,
  only host agents (main/marketing/community here) see these commands.
  Don't promise them to customers in marketing copy yet.
