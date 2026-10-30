/**
 * SESSION-LEVEL measurement.
 *
 * The per-operation table in the README measures one read. That is honest but
 * not comparable to plugins that report a whole-session figure, and it reads as
 * overselling next to them.
 *
 * This script models a whole session instead: a tool result entered at step k is
 * re-sent on every step from k to N, so its cost is (N - k + 1) x its size.
 * That is the number a developer actually pays.
 *
 * Run: node test/session-measure.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { __test } from '../index.js'

const { runReadRange } = __test
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')

const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g
const est = (s) => {
  const c = (s.match(CJK) || []).length
  return Math.ceil(c / 1.7 + (s.length - c) / 3.8)
}

/** A realistic session: N steps, some of them read files. */
const SESSION_STEPS = 30

/** Opening prompt + system prompt baseline, present from step 1. */
const BASELINE_TOKENS = 12000

/**
 * Files a developer would read during one such session, with the question that
 * made them open the file.
 */
const reads = [
  { file: 'index.js', symbol: 'readWithAnchors', atStep: 3 },
  { file: 'ingest.js', symbol: 'slimResult', atStep: 8 },
  { file: 'archive.js', symbol: 'safeEntryPath', atStep: 14 },
  { file: 'test/ab-measure.mjs', symbol: 'cases', atStep: 21 },
]

function sizeOfWhole(rel) {
  const full = path.join(pkgRoot, rel)
  if (!fs.existsSync(full)) return null
  const text = fs.readFileSync(full, 'utf8')
  return { tokens: est(text), text }
}

function sizeOfSymbol(rel, symbol) {
  const full = path.join(pkgRoot, rel)
  if (!fs.existsSync(full)) return null
  const text = fs.readFileSync(full, 'utf8')
  const res = runReadRange({ path: rel, mode: 'symbol', symbol, context: 3 }, text)
  if (!res.body) return null
  return { tokens: est(res.body), hit: true }
}

console.log(`=== session-level cost model: ${SESSION_STEPS} steps ===`)
console.log('A result that enters at step k is re-sent on every step from k to N.')
console.log('')

let wholeTotal = 0
let prunedTotal = 0
const rows = []

for (const r of reads) {
  const whole = sizeOfWhole(r.file)
  const sym = sizeOfSymbol(r.file, r.symbol)
  if (!whole || !sym) {
    console.log(`skip ${r.file} (missing)`)
    continue
  }
  // Re-billed (N - k + 1) times.
  const repeats = SESSION_STEPS - r.atStep + 1
  const w = whole.tokens * repeats
  const p = sym.tokens * repeats
  wholeTotal += w
  prunedTotal += p
  rows.push({ ...r, whole: whole.tokens, pruned: sym.tokens, repeats, w, p })
}

console.log(`${'file'.padEnd(22)} ${'step'.padStart(5)} ${'re-sends'.padStart(9)} ${'whole/session'.padStart(14)} ${'prune/session'.padStart(14)}`)
for (const r of rows) {
  console.log(
    `${r.file.padEnd(22)} ${String(r.atStep).padStart(5)} ${String(r.repeats).padStart(9)} ${String(r.w).padStart(14)} ${String(r.p).padStart(14)}`,
  )
}

const baseline = BASELINE_TOKENS * SESSION_STEPS
const wholeSession = baseline + wholeTotal
const prunedSession = baseline + prunedTotal

console.log('')
console.log(`fixed baseline (${BASELINE_TOKENS} tok x ${SESSION_STEPS}): ${baseline}`)
console.log(`whole-file session total : ${wholeSession}`)
console.log(`pruned session total     : ${prunedSession}`)
console.log(`session saving           : ${wholeSession - prunedSession} = ${(100 * (wholeSession - prunedSession) / wholeSession).toFixed(1)}%`)
console.log('')
console.log('=== how the headline number changes with session length ===')
for (const N of [10, 20, 30, 50, 100]) {
  let w = 0
  let p = 0
  for (const r of rows) {
    const repeats = Math.max(0, N - r.atStep + 1)
    w += r.whole * repeats
    p += r.pruned * repeats
  }
  const base = BASELINE_TOKENS * N
  const total = base + w
  const saved = w - p
  console.log(`  N=${String(N).padStart(3)}: saving ${(100 * saved / total).toFixed(1)}% of total prompt tokens`)
}
