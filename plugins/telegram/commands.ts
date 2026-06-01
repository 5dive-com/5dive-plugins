/**
 * Central command registry for the Telegram channel plugin.
 *
 * Single source of truth for: dispatcher registration in server.ts,
 * the /help body, and the BotFather `/` picker (setMyCommands).
 * Add a new command → add one entry here + one handler in server.ts.
 */

export type CommandScope =
  /** DM-only, any allowed sender (paired or unpaired). Handler may branch on pairing itself. */
  | 'allowed'
  /** DM-only, sender must be in access.allowFrom. Dispatcher rejects with a standard message. */
  | 'paired'
  /** Same as 'paired', but the command is also hidden from /help, BotFather, and
   *  the dispatcher silently drops it when the host is not 5dive-managed
   *  (read5diveVersion() returns null). Used for commands that wrap `sudo 5dive`
   *  subcommands — surfacing them on an upstream-only host would confuse users
   *  who can't act on them. */
  | 'paired-5dive'

export interface CommandDef {
  name: string
  /** Short, BotFather-compatible (<= 256 chars, no leading slash). */
  description: string
  scope: CommandScope
  /** Hide from /help and the BotFather `/` picker. Telegram already auto-includes /start. */
  hidden?: boolean
}

export const COMMAND_REGISTRY: CommandDef[] = [
  {
    name: 'start',
    description: 'Pair this chat',
    scope: 'allowed',
    hidden: true,
  },
  {
    name: 'help',
    description: 'Show commands',
    scope: 'allowed',
  },
  {
    name: 'status',
    description: 'Pairing, usage, model',
    scope: 'allowed',
  },
  {
    name: 'context',
    description: 'Context-window usage',
    scope: 'paired',
  },
  {
    name: 'stop',
    description: 'Interrupt task',
    scope: 'paired',
  },
  {
    name: 'restart',
    description: 'Respawn claude',
    scope: 'paired',
  },
  {
    name: 'clear',
    description: 'Clear context',
    scope: 'paired',
  },
  {
    // Save-only: pins the current session id. Paired with /resume, which
    // relies on the 5dive launcher honoring a one-shot resume marker — so
    // both are 5dive-scoped (hidden + dropped on upstream-only hosts).
    name: 'checkpoint',
    description: 'Save session to resume later',
    scope: 'paired-5dive',
  },
  {
    name: 'resume',
    description: 'Resume the saved session',
    scope: 'paired-5dive',
  },
  {
    name: 'agents',
    description: 'Team',
    scope: 'paired-5dive',
  },
  {
    name: 'tasks',
    description: 'List open tasks',
    scope: 'paired-5dive',
  },
  {
    // `/task add <title>` creates; bare `/task` prints usage. List lives at
    // /tasks (mirrors the `5dive task ls` vs `add` split).
    name: 'task',
    description: 'Add a task — /task add <title>',
    scope: 'paired-5dive',
  },
  {
    name: 'org',
    description: 'Show the agent org chart',
    scope: 'paired-5dive',
  },
  {
    name: 'update',
    description: 'Refresh plugins, then restart',
    scope: 'paired-5dive',
  },
  {
    name: 'model',
    description: 'Pick model + effort',
    scope: 'paired',
  },
  {
    // Hidden, text-arg only (`/effort high`). The picker UX is part of
    // /model now; the entry stays so the BotFather dispatcher still
    // routes the slash for scripting / muscle memory.
    name: 'effort',
    description: 'Pick reasoning effort',
    scope: 'paired',
    hidden: true,
  },
  {
    name: 'account',
    description: 'Pick auth account',
    scope: 'paired-5dive',
  },
  {
    name: 'usage',
    description: '5h/7d limit usage',
    scope: 'paired-5dive',
  },
  {
    name: 'goal',
    description: 'Self-paced goal',
    scope: 'paired',
  },
]

/** Short model alias → full Claude Code model ID. Add new tiers here.
 *  Keys here are also the picker button labels, so order is the display order. */
export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
}

/** Effort levels accepted by Claude Code's settings.json. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** Render the /help body from the registry. Hidden commands are omitted.
 *  When `fiveDivePresent` is false, 'paired-5dive'-scoped commands are also
 *  skipped — calling them on an upstream host returns a "5dive not detected"
 *  error so we'd rather not advertise them. */
export function renderHelpBody(
  registry: CommandDef[] = COMMAND_REGISTRY,
  fiveDivePresent: boolean = true,
): string {
  const visible = registry.filter(
    c => !c.hidden && (fiveDivePresent || c.scope !== 'paired-5dive'),
  )
  const lines = [
    `This bot bridges your Telegram chat to a Claude Code session — ` +
      `freeform messages and photos are forwarded; replies and reactions come back.`,
    ``,
    `Commands:`,
    ...visible.map(c => `/${c.name} — ${c.description}`),
    ``,
    `Forwarded messages go straight to the agent — no slash prefix needed.`,
  ]
  return lines.join('\n')
}

/** Shape expected by Telegram's setMyCommands. */
export interface BotCommand {
  command: string
  description: string
}

/**
 * Derive the BotFather `/` picker entries from the registry.
 * Hidden entries are skipped — /start is auto-included by Telegram clients anyway.
 * Telegram caps descriptions at 256 chars; we don't truncate here because our
 * authored descriptions are short by convention. Add a check if that changes.
 */
export function botFatherCommands(
  registry: CommandDef[] = COMMAND_REGISTRY,
  fiveDivePresent: boolean = true,
): BotCommand[] {
  return registry
    .filter(c => !c.hidden && (fiveDivePresent || c.scope !== 'paired-5dive'))
    .map(c => ({ command: c.name, description: c.description }))
}
