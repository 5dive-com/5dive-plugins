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
    description: 'Pairing instructions (run before linking a session)',
    scope: 'allowed',
    hidden: true,
  },
  {
    name: 'help',
    description: 'Show available commands',
    scope: 'allowed',
  },
  {
    name: 'status',
    description: 'Pairing state + session health (uptime, model, last activity)',
    scope: 'allowed',
  },
  {
    name: 'stop',
    description: "Interrupt the agent's current task (Ctrl-C)",
    scope: 'paired',
  },
  {
    name: 'restart',
    description: 'Kill claude and let systemd respawn it',
    scope: 'paired',
  },
  {
    name: 'agents',
    description: 'List sibling agents on this host',
    scope: 'paired',
  },
  {
    name: 'model',
    description: 'Show or switch model (opus | sonnet | haiku)',
    scope: 'paired',
  },
  {
    name: 'effort',
    description: 'Show or switch reasoning effort (low | medium | high | xhigh | max)',
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

/** Render the /help body from the registry. Hidden commands are omitted. */
export function renderHelpBody(registry: CommandDef[] = COMMAND_REGISTRY): string {
  const visible = registry.filter(c => !c.hidden)
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
): BotCommand[] {
  return registry
    .filter(c => !c.hidden)
    .map(c => ({ command: c.name, description: c.description }))
}
