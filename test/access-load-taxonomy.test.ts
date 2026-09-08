// DIVE-3962 (P03 channel broker, stage 1): compatibility test for the access-file
// load taxonomy shared by the Claude baseline and the codex/grok/agy forks.
//
// Why it is written against access-core and not the servers: the servers long-poll
// Telegram on import, so importing them is unsafe (same constraint parity.test.ts
// documents). The taxonomy was therefore EXTRACTED into plugins/<name>/access-core.ts
// — a sibling module in each self-contained plugin dir — precisely so a test can hold
// the real implementation rather than a re-typed copy of it. The server-side wiring
// that the extraction did not remove (the refusal string, the absence of the old
// deny-all catch) is pinned by static assertion below.
//
// The defect this locks down: every fork answered ANY read failure with
// `DEFAULT_ACCESS`, whose allowFrom is empty — so an access.json that was merely
// unreadable (root-owned after a sudo edit, mid-write rename race) silently denied
// every chat. The baseline had been hardened against exactly that in DIVE-159.
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAccessFile as baseline } from '../plugins/telegram/access-core.ts'
import { readAccessFile as codex } from '../plugins/telegram-codex/access-core.ts'
import { readAccessFile as grok } from '../plugins/telegram-grok/access-core.ts'
import { readAccessFile as agy } from '../plugins/telegram-agy/access-core.ts'
import { readAccessFile as opencode } from '../plugins/telegram-opencode/access-core.ts'
import { readAccessFile as pi } from '../plugins/telegram-pi/access-core.ts'

const PLUGINS = join(import.meta.dir, '..', 'plugins')
const CHANNELS = ['telegram', 'telegram-codex', 'telegram-grok', 'telegram-agy', 'telegram-opencode', 'telegram-pi'] as const
const LOADERS = { telegram: baseline, 'telegram-codex': codex, 'telegram-grok': grok, 'telegram-agy': agy, 'telegram-opencode': opencode, 'telegram-pi': pi }

// A stand-in for each plugin's own Access shape. The taxonomy is generic over it;
// what matters is being able to tell "the file was honoured" from "we fell back".
type Fixture = { allowFrom: string[]; from: 'file' | 'default' }
const fallback = (): Fixture => ({ allowFrom: [], from: 'default' })
const normalize = (raw: unknown): Fixture => ({
  allowFrom: ((raw ?? {}) as any).allowFrom ?? [],
  from: 'file',
})

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dive3962-access-'))
}

describe.each(CHANNELS)('%s access-core load taxonomy', channel => {
  const load = LOADERS[channel]
  const run = (accessFile: string) => load({ accessFile, label: channel, normalize, fallback })

  test('valid file is honoured', () => {
    const dir = scratch()
    const f = join(dir, 'access.json')
    writeFileSync(f, JSON.stringify({ allowFrom: ['1234567890'] }))
    expect(run(f)).toEqual({ allowFrom: ['1234567890'], from: 'file' })
    rmSync(dir, { recursive: true, force: true })
  })

  test('absent file (ENOENT) falls back to defaults — normal first boot', () => {
    const dir = scratch()
    expect(run(join(dir, 'access.json'))).toEqual({ allowFrom: [], from: 'default' })
    rmSync(dir, { recursive: true, force: true })
  })

  test('UNREADABLE file THROWS and is left on disk — never an empty allowlist', () => {
    const dir = scratch()
    const f = join(dir, 'access.json')
    writeFileSync(f, JSON.stringify({ allowFrom: ['1234567890'] }))
    chmodSync(f, 0o000)
    // Guard: running as root defeats the permission bit and would make this a
    // vacuous pass. Assert the read actually fails before grading the taxonomy.
    let unreadable = false
    try { readFileSync(f, 'utf8') } catch { unreadable = true }
    expect(unreadable).toBe(true)

    expect(() => run(f)).toThrow(/Refusing to fall back to empty access \(would deny all\)/)
    chmodSync(f, 0o600)
    // The valid allowlist survived — the failure destroyed nothing.
    expect(JSON.parse(readFileSync(f, 'utf8')).allowFrom).toEqual(['1234567890'])
    rmSync(dir, { recursive: true, force: true })
  })

  test('a directory at the path (EISDIR) throws too — any fs code is not corruption', () => {
    const dir = scratch()
    expect(() => run(dir)).toThrow(/Refusing to fall back to empty access/)
    rmSync(dir, { recursive: true, force: true })
  })

  test('CORRUPT json moves the file aside and falls back — only here is that safe', () => {
    const dir = scratch()
    const f = join(dir, 'access.json')
    writeFileSync(f, '{ not json at all')
    expect(run(f)).toEqual({ allowFrom: [], from: 'default' })
    const left = readdirSync(dir)
    expect(left).not.toContain('access.json')
    expect(left.some(n => n.startsWith('access.json.corrupt-'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the throw names the file and the errno so an operator can act', () => {
    const dir = scratch()
    const f = join(dir, 'access.json')
    writeFileSync(f, '{}')
    chmodSync(f, 0o000)
    try {
      run(f)
      throw new Error('expected a throw')
    } catch (err) {
      const msg = String((err as Error).message)
      expect(msg).toContain(f)
      expect(msg).toContain('EACCES')
      expect(msg).toContain('File left untouched.')
    }
    chmodSync(f, 0o600)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('one implementation, not four copies that drift', () => {
  test('access-core.ts is byte-identical in every channel plugin dir', () => {
    const srcs = CHANNELS.map(c => readFileSync(join(PLUGINS, c, 'access-core.ts'), 'utf8'))
    for (const s of srcs.slice(1)) expect(s).toBe(srcs[0])
  })

  test('no server still answers a failed read with DEFAULT_ACCESS', () => {
    for (const c of CHANNELS) {
      const src = readFileSync(join(PLUGINS, c, 'server.ts'), 'utf8')
      // The regressed shape, verbatim from every fork before this change.
      expect(src).not.toMatch(/catch\s*\{\s*return\s*\{\s*\.\.\.DEFAULT_ACCESS/)
      expect(src).toContain("from './access-core.ts'")
    }
  })
})

describe('divergences that must NOT converge', () => {
  // The forks say "is not on the allowlist"; the baseline's string is quoted in
  // operator docs and in /telegram:access. Converging it would be a silent UX break.
  test('the Claude baseline keeps its own refusal string', () => {
    const src = readFileSync(join(PLUGINS, 'telegram', 'server.ts'), 'utf8')
    expect(src).toContain('is not allowlisted — add via /telegram:access')
  })

  test('the baseline keeps dmPolicy "disabled"; the forks keep "static"', () => {
    expect(readFileSync(join(PLUGINS, 'telegram', 'server.ts'), 'utf8')).toContain("'pairing' | 'allowlist' | 'disabled'")
    for (const c of CHANNELS.slice(1)) {
      expect(readFileSync(join(PLUGINS, c, 'server.ts'), 'utf8')).toContain("'allowlist' | 'static' | 'pairing'")
    }
  })
})
