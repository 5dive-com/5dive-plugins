# Telegram plugin — slash command expansion

Executable backlog. Work top-down: each task is independently shippable
in its own commit + plugin version bump. Bump `plugin.json` AND
`package.json` together (see [[5dive-plugins-fork]] gotcha).

Source of inspiration: `NousResearch/hermes-agent` at
`/home/claude/projects/hermes-agent/` —
- `gateway/platforms/telegram.py` (5700 lines) — full TG impl
- `hermes_cli/commands.py` (1819 lines) — central `COMMAND_REGISTRY`
- `website/docs/reference/slash-commands.md` — command catalog

Existing 5dive plugin commands (server.ts): `/start /help /status /stop /restart`

## Architecture prerequisite (do FIRST)

### T0 — Central command registry

**Why first:** every other task below grows the `bot.command(...)`
surface. Hermes' big win is a single `COMMAND_REGISTRY` array of
`{name, aliases, description, scope, handler}` objects from which the
`/help` text, BotFather menu auto-sync, and dispatcher all derive. Add
ours before the surface grows past ~8 entries.

**Acceptance:**
- New `src/commands.ts` exporting `COMMAND_REGISTRY: CommandDef[]`
- `server.ts` iterates it to register `bot.command(...)` handlers
- `/help` body is generated from the registry, not a hand-written string
- One-time BotFather sync (`bot.telegram.setMyCommands`) on startup
  reflects the registry so users see the menu in the TG `/` picker

---

## Phase 1 — Multi-agent host commands (our edge)

These are uniquely ours; Hermes can't do them because it doesn't know
about the 5dive host. All shell out to `sudo 5dive ... --json` and
parse the envelope.

### T1 — `/agents`

List active agents on this host.

- Shell: `sudo 5dive agent list --json`
- Render: one line per agent → `name (type, channel) — active|stopped`
- Mark "you" with a ★ (the agent name == `whoami | sed 's/^agent-//'`)
- Scope: admin DM only

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

### T4 — `/kill <name>`

Tear down a worker.

- Shell: `sudo 5dive agent rm <name> --json`
- Refuse `<name> == self` (would kill the bot answering the message)
- Confirm-on-destructive: send "reply YES to confirm" first turn
- Scope: admin DM only

### T5 — `/doctor`

Host health summary.

- Shell: `sudo 5dive doctor --json`
- Render: `errors=N warnings=M` + bullet list of any failing checks
- Scope: admin DM only

### T5b — `/account [name]` (switch auth profile)

Show or switch this agent's auth profile (5dive **account** = named bag
of credentials, shared across agents via `--auth-profile`).

- No arg: show current profile + list available accounts
  - Shell (current): inspect `5dive agent list --json` → `.authProfile`
    for self, OR read `EnvironmentFile=` from this agent's systemd unit
  - Shell (list): `sudo 5dive account list --json`
- With arg: `sudo 5dive agent set-account <self> <name> --json`
  - The CLI auto-restarts the agent so the new EnvironmentFile takes
    effect — warn user "switching to <name>, restarting in ~1s"
  - Special: `default` clears the override and reverts to the shared
    `/etc/5dive/connectors/<type>.env`
- Reject unknown account names — show the list from `account list`
- Useful when work + personal Anthropic sign-ins exist on one host and
  the user wants to flip which one this agent bills against
- Scope: admin DM only

---

## Phase 2 — Claude session commands

These require touching the running agent. Two patterns:
- **Settings edit + restart** (model, effort): edit `~/.claude/settings.json`,
  then `systemd-run --on-active=1 --collect systemctl restart <svc>`.
- **In-session inject** (cd, goal): send the slash command into the
  running Claude via `5dive agent send self ...` (or tmux directly).

### T6 — `/model [name]` ✅ (shipped v0.4.0)

Switch model. With no arg: show current.

- Models: `opus-4-7`, `sonnet-4-6`, `haiku-4-5` (full IDs:
  `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`)
- Implementation: read/write `model` field in
  `/home/<me>/.claude/settings.json`, then trigger delayed restart per
  the CLAUDE.md pattern. Warn user "restarting in ~1s, session resumes."
- Scope: admin DM only

### T7 — `/effort [level]` ✅ (shipped v0.4.0)

Switch reasoning effort. Levels: **`low`, `medium`, `high`, `xhigh`, `max`**.
(User clarified: xhigh and max exist beyond low/med/high.)

- Implementation: same settings.json + restart dance as `/model`
- With no arg: show current
- Reject unknown values with the full level list
- Scope: admin DM only

### T8 — `/goal <text>` (proxies Claude Code's loop)

