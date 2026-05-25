import { homedir } from 'os'
import { join } from 'path'

// Mirror the path resolution in ../server.ts so the hooks read/write the
// same files the MCP server does. TELEGRAM_STATE_DIR override exists for
// tests that pre-seed access.json + silence.json under a tmp dir.
export const STATE_DIR =
  process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const SILENCE_FILE = join(STATE_DIR, 'silence.json')

// Prefix of the MCP tools the plugin exposes. Used by stop-reply-check
// (and the silence watchdog indirectly) to recognize "agent talked to
// the proper channel" vs "agent talked to the transcript" turns.
export const TG_TOOL_PREFIX = 'mcp__plugin_telegram_telegram__'
