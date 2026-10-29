/**
 * Probe a: price the LIVE tool-inventory dump captured from cordis_inspect_query Tool.listTools.
 *
 * This is real measured data: the file is the harness's own formatted result of
 * listing the tools this agent can call. We price it two ways and cross-check.
 */
import fs from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('usage: node price-tool-inventory.mjs <dump-file>')
  process.exit(2)
}
const text = fs.readFileSync(path, 'utf8')

// The dump is the provider's JSON formatting. Count tool entries by "name" keys
// at schema level; also capture per-tool description+parameters byte spans.
const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g

function estimate(s) {
  // Harness tokenMeter heuristic is not public here; this is a documented
  // approximation. Latin/code ~ 3.6-4 chars per token; CJK ~ 1.7 chars per token.
  const cjk = (s.match(CJK) || []).length
  const rest = s.length - cjk
  return Math.ceil(cjk / 1.7 + rest / 3.8)
}

// Find every top-level tool object block: "name": "..." followed by description/parameters.
const nameRe = /"name":\s*"([a-zA-Z0-9_]+)",\s*\n\s*"description":/g
const names = []
let m
while ((m = nameRe.exec(text))) names.push({ name: m[1], index: m.index })

const parts = names.map((entry, i) => {
  const start = entry.index
  const end = i + 1 < names.length ? names[i + 1].index : text.length
  const span = text.slice(start, end)
  return { name: entry.name, chars: span.length, tokens: estimate(span) }
})

parts.sort((a, b) => b.tokens - a.tokens)
const totalChars = parts.reduce((s, p) => s + p.chars, 0)
const totalTokens = parts.reduce((s, p) => s + p.tokens, 0)

console.log(`dump file chars            : ${text.length.toLocaleString()}`)
console.log(`dump file tokens (est.)    : ${estimate(text).toLocaleString()}`)
console.log(`tool entries matched       : ${parts.length}`)
console.log(`tool-span chars (sum)      : ${totalChars.toLocaleString()} (${((totalChars / text.length) * 100).toFixed(1)}% of dump)`)
console.log(`tool-span tokens (sum)     : ${totalTokens.toLocaleString()}`)
console.log('')
console.log('top 25 most expensive tool schemas:')
console.log('rank | tokens | chars | tool')
parts.slice(0, 25).forEach((p, i) => {
  console.log(`${String(i + 1).padStart(4)} | ${String(p.tokens).padStart(6)} | ${String(p.chars).padStart(6)} | ${p.name}`)
})
console.log('')
console.log(`top 25 tokens = ${parts.slice(0, 25).reduce((s, p) => s + p.tokens, 0).toLocaleString()} (${((parts.slice(0, 25).reduce((s, p) => s + p.tokens, 0) / totalTokens) * 100).toFixed(1)}% of all tool tokens)`)

fs.writeFileSync(new URL('./tool-inventory-priced.json', import.meta.url), JSON.stringify({ totalChars, totalTokens, parts }, null, 2))
