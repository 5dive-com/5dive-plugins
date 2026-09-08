#!/usr/bin/env bun
/**
 * telegram-runtime generator (DIVE-9).
 *
 * The telegram-{codex,grok,agy} plugins are near-identical wait_for_message
 * bridges that differ only by a handful of runtime knobs (display name, CLI
 * binary, state dir, env-var prefix, plugin-root expr, manifest layout) plus a
 * few genuinely runtime-specific code blocks (model config, turn-mtime liveness
 * source). Hand-forking them is how DIVE-8 drift happened. This makes a new
 * runtime a CONFIG BLOCK instead of a manual fork.
 *
 * Design: telegram-grok is the canonical BASE (it's the cleanest poll-based
 * fork — systemd-managed, hooks.json, manifest present). A runtime is described
 * by runtimes/<slug>.json:
 *
 *   - tokens:  the mechanical knobs. The engine derives an ordered list of
 *              grok-string -> target-string substitutions from them, so the
 *              base's own values map to themselves (generating grok is a
 *              byte-exact identity — the engine's correctness self-check).
 *   - blocks:  which named variant to use for each genuinely-divergent code
 *              region (model config, turn-mtime liveness, manifest layout).
 *              Variants live in blocks/<region>.<variant>.json as exact
 *              find/replace edits against the grok base.
 *
 * Usage:
 *   bun generate.ts <slug>            # write plugins/telegram-<slug>/
 *   bun generate.ts <slug> --out=DIR  # write to DIR instead (used by check.ts)
 *   bun generate.ts --check           # regenerate every runtime to a temp dir
 *                                     # and diff against the committed fork
 */

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync,
} from 'fs'
import { join, dirname } from 'path'

const GEN_DIR = import.meta.dir
const REPO = join(GEN_DIR, '..')
const PLUGINS = join(REPO, 'plugins')
const BASE = 'telegram-grok'
const BASE_DIR = join(PLUGINS, BASE)

// Files the generator owns and asserts byte-exact in --check. node_modules /
// bun.lock are produced by `bun install --production` at STAGE time (install.sh,
// as the claude user), NOT at boot — the `start` script is just `bun server.ts`
// (DIVE-1266: a boot-time `bun install` run as the agent user EEXIST-fails on the
// claude-owned node_modules and blocks server.ts, so the bridge never boots).
// Either way we never copy node_modules/bun.lock.
const COPY_FILES = [
  'server.ts',
  'tna.ts',
  'access-core.ts', // DIVE-3962: runtime-neutral access-file load taxonomy — no tokens, copied byte-exact
  'banner.ts', // DIVE-1558: pure banner decision module — no tokens, copied byte-exact
  'lifecycle.ts', // DIVE-3752: orphan watchdog + start/exit record — copied byte-exact
  'pair.ts',
  'package.json',
  'AGENTS.md',
  'hooks/hooks.json',
  'hooks/notify-stop.ts',
  'hooks/silence-watchdog.ts',
  'hooks/notification-relay.ts',
  'skills/notify-user/SKILL.md',
]

// Per-runtime authored prose. The generator emits a token-subbed STARTING
// scaffold for a brand-new runtime, but these are expected to be hand-edited
// (each runtime's README/TODO describes its own specifics), so --check does NOT
// assert them. They're skipped entirely when an existing fork already has them.
const SCAFFOLD_FILES = ['README.md', 'TODO.md']

// The grok base's own knob values. Substitutions are built as
// (base value -> target value) pairs, so the grok config is a no-op identity.
const BASE_TOKENS = {
  slug: 'grok',
  displayName: 'Grok',
  vendor: 'xAI',
  cliBin: 'grok',
  homeExpr: "process.env.GROK_HOME ?? join(homedir(), '.grok')",
  homeEnvVar: 'GROK_HOME',
  homeDir: 'grok',          // the ~/.<homeDir> state root, in prose paths
  envPrefix: 'GROK',        // GROK_NOTIFY_*, GROK_SILENCE_* knob prefix
  pluginRootVar: 'GROK_PLUGIN_ROOT',
  timeoutKey: 'tool_timeout_sec',
  pkgScope: '@5dive/telegram-grok-mcp',
}

// The base grok package.json version. The generator rewrites this to the
// runtime's single `version` knob in BOTH package.json and the plugin manifest,
// so the two can never drift (the bug this replaces: grok's manifest sat at
// 0.1.15 while its package.json had moved to 0.1.23).
const BASE_VERSION = '0.5.17'

