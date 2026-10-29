/**
 * Experiment: can deferred tool loading (ToolSchema.deferLoading) actually cut tokens?
 *
 * Compares, per schema:
 *   1. FULL       - what the model sees today if every tool is shipped inline.
 *   2. DEFERRED   - name + one-line description only (schema body + long prose dropped).
 *   3. PTC        - a single run_code tool that can dispatch to the deferred set.
 *
 * The point is NOT to guess the plugin design; it is to measure whether the size
 * distribution makes deferral worth building at all.
 */
import fs from 'node:fs'

const file = new URL('./tool-inventory-priced.json', import.meta.url)
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g
const est = (s) => Math.ceil((s.match(CJK) || []).length / 1.7 + (s.length - (s.match(CJK) || []).length) / 3.8)

// We only have per-tool total spans here; approximate the deferred form as
// ~20 tokens of name + argument names (a conservative floor: the model still needs
// to know the tool exists and roughly what it does).
const DEFERRED_TOKENS = 20

const rows = data.parts.map((p) => ({ ...p, saved: p.tokens - DEFERRED_TOKENS }))
const full = rows.reduce((s, r) => s + r.tokens, 0)
const deferred = rows.length * DEFERRED_TOKENS
const saved = full - deferred

console.log('=== Deferred-loading upper bound (static tool schemas only) ===')
console.log(`tools                               : ${rows.length}`)
console.log(`FULL (today, everything inline)      : ${full.toLocaleString()} tokens`)
console.log(`DEFERRED (name + 1-line each)        : ${deferred.toLocaleString()} tokens`)
console.log(`saved                                : ${saved.toLocaleString()} tokens  (${((saved / full) * 100).toFixed(1)}%)`)
console.log('')

// How many tools must stay inline for 90% of the savings? (i.e. defer only the tail)
const sorted = [...rows].sort((a, b) => a.saved - b.saved) // cheapest-to-defer first? no: smallest first
let cum = 0
let k = 0
const target = saved * 0.9
for (const r of sorted.slice().reverse()) {
  cum += r.saved
  k++
  if (cum >= target) break
}
console.log(`defer only the top ${k} tools    : captures 90% of the savings`)
console.log('')
console.log('Biggest individual wins (full -> deferred):')
rows
  .sort((a, b) => b.saved - a.saved)
  .slice(0, 15)
  .forEach((r) => console.log(`  ${String(r.tokens).padStart(5)} -> 20  saves ${String(r.saved).padStart(5)}   ${r.name}`))

// Second dimension: per-call round-trip arithmetic.
// Each tool round trip re-sends the whole context. If a session has N round trips,
// every tool emitted early is re-billed N times (modulo caching).
console.log('')
console.log('=== Why this compounds: re-billing ===')
for (const n of [10, 30, 60]) {
  console.log(`  ${String(n).padStart(3)} round trips: ${saved.toLocaleString()} tokens/trip x ${n} = ${(saved * n).toLocaleString()} tokens`)
}
