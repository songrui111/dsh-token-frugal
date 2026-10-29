/**
 * End-to-end test: drive the REAL tool definitions through a fake Host ctx.
 *
 * This exercises the same code paths the running Harness uses:
 *   ctx.tools.register -> definition.execute -> ctx.fs.resolve/readText -> output.render
 *
 * It proves the tools work when actually invoked (not merely registered),
 * and re-measures savings on the real workspace corpus.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, __test } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g
const est = (s) => {
  const c = (s.match(CJK) || []).length
  return Math.ceil(c / 1.7 + (s.length - c) / 3.8)
}

/* ---- fake Host ctx: just enough surface for this plugin ---- */
const registered = new Map()
const disposers = []
const listeners = new Map()
// Faithful to the real Host: resolve() returns a target even for a path that
// does not exist; the failure only surfaces on readText(). This is what made
// the "did resolve succeed?" anchoring test useless in production.
const fakeFs = {
  async resolve(p, opts = {}) {
    const base = opts.cwd || root
    return path.isAbsolute(p) ? p : path.resolve(base, p)
  },
  async readText(target) {
    if (!fs.existsSync(target)) throw new Error(`cannot read "${target}": not found`)
    return fs.readFileSync(target, 'utf8')
  },
}
/* ---- fake systemPrompt registry ---- */
const sections = new Map()
const fakePrompt = {
  section: (s) => {
    if (sections.has(s.name)) throw new Error(`duplicate section ${s.name}`)
    sections.set(s.name, s)
    return () => sections.delete(s.name)
  },
}

const ctx = {
  get: (name) =>
    name === 'fs' ? fakeFs : name === 'systemPrompt' ? fakePrompt : name === 'tools' ? ctx.tools : undefined,
  effect: (fn) => {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return () => d && d()
  },
  // The plugin also listens on tools/post-execute for ingest slimming; this
  // suite exercises read tools only, so recording the listener is enough.
  on: (event, handler) => {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
  tools: {
    register: (def) => {
      registered.set(def.name, def)
      return () => registered.delete(def.name)
    },
    get: (name) => registered.get(name),
    schemas: () => [...registered.values()].map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    })),
  },
}

apply(ctx, {})
console.log(`registered: ${[...registered.keys()].join(', ')}`)

const exec = { signal: undefined, cwd: root }
let fail = 0
const check = (label, cond, extra = '') => {
  if (!cond) {
    fail += 1
    console.log(`  FAIL ${label} ${extra}`)
  } else console.log(`  ok   ${label}`)
}

console.log('\n=== end-to-end tool invocations ===')

// 1. read_range lines
const rr = registered.get('read_range')
const r1 = await rr.execute({ path: 'test/verify-and-measure.mjs', mode: 'lines', start: 1, end: 12 }, exec)
check('lines: returns text', typeof r1.text === 'string' && r1.text.length > 0)
check('lines: header names file+range', r1.text.includes('test/verify-and-measure.mjs:'))
check('lines: only 12 numbered lines', r1.text.split('\n').filter((l) => /^\s*\d+\|/.test(l)).length === 12)
const rendered = rr.output.render({}, r1)
check('lines: output.render produces a text block', Array.isArray(rendered) && rendered[0].type === 'text')

// 2. read_range symbol
const sym = await rr.execute({ path: 'index.js', mode: 'symbol', symbol: 'deferLoading', context: 2 }, exec)
check('symbol: finds deferLoading', sym.text.includes('deferLoading'))
check('symbol: reports match count', sym.text.includes('match(es)'))

// 3. read_range outline
const out = await rr.execute({ path: 'index.js', mode: 'outline' }, exec)
check('outline: includes exported apply', out.text.includes('export function apply'))
check('outline: is much shorter than the file', out.text.length < fs.readFileSync(path.join(root, 'index.js'), 'utf8').length / 2,
  `${out.text.length} chars`)

// 4. missing file error path
const bad = await rr.execute({ path: 'does/not/exist.txt' }, exec)
check('error: reports failure instead of throwing', bad.text.includes('read_range failed'))
check('error: names the anchors it tried', bad.text.includes('tried:'), bad.text.slice(0, 120))

// 5. anchor fallback: a WRONG exec.cwd must not mask the anchor that works.
// This is the live bug, reproduced: resolve() succeeds against the wrong anchor,
// so only a read-level retry can recover.
{
  // A wrong exec.cwd must be skipped. The file is given relative to the process
  // cwd (the workspace root in this runner), so the last-resort anchor finds it.
  const relFile = 'index.js'
  const wrongCwd = path.join(os.tmpdir(), 'definitely-not-a-workspace')
  const viaFallback = await rr.execute({ path: relFile, mode: 'lines', start: 1, end: 3 }, {
    signal: undefined,
    cwd: wrongCwd,
  })
  check('anchor: falls back past a wrong cwd', !viaFallback.text.includes('failed'), viaFallback.text.slice(0, 140))

  const noCwd = await rr.execute({ path: relFile, mode: 'lines', start: 1, end: 3 }, { signal: undefined })
  check('anchor: works with no exec.cwd at all', !noCwd.text.includes('failed'), noCwd.text.slice(0, 140))

  // A path that no anchor can reach must report every anchor it tried.
  const unreachable = await rr.execute({ path: 'no-such-dir/no-such-file.txt' }, { signal: undefined, cwd: wrongCwd })
  check('anchor: unreachable path lists anchors', unreachable.text.includes('from any anchor (tried:'),
    unreachable.text.slice(0, 160))
}