Set a standing goal the agent works toward across turns. Stop / status /
clear subcommands. This is our take on Hermes' `/goal`, implemented as a
wrapper over the existing `loop` skill we already have installed.

- Subcommands: `/goal status`, `/goal pause`, `/goal resume`, `/goal clear`
- Implementation sketch: forward `/loop <text>` (no interval = dynamic
  self-paced mode) into the running Claude via `agent send`; track state
  in `~/.claude/channels/telegram/goal.json` so `/goal status` works
- Hermes spec to mirror: a judge model decides DONE/CONTINUE after each
  turn; budget defaults to 20 turns; user message preempts.
  **MVP:** skip the judge — let `/loop` self-pace; revisit if needed.
- Scope: admin DM only

### T9 — `/handoff <target>`

Hand the current Telegram conversation to another agent on this host.

- Targets are agent names from `5dive agent list`
- Implementation: dispatch a `[5dive-msg from=<me> handoff=<chat_id>]
  <last N messages>` to target; target's plugin recognises `handoff=`
  and starts answering this chat directly. Original agent goes quiet
  for this chat until `/handoff back`.
- Scope: admin DM only
- **Open question** — record which agent owns each chat in a small
  ownership table to avoid two agents replying at once
- Use-case (marketing): "punt a community task to community without
  re-explaining" — context transfer matters more than mute

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

### T12 — `/pause` and `/resume`

Channel-level mute. While paused, the plugin acks "(paused — `/resume`
to re-enable)" but doesn't forward to Claude.

- State: `~/.claude/channels/telegram/paused.flag`
- Scope: admin DM only

### T13 — `/commands` (paginated catalog)

Browse all commands and skills (Hermes pattern). Useful once the
registry has 15+ entries.

- Derived from T0's `COMMAND_REGISTRY`
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

## Phase 4 — Polish (do after the above ships)

### T15 — BotFather menu auto-sync ✅ (shipped with T0/v0.3.0)

`bot.telegram.setMyCommands(...)` on every startup, driven by T0's
`botFatherCommands()` derivation from the registry. Users see the `/`
menu without us manually editing via BotFather.
**Future watch:** menu only supports ~32 commands; if we exceed, group
by scope (admin vs user) using `setMyCommands` scopes.

### T16 — Permission tiers

Hermes' `allow_admin_from` / `user_allowed_commands` model. Right now
the plugin is binary (paired user gets everything, others get nothing).
Add a `user` tier — read `~/.claude/channels/telegram/access.json` for
allowed-cmd list. Floor: `/help` and `/whoami` always allowed.

### T17 — Docs

Update `plugins/telegram/README.md` with the full command catalog. Mirror
into `5dive-blog/` if user wants public docs.

### T17a — Silence-prevention via system-reminder hook ✅ (shipped v0.3.2)

Mechanical fix for "Claude went 10 minutes silent on Telegram." Prose
instructions (CLAUDE.md, notify-user skill, silence-threshold memory)
have all failed — Claude reads them at session start and still ignores
mid-task. A hook that injects a fresh `<system-reminder>` when the
silence threshold is crossed is the forcing function.

**Why this and not the v0.2.0 watchdog:** v0.2.0 tried an auto-edited
"⏳ working… 47s • last: Bash" bubble. User scrapped it — felt fake,
delayed, robotic. **This is different:** the hook injects a reminder
into Claude's context (visible only to Claude), Claude writes the
actual TG content. No fake voice, no auto-edit; just a forcing
function.

**Shape:**
- New hook: `hooks/silence-watchdog.sh` registered as PostToolUse.
- State: `~/.claude/channels/telegram/silence.json` →
  `{lastReplyAt, toolCallsSinceReply}`.
- Plugin's reply/edit_message MCP tools call into the same state file
  on successful send (resets the counters).
- Hook decrements toolCallsSinceReply on every tool call; if
  `(now - lastReplyAt) > 90s` OR `toolCallsSinceReply >= 5`, emits a
  hookSpecificOutput with a `<system-reminder>` saying e.g.: "It's
  been Xs and Y tool calls since your last Telegram message. The user
  alarms at >60s silence — edit the previous reply with a one-line
  status, or send a fresh one if a new inbound landed."
- Re-fires every N calls if still silent (avoid one-shot fatigue).
- Inert when not paired to a TG chat (check `~/.claude/channels/telegram/
  access.json` `allowFrom` count).

**Acceptance:**
- Manual test: pair to a chat, run a long Bash command + several Read
  calls without sending a TG reply. After ~5 tool calls, verify the
  next tool result shows the system-reminder.
