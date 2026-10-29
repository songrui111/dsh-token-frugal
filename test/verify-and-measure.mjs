/**
 * Offline verification + first real measurement of read_range.
 *
 * Compares three ways of answering "where is X defined / how does it work":
 *   A. whole-file read   (today's baseline)
 *   B. read_range lines  (a window you guessed)
 *   C. read_range symbol (locate every mention, merged windows)
 * and prices each with a deterministic approximation of the harness token rule.
 */
import fs from 'node:fs'
import { __test } from '../index.js'

const { runReadRange } = __test
const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g
const est = (s) => {
  const cjk = (s.match(CJK) || []).length
  return Math.ceil(cjk / 1.7 + (s.length - cjk) / 3.8)
}

const selfFile = new URL('../index.js', import.meta.url)
const corpus = {
  'index.js': fs.readFileSync(selfFile, 'utf8'),
  'probe/price-tool-inventory.mjs': fs.readFileSync(new URL('./price-tool-inventory.mjs', import.meta.url), 'utf8'),
  'probe/deferred-loading-experiment.mjs': fs.readFileSync(new URL('./deferred-loading-experiment.mjs', import.meta.url), 'utf8'),
}

let failures = 0
const check = (label, cond, extra = '') => {
  if (!cond) {
    failures += 1
    console.log(`  FAIL ${label} ${extra}`)
  } else {
    console.log(`  ok   ${label}`)
  }
}

console.log('=== correctness ===')
{
  const text = corpus['index.js']
  const total = text.split(/\r\n|\r|\n/).length

  const win = runReadRange({ path: 'x', mode: 'lines', start: 10, end: 19 }, text)
  check('lines window returns exactly the asked range', win.body.split('\n').length === 10)
  check('lines window header cites total', win.header.includes(`of ${total} lines`), win.header)

  const sym = runReadRange({ path: 'x', mode: 'symbol', symbol: 'deferLoading', context: 2, maxLines: 400 }, text)
  check('symbol mode finds hits', sym.body.includes('deferLoading'), sym.header)
  check('symbol mode merges overlapping windows (no duplicate regions)',
    (sym.body.match(/deferLoading/g) || []).length >= 2)

  const capped = runReadRange({ path: 'x', mode: 'symbol', symbol: 'const', maxLines: 5 }, text)
  const cappedLines = capped.body ? capped.body.split('\n').filter((l) => l.includes('|')).length : 0
  check('maxLines hard-caps output', cappedLines <= 5, `got ${cappedLines}`)

  const miss = runReadRange({ path: 'x', mode: 'symbol', symbol: '__definitely_absent_symbol__' }, text)
  check('absent symbol reports cleanly, no body', miss.body === '' && miss.header.includes('no line contains'))

  const outline = runReadRange({ path: 'x', mode: 'outline', maxLines: 400 }, text)
  check('outline returns structural lines', outline.body.includes('export function apply'), outline.header)
  // Regression: an outline is already compressed, so it must reach the LAST
  // structural line of a 400-line file without an explicit maxLines.
  check('outline reaches deep members without explicit maxLines',
    runReadRange({ path: 'x', mode: 'outline' }, text).body.includes('export function apply'))
  check('outline reports its structural line count', /outline, \d+ structural line/.test(outline.header), outline.header)

  const outOfRange = runReadRange({ path: 'x', mode: 'lines', start: 9999, end: 10010 }, text)
  check('out-of-range window does not throw', typeof outOfRange.header === 'string')

  // surrogate-pair safety: emoji must not be split
  const emoji = 'a😀b\n😀😀c\n'
  const e = runReadRange({ path: 'x', mode: 'lines', start: 1, end: 2 }, emoji)
  check('emoji lines survive intact', e.body.includes('😀') && !e.body.includes('\ufffd'))

  // unicode filenames / CJK content
  const cjk = '第一行中文\n第二行中文\n第三行\n'
  const c = runReadRange({ path: 'x', mode: 'symbol', symbol: '中文' }, cjk)
  check('CJK matching works', c.body.includes('第一行中文'))
}

console.log('')
console.log('=== savings vs whole-file read ===')
console.log(`${'file'.padEnd(38)} ${'whole'.padStart(8)} ${'window'.padStart(8)} ${'symbol'.padStart(8)}  saved%(symbol)`)
let aggWhole = 0
let aggSymbol = 0
for (const [name, text] of Object.entries(corpus)) {
  const whole = est(text)
  const win = est(runReadRange({ path: name, mode: 'lines', start: 1, end: 40 }, text).body)
  const symTarget = name.includes('index.js') ? 'deferLoading' : 'console.log'
  const symRes = runReadRange({ path: name, mode: 'symbol', symbol: symTarget, context: 3 }, text)
  const sym = est(symRes.body || '')
  aggWhole += whole
  aggSymbol += sym
  const saved = whole > 0 ? (100 * (whole - sym)) / whole : 0
  console.log(
    `${name.padEnd(38)} ${String(whole).padStart(8)} ${String(win).padStart(8)} ${String(sym).padStart(8)}  ${saved.toFixed(1)}%`,
  )
}
console.log('')
console.log(`aggregate: whole=${aggWhole} symbol=${aggSymbol} saved=${aggWhole - aggSymbol} (${(100 * (aggWhole - aggSymbol) / aggWhole).toFixed(1)}%)`)

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