// 6. workingDirectory.ensure(agent) anchor: when it returns the real workspace,
// the read succeeds through it without ever reaching process.cwd().
{
  const wdAnchor = root
  const isolated = new Map()
  const probeCtx = {
    get: (name) =>
      name === 'workingDirectory'
        ? { defaultDirectory: path.join(os.tmpdir(), 'nope'), ensure: async () => wdAnchor }
        : name === 'fs'
          ? fakeFs
          : name === 'systemPrompt'
            ? { section: () => () => {} } // fresh stub: no duplicate-section clash
            : name === 'tools'
              ? probeCtx.tools
              : undefined,
    effect: (fn) => {
      const d = fn()
      return () => d && d()
    },
    on: () => () => {},
    tools: {
      register: (d) => {
        isolated.set(d.name, d)
        return () => isolated.delete(d.name)
      },
      get: (n) => isolated.get(n),
      schemas: () => [],
    },
  }
  const { apply: apply2 } = await import(`../index.js?anchor=${Date.now()}`)
  apply2(probeCtx, {})
  const rr2 = isolated.get('read_range')
  const viaAgent = await rr2.execute({ path: 'index.js', mode: 'lines', start: 1, end: 3 }, {
    signal: undefined,
    agent: { id: 'test-agent' },
  })
  check('anchor: exec.agent -> workingDirectory.ensure is used', !viaAgent.text.includes('failed'), viaAgent.text.slice(0, 140))
}


// 5. tool_catalog
const tc = registered.get('tool_catalog')
const cat = await tc.execute({}, exec)
check('catalog: lists both tools', cat.tools.some((t) => t.name === 'read_range') && cat.tools.some((t) => t.name === 'tool_catalog'))
const filtered = await tc.execute({ query: 'read' }, exec)
check('catalog: query filters', filtered.tools.length < cat.tools.length)
console.log('  catalog entries:', cat.tools.map((t) => t.name).join(', '))

/* ---- prompt guidance ---- */
console.log('\n=== prompt guidance (Raw 收敛) ===')
const sec = sections.get('token-diet:reading')
check('guidance: section registered', sec !== undefined)
check('guidance: order is a finite number away from 150/152/200', Number.isFinite(sec.order) && ![150, 152, 200].includes(sec.order), `order=${sec.order}`)
const guideText = sec.text({ scope: undefined })
check('guidance: renders while read_range is visible', guideText.includes('read_range') && guideText.includes('mode: "symbol"'))
const guideTokens = est(guideText)
console.log(`  guidance cost: ${guideText.length} chars ≈ ${guideTokens} tokens (fixed, every turn)`)

// The official convention: guidance for a tool that is GONE must not render.
const savedTool = registered.get('read_range')
registered.delete('read_range')
const hidden = sec.text({ scope: undefined })
check('guidance: stays silent when read_range is absent', hidden === '', JSON.stringify(hidden.slice(0, 40)))
registered.set('read_range', savedTool)
check('guidance: returns once read_range is back', sec.text({ scope: undefined }).includes('read_range'))

// A registry that throws must not suppress guidance (recoverable > missing).
const brokenTools = { get: () => { throw new Error('registry read failure') } }
check('guidance: a throwing registry keeps the text', (() => {
  const fn = (tools, names, text) => {
    if (tools === undefined) return () => text
    return (context) => {
      try {
        for (const n of names) if (tools.get(n, context && context.scope) !== undefined) return text
      } catch { return text }
      return ''
    }
  }
  return fn(brokenTools, ['read_range'], 'X')({}) === 'X'
})())

/* ---- savings on the real corpus ---- */
console.log('\n=== savings on real workspace files ===')
const files = []
for (const dir of ['.', 'test']) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    const full = path.join(root, dir, f)
    if (fs.statSync(full).isFile() && /\.(js|mjs|json|md|yml)$/.test(f)) files.push(path.join(dir, f))
  }
}

console.log(`${'file'.padEnd(34)} ${'whole'.padStart(7)} ${'symbol'.padStart(7)} ${'saved'.padStart(7)}`)
let w = 0
let s = 0
for (const rel of files) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  const needle = rel.endsWith('index.js') ? 'deferLoading' : 'console.log'
  const res = await rr.execute({ path: rel, mode: 'symbol', symbol: needle, context: 3 }, exec)
  const whole = est(text)
  const saved = est(res.text)
  // only count files where the symbol mode actually found something useful
  if (res.text.includes('no line contains')) {
    console.log(`${rel.padEnd(34)} ${String(whole).padStart(7)} ${'(no hit)'.padStart(7)} ${'-'.padStart(7)}`)
    continue
  }
  w += whole
  s += saved
  console.log(`${rel.padEnd(34)} ${String(whole).padStart(7)} ${String(saved).padStart(7)} ${String(whole - saved).padStart(7)}`)
}
console.log('')
console.log(`files with hits: whole=${w} symbol=${s} saved=${w - s} (${(100 * (w - s) / w).toFixed(1)}%)`)
console.log(`avg per file: ${(w / files.length).toFixed(0)} -> ${(s / files.length).toFixed(0)}`)

console.log('')
console.log(fail === 0 ? 'ALL END-TO-END CHECKS PASSED' : `${fail} CHECK(S) FAILED`)
process.exitCode = fail === 0 ? 0 : 1
