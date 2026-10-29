/**
 * End-to-end test of the "C" wiring inside the plugin:
 * tools/post-execute slimming + fetch_recall round trip.
 *
 * The critical property is scoping: `post-execute` is a GLOBAL waterfall, so a
 * bug here would rewrite every tool result in the process. These tests prove it
 * touches `web_fetch` and nothing else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let fail = 0
const check = (label, cond, extra = '') => {
  if (!cond) {
    fail += 1
    console.log(`  FAIL ${label} ${extra}`)
  } else console.log(`  ok   ${label}`)
}

const tools = new Map()
const listeners = new Map()

function makeCtx(overrides = {}) {
  const c = {
    get: (name) => {
      if (name === 'fs') return { resolve: async (p) => p, readText: async () => 'x' }
      if (name === 'systemPrompt') return { section: () => () => {} }
      if (name === 'tools') return c.tools
      return overrides[name]
    },
    effect: (fn) => {
      const d = fn()
      return () => d && d()
    },
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
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
  return c
}

function bigBody(chars) {
  return (
    '<h1>Docs<a class="headerlink">&#182;</a></h1>\n' +
    '<h2>Coroutines<a class="headerlink">&#182;</a></h2>\n' +
    '<p>' +
    'x'.repeat(chars) +
    '</p>\n'
  )
}

apply(makeCtx(), {})
check('fetch_recall registered', tools.has('fetch_recall'))
check('read_range registered', tools.has('read_range'))
check('post-execute listener installed', listeners.has('tools/post-execute'))

const post = listeners.get('tools/post-execute')
const agent = { id: 'sess-A' }

console.log('\n=== slimming applies to web_fetch ===')
const big = bigBody(30000)
{
  const exec = { name: 'web_fetch', agent }
  const decision = await post(exec, {}, async () => ({ content: [{ type: 'text', text: big }] }))
  const out = decision.content[0].text
  check('oversized body was slimmed', out.length < big.length / 2, `${out.length} vs ${big.length}`)
  check('slimmed text names a locator', /fetch_recall\(locator="td-[^"]+"/.test(out), out.slice(0, 140))
  check('other content blocks are preserved', decision.content.length === 1)

  const locator = /locator="([^"]+)"/.exec(out)[1]
  console.log(`  locator: ${locator}`)

  console.log('\n=== fetch_recall round trip ===')
  const rr = tools.get('fetch_recall')
  const slice = await rr.execute({ locator, start: 0, end: 40 }, { agent })
  check('recall returns the original bytes', slice.text.includes(big.slice(0, 40)), slice.text.slice(0, 80))
  check('recall reports the true total', slice.text.includes(String(big.length)))
  const tail = await rr.execute({ locator, start: big.length - 20, end: big.length }, { agent })
  check('recall reaches the tail', tail.text.includes(big.slice(big.length - 20)), tail.text.slice(0, 100))

  console.log('\n=== session isolation ===')
  const other = await rr.execute({ locator, start: 0, end: 10 }, { agent: { id: 'sess-B' } })
  check('another session cannot read the archive', other.text.includes('different session'), other.text.slice(0, 110))
  const noAgent = await rr.execute({ locator, start: 0, end: 10 }, {})
  check('agent-less call still resolves its own archive', noAgent.text.includes(big.slice(0, 10)), noAgent.text.slice(0, 90))
}

console.log('\n=== tools outside the slim set are untouched (global waterfall safety) ===')
// `bash`/`pwsh`/`wsl` are now INTENTIONALLY slimmed (head+tail), so they are
// excluded here and covered by their own section below.
for (const name of ['read', 'grep', 'tool_catalog', 'read_range', 'edit', 'write']) {
  const exec = { name, agent }
  const decision = await post(exec, {}, async () => ({ content: [{ type: 'text', text: big }] }))
  check(`${name}: result passes through unchanged`, decision.content[0].text === big)
}

console.log('\n=== shell output keeps its TAIL (the reason this mode exists) ===')
{
  // A failing command puts its diagnosis at the end. The host cap keeps only the
  // head, so without this mode the model never sees the error.
  const lines = []
  for (let i = 0; i < 4000; i += 1) lines.push(`noise line ${i}`)
  lines.push('ERROR: Access is denied.')
  lines.push('2 file(s) copied')
  const shellOut = lines.join('\n')

  for (const name of ['pwsh', 'bash', 'wsl', 'tty_run']) {
    const decision = await post({ name, agent }, {}, async () => ({ content: [{ type: 'text', text: shellOut }] }))
    const out = decision.content[0].text
    check(`${name}: error line is preserved`, out.includes('ERROR: Access is denied.'), out.slice(-200))
    check(`${name}: final summary is preserved`, out.includes('2 file(s) copied'))
    check(`${name}: head is preserved`, out.includes('noise line 0'))
    check(`${name}: middle is omitted`, !out.includes('noise line 2000'))
    check(`${name}: reports how much was dropped`, /lines omitted/.test(out), out.slice(0, 160))
    check(`${name}: output is much smaller`, out.length < shellOut.length / 2, `${out.length} vs ${shellOut.length}`)
  }

  // Cuts land on line boundaries, so no half-written trailing line.
  const decision = await post({ name: 'pwsh', agent }, {}, async () => ({ content: [{ type: 'text', text: shellOut }] }))
  const tailPart = decision.content[0].text.split('--- tail')[1] || ''
  check('tail ends on a complete line', tailPart.trimEnd().endsWith('2 file(s) copied'), JSON.stringify(tailPart.slice(-60)))
}

console.log('\n=== edge cases ===')
{
  const exec = { name: 'web_fetch', agent }
  const small = await post(exec, {}, async () => ({ content: [{ type: 'text', text: 'tiny' }] }))
  check('small body untouched', small.content[0].text === 'tiny')

  const multi = await post(exec, {}, async () => ({
    content: [
      { type: 'text', text: big },
      { type: 'text', text: 'second block' },
    ],
  }))
  check('multi-text-block result is left alone', multi.content.length === 2 && multi.content[0].text === big)

  const noText = await post(exec, {}, async () => ({ content: [{ type: 'image', data: 'x' }] }))
  check('non-text result untouched', noText.content[0].type === 'image')

  const empty = await post(exec, {}, async () => ({}))
  check('result without content untouched', empty && !empty.content)

  // A throwing downstream must not be masked by the listener.
  const downThrows = await post(exec, {}, async () => {
    throw new Error('downstream boom')
  }).catch((e) => ({ threw: e.message }))
  check('downstream errors propagate', downThrows.threw === 'downstream boom', JSON.stringify(downThrows))
}

console.log('\n=== recall edge cases ===')
{
  const rr = tools.get('fetch_recall')
  const unknown = await rr.execute({ locator: 'td-does-not-exist', start: 0, end: 10 }, { agent })
  check('unknown locator reports cleanly', unknown.text.includes('cannot read locator'), unknown.text.slice(0, 110))

  // Re-register a fresh plugin instance to get a live locator, then probe ranges.
  const big2 = bigBody(20000)
  const decision = await post({ name: 'web_fetch', agent }, {}, async () => ({ content: [{ type: 'text', text: big2 }] }))
  const loc = /locator="([^"]+)"/.exec(decision.content[0].text)[1]
  const inverted = await rr.execute({ locator: loc, start: 500, end: 100 }, { agent })
  check('inverted range is reported', inverted.text.includes('end offset is before its start'), inverted.text.slice(0, 130))
  const beyond = await rr.execute({ locator: loc, start: big2.length + 10, end: big2.length + 20 }, { agent })
  check('range past the end is reported', beyond.text.includes('empty range') || beyond.text.includes('cannot read locator'), beyond.text.slice(0, 130))
}

console.log('')
console.log(fail === 0 ? 'ALL C-WIRING CHECKS PASSED' : `${fail} CHECK(S) FAILED`)
process.exitCode = fail === 0 ? 0 : 1
