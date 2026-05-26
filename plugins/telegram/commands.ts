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
    description: 'Pairing instructions',
    scope: 'allowed',
    hidden: true,
  },
  {
    name: 'help',
    description: 'List commands',
    scope: 'allowed',
  },
  {
    name: 'status',
    description: 'Pairing, usage, model, context',
    scope: 'allowed',
  },
  {
    name: 'stop',
    description: 'Interrupt current task',
    scope: 'paired',
  },
  {
    name: 'restart',
    description: 'Respawn claude (kill + systemd)',
    scope: 'paired',
  },
  {
    name: 'clear',
    description: 'Wipe context (in-place; no respawn)',
    scope: 'paired',
  },
  {
    name: 'agents',
    description: 'List or control sibling agents',
    scope: 'paired-5dive',
  },
  {
    name: 'model',
    description: 'Show or switch model',
    scope: 'paired',
  },
  {
    name: 'effort',
    description: 'Show or switch reasoning effort',
    scope: 'paired',
  },
  {
    name: 'account',
    description: 'Show or switch auth account',
    scope: 'paired-5dive',
  },
  {
    name: 'goal',
    description: 'Self-paced goal via /loop',
    scope: 'paired',
  },
]

/** Short model alias → full Claude Code model ID. Add new tiers here. */
export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
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
