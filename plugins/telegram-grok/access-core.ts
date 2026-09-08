// Runtime-neutral access-file load taxonomy (DIVE-3962 P03, stage 1).
//
// AUTHORED ONCE, emitted byte-identically into every channel plugin dir. Each
// plugins/<name>/ installs as a self-contained package (own package.json +
// bun.lock), so this is a sibling module, never a cross-plugin import.
//
// It owns exactly one decision: what a FAILED read of access.json means. That
// decision is security-critical and it had drifted. The Claude baseline splits
// three ways; every runtime fork collapsed all three into a single
// `catch { return DEFAULT_ACCESS }`, and DEFAULT_ACCESS has an EMPTY allowFrom
// — i.e. on a momentarily unreadable file the forks silently DENY EVERY CHAT.
// That is the exact failure DIVE-159 hardened the baseline against (a `sudo`
// root edit of access.json → EACCES → wiped allowlist → dead sends), so the
// forks shipped the regression the baseline carries a comment about.
//
// The three cases, and why each is what it is:
//   ENOENT      — no file yet is the normal first-boot state. Use defaults.
//   any fs code — EACCES/EBUSY/EISDIR/... is NOT corruption. The file may be
//                 perfectly valid and momentarily unreadable (wrong ownership
//                 after a root edit, a mid-write rename race, transient IO).
//                 Preserve it and fail LOUDLY; falling back to empty access
//                 would deny all chats while looking like a config problem.
//   no fs code  — JSON.parse threw ⇒ the file really is corrupt. Only now is
//                 it safe to move it aside and start fresh.
import { readFileSync, renameSync } from 'node:fs'

export type AccessLoad<T> = {
  /** Absolute path to access.json. */
  accessFile: string
  /** Prefix for operator-facing messages, e.g. 'telegram channel'. */
  label: string
  /** Apply this plugin's own field defaulting to the parsed JSON. */
  normalize: (parsed: unknown) => T
  /** This plugin's empty/default access, used only for ENOENT and corruption. */
  fallback: () => T
}

/**
 * Read and normalize access.json under the taxonomy above.
 *
 * THROWS on a filesystem read error — callers must not swallow it. An empty
 * allowlist is indistinguishable from "deny everyone", so a read failure must
 * never be answered with defaults.
 */
export function readAccessFile<T>(o: AccessLoad<T>): T {
  try {
    return o.normalize(JSON.parse(readFileSync(o.accessFile, 'utf8')))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return o.fallback()
    if (code) {
      throw new Error(
        `${o.label}: cannot read ${o.accessFile} (${code}) — check ownership/permissions. ` +
          `Refusing to fall back to empty access (would deny all). File left untouched.`,
      )
    }
    try {
      renameSync(o.accessFile, `${o.accessFile}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write(`${o.label}: access.json is corrupt, moved aside. Starting fresh.\n`)
    return o.fallback()
  }
}
