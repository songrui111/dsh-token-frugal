/**
 * Run every test suite and exit non-zero if any of them fails.
 *
 * The measurement scripts are part of this directory on purpose: every number
 * quoted in the README and in the plugin-market description can be reproduced
 * by running `npm test` (correctness) and `npm run measure:reads` (savings).
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const suites = [
  ['end-to-end tools', 'e2e-tool-test.mjs'],
  ['file-read savings', 'verify-and-measure.mjs'],
  ['ingest slimming', 'c-ingest-test.mjs'],
  ['ingest wiring', 'c-wiring-test.mjs'],
  ['durable archive', 'archive-test.mjs'],
]

let failed = 0
const results = []

for (const [label, file] of suites) {
  const run = spawnSync(process.execPath, [path.join(here, file)], { encoding: 'utf8' })
  const output = `${run.stdout || ''}${run.stderr || ''}`
  const tail = output.trim().split('\n').slice(-1)[0] || ''
  const ok = run.status === 0
  if (!ok) failed += 1
  results.push({ label, file, ok, tail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(20)} ${tail}`)
  if (!ok) console.log(output)
}

console.log('')
console.log(failed === 0 ? `ALL ${suites.length} SUITES PASSED` : `${failed} SUITE(S) FAILED`)
process.exitCode = failed === 0 ? 0 : 1
