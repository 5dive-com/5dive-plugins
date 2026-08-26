// DIVE-3752 iteration 2 — NOTHING IN THIS REPO PARSES AN ENTRY POINT.
//
// Iteration 1 shipped a `plugins/telegram/server.ts` whose new import had been
// inserted INSIDE another import's brace list. Every existing gate was green:
//
//   * `bun test` — 933/0, but no test imports any `plugins/*/server.ts`
//     (repo CI runs with no plugin deps, so a server import would explode on
//     `grammy` long before it ever reached a syntax error).
//   * `bun generator/generate.ts --check` — byte-exact, because the generator
//     is a TEXT TRANSFORM. It never parses what it copies.
//   * parity — the only workflow, and it is those two steps.
//
// And the defect hid from a differential the way only this repo's shape allows:
// the five generated forks parsed FINE at the same line, because the generator
// deletes the whole msglog/council/gatereply block for forks and swallowed the
// orphaned `import {` opener on the way through. 7 clean / 1 broken, and the
// broken one is the BASE the other five are generated from.
//
// So the gate has to be a real parse, it has to cover the base and not just its
// derivatives, and it has to be runnable with ZERO plugin dependencies
// installed — which `bun build --no-bundle` is: it transpiles without resolving
// a single import specifier. Measured on a worktree with no node_modules in any
// of the eight plugin dirs.

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PLUGINS = join(import.meta.dir, '..', 'plugins')

// Transpile-only. Returns null on success, the compiler's stderr on failure.
// No bundling, so no import is resolved and no dependency needs to exist.
function parseError(file: string): string | null {
  const r = Bun.spawnSync(['bun', 'build', '--no-bundle', file, '--outfile=/dev/null'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (r.exitCode === 0) return null
  return (r.stderr.toString() + r.stdout.toString()).trim() || `exit ${r.exitCode}`
}

function tsFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  }
  walk(PLUGINS)
  return out.sort()
}

const PLUGIN_DIRS = readdirSync(PLUGINS, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name !== 'node_modules')
  .map(e => e.name)
  .sort()

// ── the gate itself ─────────────────────────────────────────────────────────

describe('every plugin TypeScript file parses', () => {
  const files = tsFiles()

  test('the sweep is not vacuous — it found the servers it is supposed to grade', () => {
    expect(files.length).toBeGreaterThan(20)
    for (const d of PLUGIN_DIRS) {
      expect(files).toContain(join(PLUGINS, d, 'server.ts'))
    }
  })

  for (const f of tsFiles()) {
    test(f.slice(f.indexOf('plugins/')), () => {
      expect(parseError(f)).toBeNull()
    })
  }
})

// ── the entry points specifically, derived from what actually launches ──────
//
// Not a hardcoded list: the launcher runs `bun run start`, so the file named by
// each package.json's `start` script IS the entry point. A plugin that renames
// its entry point must not be able to fall out of this gate silently.

describe('the file each plugin actually launches parses', () => {
  for (const d of PLUGIN_DIRS) {
    const pkgPath = join(PLUGINS, d, 'package.json')
    if (!existsSync(pkgPath)) continue
    const start = String(JSON.parse(readFileSync(pkgPath, 'utf8'))?.scripts?.start ?? '')
    const named = [...start.matchAll(/bun\s+([A-Za-z0-9_.\-/]+\.ts)/g)].map(m => m[1])

    test(`${d}: start script names a .ts entry point`, () => {
      expect(named.length).toBeGreaterThan(0)
    })

    for (const rel of named) {
      test(`${d}: ${rel} parses`, () => {
        const abs = join(PLUGINS, d, rel)
        expect(existsSync(abs)).toBe(true)
        expect(parseError(abs)).toBeNull()
      })
    }
  }
})

// ── positive control: prove the gate can FAIL ───────────────────────────────
//
// A sweep that returns "all clean" is worth nothing until the same command has
// been shown to reject the exact defect it exists for. This reproduces
// iteration 1's shape — an `import` statement inside another import's brace
// list — and requires the gate to reject it.

describe('the gate can fire', () => {
  test('an import nested inside another import\'s brace list is REJECTED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dive3752-parse-'))
    try {
      const bad = join(dir, 'bad.ts')
      writeFileSync(bad, [
        `import { summarizeNeeds } from './banner'`,
        `import {`,
        `import { installLifecycle } from './lifecycle.ts'`,
        `  appendMessage as msglogAppend,`,
        `} from './msglog'`,
        ``,
      ].join('\n'))
      const err = parseError(bad)
      expect(err).not.toBeNull()
      expect(err).toContain('error')

      // ...and the well-formed version of the same file passes, so the control
      // is grading the DEFECT and not merely the temp directory.
      const good = join(dir, 'good.ts')
      writeFileSync(good, [
        `import { summarizeNeeds } from './banner'`,
        `import { installLifecycle } from './lifecycle.ts'`,
        `import {`,
        `  appendMessage as msglogAppend,`,
        `} from './msglog'`,
        ``,
      ].join('\n'))
      expect(parseError(good)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