- Reset test: send a reply, then run 4 tool calls — confirm no
  reminder yet (under both thresholds).
- Idle test: open a session that's not paired — confirm hook is inert
  (no reminders).
- No tmux/pane manipulation. No auto-edit. No fake voice.

**Out of scope:**
- Automatic message posting. Claude must write the content itself.
- TaskUpdate-bound progress edits (deferred — could be T17c if T17a
  proves insufficient).

### T17b — Sharpen mandatory-load markdown (token diet) ✅ (shipped v0.3.1)

Trim what Claude sees on every paired session. Mandatory load today
~1200 tokens; audit finds ~180 trimmable (~15%) with no content loss.
Compounds across every turn of every session.

**Shipped 2026-05-24 in v0.3.1:** dropped MCP instructions ¶3 (duplicated
tool descs), tightened ¶2, extracted FORMAT_DESC const so the markdownv2
explainer ships once instead of twice. ~150 tokens off.

**Still open if we want another pass:** plugin description marketplace
tail (~30 tokens), `access` and `configure` skill bodies (load on-invoke
only — lower leverage).

**Targets (priority order):**

1. **MCP `instructions` ¶3 (server.ts:436)** — "reply accepts file
   paths… use react/edit_message…" duplicates the per-tool schema
   `description` fields. Drop the paragraph. **~80 tokens.**
2. **Duplicated `format` description** — the markdownv2 explainer
   appears verbatim in both `reply` and `edit_message` tool schemas
   (server.ts:502, :544). Pull into a `const FORMAT_DESC =` and reuse.
   **~30 tokens.**
3. **MCP `instructions` ¶2** (server.ts:434) — ~440 chars, dense,
   mentions `reply_to` twice and overlaps with ¶1's "reply tool"
   guidance. Restructure as 3 tight bullets: (a) inbound shape, (b)
   image_path/attachment handling, (c) reply_to usage rule. **~40
   tokens.**
4. **Plugin description marketplace tail** — "Fork of Anthropic's
   telegram plugin, maintained by 5dive" is useful in registry UIs,
   noise to Claude. Borderline; keep unless we add a separate
   `marketplace_description`. **~30 tokens (optional).**

**Out of scope for T17b (do later if needed):**
- SKILL.md bodies load only on-invoke, not per session. Lower
  leverage. `access` and `configure` have some redundancy but no urgent
  need.

**Acceptance:**
- Diff the rendered MCP instructions before/after — confirm no semantic
  drop (every behavior the old text described still appears either in
  the new instructions or in a tool schema description).
- Run plugin smoke test (`bun build server.ts --no-bundle`) — passes.
- Bump version (probably v0.3.1, patch — no behavior change).

**Why it matters:** every paired session reads this. Marketing's agents,
community's agents, and main's agents all pay the cost on every turn.
~15% off the mandatory budget is real money over a year of usage.

---

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
- Pair with T19 below — `/ack` is half of solving the silence-during-
  long-task problem

### T19 — `/schedule <when> <text>` (marketing top pick #2)

Queue a message for future delivery — lets agents batch overnight
findings to land at the user's wake time, respecting quiet hours.

- `<when>` formats: `+30m`, `+2h`, `08:00`, `2026-05-25 09:00`
- Implementation: persist to `~/.claude/channels/telegram/scheduled.json`
  + a cron job (or `at`) that runs the plugin's deliver script at the
  due time. Or reuse the existing host crontab pattern (CLAUDE.md notes
  `crontab` is the recurring-task channel).
- Survives plugin restart (state is on disk)
- `/schedule list` and `/schedule cancel <id>` to manage
- Scope: admin DM only
- **Synergy:** plays well with T20 `/quiet` — `/schedule` could
  auto-defer messages that would land inside a quiet window

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
- **Note:** the agent has a memory of the user's preferences already;
  this lifts it into queryable channel-level state

### T21 — `/usage`

Show this agent's 5h/7d Anthropic limit usage so the user knows whether
to assign more work or wait.

- Implementation: scrape the running Claude's status bar (the plugin
  already parses `/proc/<pid>/cmdline` for model/effort — extend to
  read the rendered TUI footer line "Opus 4.7 5h: X% 7d: Y%")
- Fallback: render "unknown" if the line isn't visible
- Render: `5h: 47% · 7d: 32% · model opus-4-7 · effort xhigh`
- Scope: any allowed user
- **Real-world value:** caught us today — marketing was at 5h:103% and
  modal-stuck; `/usage` would have surfaced this before the rate-limit
  hit. Pair with T22 to see what they're actually doing.

### T22 — `/tasks`

