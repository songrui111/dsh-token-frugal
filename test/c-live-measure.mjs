/**
 * REAL end-to-end measurement of the C pipeline.
 *
 * Goes through the actual plugin wiring — `tools/post-execute` listener and the
 * registered `fetch_recall` tool — with REAL page bytes on disk. The only thing
 * simulated is the `ctx` boundary (which cannot be reached from a test process).
 *
 * Run:  node probe/c-live-measure.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g
const est = (s) => {
  const c = (s.match(CJK) || []).length
  return Math.ceil(c / 1.7 + (s.length - c) / 3.8)
}

/* ---- a faithful enough Host boundary ---- */
const tools = new Map()
const listeners = new Map()
const ctx = {
  get: (n) => (n === 'tools' ? ctx.tools : n === 'systemPrompt' ? { section: () => () => {} } : n === 'fs' ? { resolve: async (p) => p, readText: async () => '' } : undefined),
  effect: (fn) => {
    const d = fn()
    return () => d && d()
  },
  on: (e, h) => {
    listeners.set(e, h)
    return () => listeners.delete(e)
  },
  tools: {
    register: (d) => {
      tools.set(d.name, d)
      return () => tools.delete(d.name)
    },
    get: (n) => tools.get(n),
    schemas: () => [],
  },
}

apply(ctx, {})
const post = listeners.get('tools/post-execute')
const recall = tools.get('fetch_recall')

/* ---- the real page the plugin will actually receive ---- */
const pagePath = path.join(os.tmpdir(), 'bigpage.txt')
if (!fs.existsSync(pagePath)) {
  console.error(`missing ${pagePath}; fetching live...`)
  const r = await fetch('https://docs.python.org/3/library/asyncio-task.html', { headers: { 'user-agent': 'dsh-token-frugal' } })
  fs.writeFileSync(pagePath, await r.text(), 'utf8')
}
const page = fs.readFileSync(pagePath, 'utf8')

console.log('=== REAL C pipeline: web_fetch result -> post-execute -> spooled result ===')
console.log(`page: ${page.length.toLocaleString()} chars, ~${est(page).toLocaleString()} tokens`)
console.log('')

const agent = { id: 'measure-session' }
const before = { content: [{ type: 'text', text: page }] }

// This is exactly what the harness does for a real web_fetch call.
const after = await post({ name: 'web_fetch', agent }, {}, async () => before)
const delivered = after.content[0].text

const rawTok = est(page)
const deliveredTok = est(delivered)

console.log(`raw result tokens        : ${rawTok.toLocaleString()}`)
console.log(`delivered result tokens  : ${deliveredTok.toLocaleString()}`)
console.log(`saved on this one call   : ${(rawTok - deliveredTok).toLocaleString()} (${(100 * (rawTok - deliveredTok) / rawTok).toFixed(1)}%)`)
console.log('')

/* ---- round-trip: can the model get the rest back? ---- */
const locator = /locator="([^"]+)"/.exec(delivered)
console.log('=== can the details still be recovered? ===')
if (!locator) {
  console.log('FAIL: no locator emitted')
  process.exitCode = 1
} else {
  const loc = locator[1]
  console.log(`locator: ${loc}`)

  // Ask for a specific section a model would want after reading the digest.
  const needle = 'Task cancellation'
  const at = page.indexOf(needle)
  const slice = await recall.execute({ locator: loc, start: at - 100, end: at + 400 }, { agent })
  const ok = slice.text.includes(needle)
  console.log(`recall around "${needle}" -> ${ok ? 'FOUND' : 'NOT FOUND'}, ${est(slice.text)} tokens`)
  console.log(`recall slice matches source bytes: ${slice.text.includes(page.slice(at - 100, at + 100))}`)

  // Cost of one recall versus what the whole page would have cost.
  console.log('')
  console.log(`one recall costs ${est(slice.text)} tokens vs ${rawTok} for the whole page`)
  console.log(`=> slimmed + 1 recall = ${deliveredTok + est(slice.text)} tokens, still ${(100 * (1 - (deliveredTok + est(slice.text)) / rawTok)).toFixed(1)}% cheaper`)
}

/* ---- compounding over a session ---- */
console.log('')
console.log('=== why it compounds: result text is re-sent every later step ===')
for (const N of [10, 30, 60]) {
  const raw = rawTok * N
  const slim = deliveredTok * N
  console.log(`  ${String(N).padStart(2)} steps: ${raw.toLocaleString().padStart(10)} -> ${slim.toLocaleString().padStart(7)}  saved ${(raw - slim).toLocaleString()}`)
}
