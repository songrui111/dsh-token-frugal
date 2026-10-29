/**
 * Controlled A/B measurement of dsh-token-frugal's read_range.
 *
 * Fixes the TASK and varies only the READ STRATEGY, so the difference is
 * attributable to the tool and not to different questions:
 *
 *   A. raw      - read the whole file (today's baseline)
 *   B. symbol   - read_range mode=symbol for the identifier in question
 *   C. outline  - read_range mode=outline (structure only, then one window)
 *
 * Round-trip compounding is modelled too: every tool result stays in the
 * conversation and is re-sent on each later step, so a result emitted at step k
 * is billed (N - k + 1) times in an N-step session.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { __test } from '../index.js'

const { runReadRange } = __test
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const workspace = path.resolve(root, '..')

const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g
const est = (s) => {
  const c = (s.match(CJK) || []).length
  return Math.ceil(c / 1.7 + (s.length - c) / 3.8)
}

/** Real files with a question a developer would actually ask about them. */
const cases = [
  {
    file: 'index.js',
    symbol: 'readWithAnchors',
    question: 'how does relative-path resolution work?',
  },
  {
    file: 'publisher-radar/client/client.js',
    symbol: 'fetchedAt',
    base: workspace,
    question: 'how is data freshness displayed?',
  },
  {
    file: 'dsh-agent-bench/lib/index.js',
    symbol: 'score',
    base: workspace,
    question: 'how are benchmark cases scored?',
  },
]

/**
 * A read strategy is only useful if it actually ANSWERS the question. When the
 * symbol does not appear in the file, returning nothing is not a saving - it is
 * a failure that forces a second call. Such cases are excluded from the savings
 * totals and reported separately.
 */

console.log('=== A/B/C measurement: same question, different read strategy ===')
console.log('')
const rows = []
for (const c of cases) {
  const base = c.base || root
  const full = path.join(base, c.file)
  if (!fs.existsSync(full)) {
    console.log(`skip (not found): ${c.file}`)
    continue
  }
  const text = fs.readFileSync(full, 'utf8')
  const totalLines = text.split(/\r\n|\r|\n/).length

  // A: whole file (what a plain `read` returns)
  const aTok = est(text)

  // B: symbol lookup
  const bRes = runReadRange({ path: c.file, mode: 'symbol', symbol: c.symbol, context: 3 }, text)
  const bTok = est(bRes.body || '')

  // C: outline then one window (a realistic two-call discovery flow)
  const outline = runReadRange({ path: c.file, mode: 'outline' }, text)
  const cTok = est(outline.body || '')

  rows.push({
    file: c.file,
    lines: totalLines,
    question: c.question,
    symbol: c.symbol,
    a: aTok,
    b: bTok,
    c: cTok,
    bHit: !!(bRes.body && bRes.body.length),
    cHit: !!(outline.body && outline.body.length),
  })
}

console.log(`${'file'.padEnd(34)} ${'lines'.padStart(6)} ${'A raw'.padStart(8)} ${'B symbol'.padStart(9)} ${'C outline'.padStart(9)} ${'B save'.padStart(8)}`)
for (const r of rows) {
  // A zero-token symbol result means the identifier was absent: no saving, a miss.
  const save = r.bHit && r.b > 0 ? (100 * (r.a - r.b)) / r.a : 0
  const label = r.bHit && r.b > 0 ? `${save.toFixed(1)}%` : 'MISS'
  console.log(
    `${r.file.padEnd(34)} ${String(r.lines).padStart(6)} ${String(r.a).padStart(8)} ${String(r.b).padStart(9)} ${String(r.c).padStart(9)} ${label.padStart(8)}`,
  )
}

const hits = rows.filter((r) => r.bHit && r.b > 0)
const misses = rows.filter((r) => !r.bHit || r.b === 0)
const sum = (list, k) => list.reduce((s, r) => s + r[k], 0)
const A = sum(hits, 'a')
const B = sum(hits, 'b')
const C = sum(hits, 'c')
console.log('')
console.log(`hit rate: ${hits.length}/${rows.length} (symbol mode answered the question)`)
if (misses.length) console.log(`MISSES (excluded from totals): ${misses.map((m) => m.file).join(', ')}`)
console.log(`TOTAL over hits   raw=${A}  symbol=${B}  outline=${C}`)
console.log(`saved vs raw: symbol ${A - B} (${(100 * (A - B) / A).toFixed(1)}%)`)
console.log(`saved vs raw: outline ${A - C} (${(100 * (A - C) / A).toFixed(1)}%)`)
console.log(`avg per file: raw=${Math.round(A / hits.length)}  symbol=${Math.round(B / hits.length)}`)

/* ---- compounding over a session ---- */
console.log('')
console.log('=== why it compounds: a tool result is re-sent on every later step ===')
console.log('Assume each file is read early in a session of N steps; the result is re-billed every step after it.')
for (const N of [10, 20, 40]) {
  // Worst case: read at step 1, so it is billed N times.
  console.log(
    `  N=${String(N).padStart(2)} steps: raw=${A * N}  symbol=${B * N}  -> saved ${(A - B) * N} tokens`,
  )
}

/* ---- guidance cost ---- */
const guide = [
  '## Reading files without burning context',
  '',
  'Prefer `read_range` over a whole-file read. Every tool result stays in the',
  'conversation and is re-sent on every later step, so one 600-line dump costs',
  'its tokens again on each turn.',
  '',
  '- Do not know where the code is? Use `mode: "symbol"` with the identifier.',
  "- Do not know the file's shape? Use `mode: \"outline\"` first, then read the",
  '  few line ranges it points at.',
  '- Know the exact lines? Use `mode: "lines"` with `start`/`end`.',
  '- Only read a whole file when its full content is genuinely required.',
  '- `tool_catalog` lists available tools when you are unsure what exists.',
].join('\n')
const g = est(guide)
console.log('')
console.log('=== cost of the guidance itself ===')
console.log(`guidance: ${g} tokens, fixed per turn`)
console.log(`break-even at N=30 steps: need > ${(g * 30)} tokens of savings; this run saves ${(A - B) * 30}`)
console.log(`=> one file read via symbol pays the guidance back only if it saves > ${(g / ((A - B) / rows.length)).toFixed(1)} tokens/file on average`)