Dump the agent's current TaskList (via `TaskList` tool) so the user
sees what's actually in-flight.

- Implementation: requires Claude-side cooperation — send `/tasks` as a
  channel-side intercept that injects `Run TaskList and return the
  table` into the running session. Or read the task state file directly
  if Claude Code persists it.
- Render as compact bullet list
- Scope: admin DM only

### T23 — `/diff`

Show files the agent has touched since the user's last message
(faster than asking).

- Implementation: track per-chat "last user message timestamp"; on
  `/diff` run `git -C <workdir> status --short` + `git diff --stat
  HEAD@{<ts>}` (if commits) or just `find <workdir> -newer <ts>`
- Render as compact file list with +/- line counts
- Scope: admin DM only
- **Caveat:** the chat workdir may not be a git repo — fall back to
  filesystem mtime scan in that case

### T25 — `/digest [n]` (marketing v2 top pick — compaction fix)

Re-show the last `n` inbound messages from THIS chat (default ~10).
Telegram Bot API exposes no history endpoint, so after the agent's
context compacts it's blind to anything older than current scrollback.

- Source: pull from the local `~/.claude/channels/telegram/inbox/`
  directory (which the plugin already persists for photos/files);
  extend to also persist text messages
- Action: replay msgs back into the session as system context (inject
  as a synthesized turn or as a tool result depending on what survives
  compaction better)
- Unblocks the "wait what did you ask me yesterday" problem
- Scope: any allowed user
- **Real value:** every long-running agent hits this; compaction is
  silent and the loss isn't visible until you need the history

### T26 — `/preview <url>`

Fetch the URL server-side, render its OG card (image + title +
description) and show the final landing URL after redirects.

- Two wins:
  1. Catches stale OG images — *our own opengraph-image.png drift bit
     us; would've been a 5-second check*
  2. Reveals where shortened/tracked links actually land before
     posting them in a thread
- Implementation: server.ts already does fetch in Bun; add OG meta
  parser (`<meta property="og:*">`) + follow redirects via
  `fetch(url, {redirect:'follow'})` and surface final URL
- Render as a TG photo (the OG image) with caption (title + final URL)
- Scope: any allowed user
- Failure modes: 404, redirect loop, no OG tags — render plain "no
  preview, final URL: ..."

### T27 — `/draft <name> [text]`

Named persistent snippet store, scoped to the agent.

- `/draft v3 "copy text..."` — saves
- `/draft v3` — recalls and re-injects the text into the session
- `/draft` — list all draft names
- `/draft remove v3` — delete
- Marketing iteration flow: workshop ad copy across 8 variants, pull
  v3 back two days later when user picks it; avoids relying on
  scrollback or asking user to repaste
- State: `~/.claude/channels/telegram/drafts/<name>.txt` (one file per
  draft so they survive plugin restart)
- Scope: admin DM only
- **Synergy:** pairs with T25 `/digest` — both solve "I lost context";
  digest for inbound, draft for outbound

### T24 — `/pin <text>`

Sticky note that prepends to every reply until cleared. Example use:
"user is on phone, keep it short" → all subsequent replies stay terse.

- Subcommands: `/pin <text>` set, `/pin` show current, `/pin clear`
- Implementation: persist text to `~/.claude/channels/telegram/pin.json`;
  plugin prepends it to outgoing Claude replies as a system-style note
  (or inserts it as a hidden user-turn-1-style hint before forwarding)
- Scope: admin DM only
- **Risk:** could surprise users if they forget about an active pin;
  `/status` should surface "📌 active pin: ..."

---

## Cross-cutting checklist (every task)

- [ ] Add to `COMMAND_REGISTRY` (after T0 lands)
- [ ] DM gate via `dmCommandGate(ctx)` (groups can leak)
- [ ] Bump `plugin.json` AND `package.json` versions
- [ ] Run `./build.sh` in `5dive-cli` if any 5dive-cli wrapper changed
- [ ] Smoke: pair a fresh chat, run the command, verify reply
- [ ] Commit author `lodar <markounik@gmail.com>` ([[git-author]])
- [ ] Push directly to main ([[commit-flow]])
- [ ] If shipped on host plugin only, leave dedupe gated on plugin
      rollout to installers — see [[plugin-rollout-scope]]

## Open coordination

- **agent-marketing brainstorm** — pinged 06:58 UTC, reply pending via
  `@tertertrere_bot`. Merge their ideas into Phase 1/2/3 above before
  starting work.
- **Plugin rollout (task #3)** — until customer-VM installers ship the
  plugin, only host agents (main/marketing/community here) see these
  commands. Don't promise them to customers in marketing copy yet.