type Tokens = typeof BASE_TOKENS
type Edit = { find: string; replace: string; files?: string[]; optional?: boolean }
type RuntimeConfig = {
  tokens: Partial<Tokens> & { slug: string }
  version: string
  manifest: 'claude-plugin' | 'root' | 'none'
  blocks?: string[]          // names of block variant files under blocks/
  // Second manifest keyword after the slug. Defaults to vendor (lowercased);
  // some runtimes key on their home-dir vendor instead (agy → "gemini").
  manifestKeyword?: string
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Ordered grok->target substitutions. Specific identifiers first so the
// generic `Grok`/`GROK_`/`.grok` sweeps can't clobber them. Every base value
// maps to itself when target == grok, making grok generation an identity.
function buildSubs(t: Tokens): Edit[] {
  const subs: Edit[] = [
    // interruptGrok -> interrupt<Cap(slug)> (function name, derived from slug)
    { find: `interrupt${cap(BASE_TOKENS.slug)}`, replace: `interrupt${cap(t.slug)}` },
    // telegram-grok slug: stderr prefixes, MCP server name, docs URL, helpText
    { find: `telegram-${BASE_TOKENS.slug}`, replace: `telegram-${t.slug}` },
    // package name
    { find: BASE_TOKENS.pkgScope, replace: t.pkgScope },
    // state-dir home expr (whole RHS, incl. env-home var + default dir)
    { find: BASE_TOKENS.homeExpr, replace: t.homeExpr },
    // plugin-root var in hooks.json + .mcp.json (before the generic GROK_ sweep)
    { find: BASE_TOKENS.pluginRootVar, replace: t.pluginRootVar },
    // home env var in prose ("honors GROK_HOME")
    { find: BASE_TOKENS.homeEnvVar, replace: t.homeEnvVar },
    // vendor (before Grok, since "xAI Grok" -> "<vendor> <displayName>")
    { find: BASE_TOKENS.vendor, replace: t.vendor },
    // display name: CLI_LABEL literal + all prose
    { find: BASE_TOKENS.displayName, replace: t.displayName },
    // CLI binary
    { find: `const CLI_BIN = '${BASE_TOKENS.cliBin}'`, replace: `const CLI_BIN = '${t.cliBin}'` },
    { find: `Respawn ${BASE_TOKENS.cliBin}`, replace: `Respawn ${t.cliBin}` },
    // state-root dir name in prose paths (~/.grok/config.toml, ~/.grok/channels)
    { find: `.${BASE_TOKENS.homeDir}`, replace: `.${t.homeDir}` },
    // remaining env-knob prefix (GROK_NOTIFY_*, GROK_SILENCE_*)
    { find: `${BASE_TOKENS.envPrefix}_`, replace: `${t.envPrefix}_` },
    // MCP tool-timeout config key name (prose)
    { find: BASE_TOKENS.timeoutKey, replace: t.timeoutKey },
  ]
  // Drop no-op identity subs so the edit log is meaningful.
  return subs.filter(s => s.find !== s.replace)
}

// Bare lowercase CLI-binary name in prose/literals ("grok finishes…", the
// '🟢 grok: turn complete' ping, "grok's own retry"). Run as a word-boundary
// regex AFTER the literal subs so telegram-<slug>, .<homeDir> and GROK_/Grok
// (different case/context) are already consumed and can't be clobbered.
function sweepCliBin(text: string, t: Tokens): string {
  if (t.cliBin === BASE_TOKENS.cliBin) return text
  return text.replace(new RegExp(`\\b${BASE_TOKENS.cliBin}\\b`, 'g'), t.cliBin)
}

function applyEdit(text: string, e: Edit): string {
  if (!text.includes(e.find)) {
    if (e.optional) return text
    throw new Error(`edit find-string not present:\n  ${JSON.stringify(e.find).slice(0, 120)}`)
  }
  return text.replaceAll(e.find, e.replace)
}

function loadConfig(slug: string): RuntimeConfig {
  const path = join(GEN_DIR, 'runtimes', `${slug}.json`)
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as RuntimeConfig
  if (cfg.tokens.slug !== slug) {
    throw new Error(`runtimes/${slug}.json declares slug='${cfg.tokens.slug}', expected '${slug}'`)
  }
  return cfg
}

function loadBlock(name: string): Edit[] {
  const path = join(GEN_DIR, 'blocks', `${name}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as Edit[]
}

function generate(slug: string, outDir: string): void {
  const cfg = loadConfig(slug)
  const tokens: Tokens = { ...BASE_TOKENS, ...cfg.tokens }
  const subs = buildSubs(tokens)
  // GEN_NO_BLOCKS: token-only mode used by derive-blocks.ts to compute the
  // structural delta against a committed hand-fork.
  const blockEdits = process.env.GEN_NO_BLOCKS === '1' ? [] : (cfg.blocks ?? []).flatMap(loadBlock)

  const render = (file: string): string | null => {
    const src = join(BASE_DIR, file)
    if (!existsSync(src)) return null
    let text = readFileSync(src, 'utf8')
    // tna.ts (shared tap-resolver), banner.ts (DIVE-1558 shared needs-you
    // banner decision module) and lifecycle.ts (DIVE-3752 orphan watchdog) are
    // kept BYTE-IDENTICAL across the base and every fork (the parity tests assert
    // it; the only per-runtime difference lives in server.ts). Copy them verbatim:
    // the generic name-sweep would otherwise rewrite "grok" inside their own
    // "byte-identical across base + grok/codex/agy forks" comments into nonsense
    // ("agy/codex/agy"), breaking that byte-identity.
    //
    // lifecycle.ts is byte-exact for a second, sharper reason: it cites
    // `plugins/telegram/server.ts` by path as the place the dead ppid clause came
    // from, and a swept copy would claim that history happened in a fork it never
    // happened in. A shared module's provenance must survive being copied.
    if (file === 'tna.ts' || file === 'banner.ts' || file === 'lifecycle.ts') return text
    // Mechanical token subs + bare-cliBin sweep FIRST, so the text now reads as
    // the target runtime everywhere the knobs reach. Structural blocks run AFTER,
    // so their find-strings match the already-tokenized text and their replace
    // bodies are written as final target text (no further substitution applied).
    for (const e of subs) {
      if (e.files && !e.files.includes(file)) continue
      text = text.replaceAll(e.find, e.replace)
    }
    text = sweepCliBin(text, tokens)
    for (const e of blockEdits) {
      if (e.files && !e.files.includes(file)) continue
      text = applyEdit(text, e)
    }
    // Single version source — package.json + manifest both carry cfg.version.
    if (file === 'package.json') {
      text = text.replaceAll(`"version": "${BASE_VERSION}"`, `"version": "${cfg.version}"`)
    }
    return text
  }

  // Clean output dir of generator-owned files (leave node_modules/bun.lock).
  for (const f of COPY_FILES) {
    const p = join(outDir, f)
    if (existsSync(p)) rmSync(p)
  }

  for (const file of COPY_FILES) {
    const text = render(file)
    if (text == null) continue
    const dst = join(outDir, file)
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, text)
  }

  // Scaffold authored-prose files only when the target doesn't already have one
  // (a brand-new runtime gets a starting point; existing forks keep their edits).
  for (const file of SCAFFOLD_FILES) {
    const dst = join(outDir, file)
    if (existsSync(dst)) continue
    const text = render(file)
    if (text == null) continue
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, text)
  }

  writeManifest(cfg, tokens, outDir)
  lintNoStrays(slug, tokens, outDir)
}

// Emit the plugin manifest + MCP wiring in the layout the runtime uses.
function writeManifest(cfg: RuntimeConfig, t: Tokens, outDir: string): void {
  const plugin = {
    name: `telegram-${t.slug}`,
    description:
      `Telegram channel for ${t.vendor}'s ${t.displayName} CLI — stdio MCP bridge with `
      + `access control, poll-based inbound (wait_for_message), and bundled lifecycle hooks `
      + `(turn-complete ping, silence watchdog, error relay). `
      + `Sibling to the telegram (Claude Code) and telegram-codex plugins, maintained by 5dive.`,
    version: cfg.version,
    author: { name: '5dive', email: 'support@5dive.com' },
    homepage: `https://github.com/5dive-ai/5dive-plugins/tree/main/plugins/telegram-${t.slug}`,
    keywords: ['telegram', 'messaging', 'channel', 'mcp', t.slug, cfg.manifestKeyword ?? t.vendor.toLowerCase()],
  }
  const j = (o: unknown) => JSON.stringify(o, null, 2) + '\n'
  // Hand-format the MCP config so the args array stays inline (matches the
  // committed forks; JSON.stringify would expand it one-element-per-line).
  const mcpJson =
    `{\n`
    + `  "mcpServers": {\n`
    + `    "telegram": {\n`
    + `      "command": "bun",\n`
    + `      "args": ["run", "--cwd", "\${${t.pluginRootVar}}", "--shell=bun", "--silent", "start"]\n`
    + `    }\n`
    + `  }\n`
    + `}\n`
  if (cfg.manifest === 'claude-plugin') {
    mkdirSync(join(outDir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(outDir, '.claude-plugin', 'plugin.json'), j(plugin))
    writeFileSync(join(outDir, '.mcp.json'), mcpJson)
  } else if (cfg.manifest === 'root') {
    // agy-style: root plugin.json + mcp_config.json; MCP wiring is global+absolute
    // so the plugin-root var is CLAUDE_PLUGIN_ROOT regardless of runtime.
    writeFileSync(join(outDir, 'plugin.json'), j(plugin))
    writeFileSync(join(outDir, 'mcp_config.json'), mcpJson)
  }
  // 'none' (codex): MCP is wired into the runtime's own config by 5dive
  // provisioning, no in-repo manifest.
}

// Guard against an un-substituted base token leaking into a non-grok fork.
function lintNoStrays(slug: string, t: Tokens, outDir: string): void {
  if (slug === BASE_TOKENS.slug) return
  const patterns: Array<[RegExp, string]> = [
    [/\bGrok\b/, 'Grok'],
    [/\bGROK_/, 'GROK_'],
    [/\.grok\b/, '.grok'],
    [/telegram-grok/, 'telegram-grok'],
    [/interruptGrok/, 'interruptGrok'],
  ]
  const offenders: string[] = []
  for (const file of COPY_FILES) {
    const p = join(outDir, file)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const [re, label] of patterns) {
      const m = text.match(re)
      if (m) offenders.push(`${file}: stray '${label}' near ${JSON.stringify(text.slice(Math.max(0, m.index! - 20), m.index! + 30))}`)
    }
  }
  if (offenders.length) {
    throw new Error(`stray base tokens in generated telegram-${slug}:\n  ${offenders.join('\n  ')}`)
  }
}

// ---- diff (check mode) ----

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git' || name === 'bun.lock') continue
      const full = join(d, name)
      const r = rel ? `${rel}/${name}` : name
      if (statSync(full).isDirectory()) walk(full, r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

function diffAgainstCommitted(slug: string, genDir: string): { file: string; status: string }[] {
  const committed = join(PLUGINS, `telegram-${slug}`)
  const drift: { file: string; status: string }[] = []
  const skip = new Set(SCAFFOLD_FILES)
  const genFiles = new Set(listFiles(genDir).filter(f => !skip.has(f)))
  const comFiles = existsSync(committed) ? new Set(listFiles(committed).filter(f => !skip.has(f))) : new Set<string>()
  for (const f of new Set([...genFiles, ...comFiles])) {
    const g = genFiles.has(f), c = comFiles.has(f)
    if (g && !c) { drift.push({ file: f, status: 'only-in-generated' }); continue }
    if (!g && c) { drift.push({ file: f, status: 'only-in-committed' }); continue }
    const gt = readFileSync(join(genDir, f), 'utf8')
    const ct = readFileSync(join(committed, f), 'utf8')
    if (gt !== ct) drift.push({ file: f, status: 'differs' })
  }
  return drift
}

function runtimeSlugs(): string[] {
  return readdirSync(join(GEN_DIR, 'runtimes'))
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort()
}

// ---- CLI ----

const args = process.argv.slice(2)
if (args.includes('--check')) {
  const tmp = join(GEN_DIR, '.check-out')
  rmSync(tmp, { recursive: true, force: true })
  let totalDrift = 0
  for (const slug of runtimeSlugs()) {
    const out = join(tmp, `telegram-${slug}`)
    mkdirSync(out, { recursive: true })
    try {
      generate(slug, out)
    } catch (err) {
      console.error(`✗ telegram-${slug}: generate failed — ${err instanceof Error ? err.message : err}`)
      totalDrift++
      continue
    }
    // A config with no committed plugin is a not-yet-materialized runtime —
    // generate it (proves it builds) but don't count it as drift. Run
    // `bun generate.ts <slug>` to materialize it under plugins/.
    if (!existsSync(join(PLUGINS, `telegram-${slug}`))) {
      console.log(`◦ telegram-${slug}: generates clean (no committed fork yet — example/pending runtime)`)
      continue
    }
    const drift = diffAgainstCommitted(slug, out)
    if (drift.length === 0) {
      console.log(`✓ telegram-${slug}: byte-exact match with committed fork`)
    } else {
      totalDrift += drift.length
      console.log(`△ telegram-${slug}: ${drift.length} file(s) drift from committed:`)
      for (const d of drift) console.log(`    ${d.status.padEnd(18)} ${d.file}`)
    }
  }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(totalDrift > 0 ? 1 : 0)
} else {
  const slug = args.find(a => !a.startsWith('--'))
  if (!slug) {
    console.error('usage: bun generate.ts <slug> [--out=DIR] | bun generate.ts --check')
    process.exit(2)
  }
  const outFlag = args.find(a => a.startsWith('--out='))
  const outDir = outFlag ? outFlag.slice('--out='.length) : join(PLUGINS, `telegram-${slug}`)
  mkdirSync(outDir, { recursive: true })
  generate(slug, outDir)
  console.log(`generated telegram-${slug} -> ${outDir}`)
}
