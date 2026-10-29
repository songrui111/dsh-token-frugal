/**
 * Durable archive tests.
 *
 * Run against a disposable DSH_HOME so the user's real ~/.dsh is never touched.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'token-diet-archive-test-'))
process.env.DSH_HOME = TMP_HOME

const { saveArchive, loadArchive, listArchives, __paths } = await import('../archive.js')

let fail = 0
const check = (label, cond, extra = '') => {
  if (!cond) {
    fail += 1
    console.log(`  FAIL ${label} ${extra}`)
  } else console.log(`  ok   ${label}`)
}

console.log(`sandbox DSH_HOME: ${TMP_HOME}`)

console.log('\n=== save / load round trip ===')
const body = 'line one\nline two\n' + 'x'.repeat(5000) + '\nTHE END'
const saved = saveArchive({ sessionId: 'sess-A', text: body, label: 'web_fetch' })
check('save succeeds', saved.ok, JSON.stringify(saved))
const locator = saved.locator
console.log(`  locator: ${locator}`)

const whole = loadArchive({ locator, sessionId: 'sess-A', start: 0, end: 30 })
check('load returns the exact head bytes', whole.ok && whole.text === body.slice(0, 30), JSON.stringify(whole.text && whole.text.slice(0, 40)))
check('load reports the true total', whole.ok && whole.total === body.length)

const tail = loadArchive({ locator, sessionId: 'sess-A', start: body.length - 7, end: body.length })
check('load reaches the tail', tail.ok && tail.text === 'THE END', JSON.stringify(tail.text))

console.log('\n=== survives a fresh process view (on disk, not in memory) ===')
{
  const entries = listArchives()
  check('index on disk knows the locator', !!entries[locator])
  const file = path.join(__paths.archiveRoot(), entries[locator].file)
  check('archived file exists on disk', fs.existsSync(file))
  check('archived file holds the verbatim body', fs.readFileSync(file, 'utf8') === body)
}

console.log('\n=== session scoping ===')
{
  const other = loadArchive({ locator, sessionId: 'sess-B', start: 0, end: 10 })
  check('another session is refused', !other.ok && other.reason === 'other-session', JSON.stringify(other))
  const anon = loadArchive({ locator, start: 0, end: 10 })
  check('no sessionId still reads a session-scoped entry', anon.ok, JSON.stringify(anon.reason))
}

console.log('\n=== content addressing ===')
{
  const again = saveArchive({ sessionId: 'sess-A', text: body, label: 'web_fetch' })
  check('same body yields the same locator', again.ok && again.locator === locator)
  const files = fs.readdirSync(__paths.archiveRoot()).filter((f) => f.endsWith('.txt'))
  check('same body is stored once', files.length === 1, files.join(','))
}

console.log('\n=== error paths ===')
{
  const missing = loadArchive({ locator: 'td-doesnotexist-1', sessionId: 'sess-A' })
  check('unknown locator reports not-found', !missing.ok && missing.reason === 'not-found')

  const empty = saveArchive({ sessionId: 'sess-A', text: '' })
  check('empty body is refused', !empty.ok)

  // Evicted file (index entry present, file gone).
  const entries = listArchives()
  const victim = Object.keys(entries)[0]
  fs.rmSync(path.join(__paths.archiveRoot(), entries[victim].file))
  const evicted = loadArchive({ locator: victim, sessionId: 'sess-A' })
  check('missing file reports evicted', !evicted.ok && evicted.reason === 'evicted', JSON.stringify(evicted))

  // Range validation runs on its own archive: the eviction test above deletes
  // the file behind `locator`, so reusing it here would report 'evicted'.
  const fresh = saveArchive({ sessionId: 'sess-A', text: 'z'.repeat(500) })
  check('fresh archive for range checks', fresh.ok)
  const inverted = loadArchive({ locator: fresh.locator, sessionId: 'sess-A', start: 100, end: 50 })
  check('inverted range is rejected explicitly', !inverted.ok && inverted.reason === 'inverted-range', JSON.stringify(inverted))

  const same = loadArchive({ locator: fresh.locator, sessionId: 'sess-A', start: 100, end: 100 })
  check('zero-width range reports empty-range', !same.ok && same.reason === 'empty-range', JSON.stringify(same))
}

console.log('\n=== path traversal is blocked (index file is untrusted input) ===')
{
  // The index is plain JSON on disk, so a hand-edited entry must not let a
  // locator read (or delete) a file outside the archive directory.
  const secret = path.join(TMP_HOME, 'SECRET-OUTSIDE-ARCHIVE.txt')
  fs.writeFileSync(secret, 'TOPSECRET')

  const indexFile = __paths.indexFile()
  const realIndex = fs.readFileSync(indexFile, 'utf8')
  const attempts = [
    '../../SECRET-OUTSIDE-ARCHIVE.txt',
    '..\\..\\SECRET-OUTSIDE-ARCHIVE.txt',
    'a/../../SECRET-OUTSIDE-ARCHIVE.txt',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
  ]
  for (const file of attempts) {
    fs.writeFileSync(
      indexFile,
      JSON.stringify({ version: 1, entries: { evil: { file, sessionId: null, chars: 99, at: 1 } } }),
    )
    const r = loadArchive({ locator: 'evil', start: 0, end: 9 })
    check(`traversal blocked: ${JSON.stringify(file)}`, !r.ok && r.reason === 'invalid-entry', JSON.stringify(r))
  }
  fs.writeFileSync(indexFile, realIndex)
  check('outside file was never read', fs.readFileSync(secret, 'utf8') === 'TOPSECRET')
}

console.log('\n=== pruning is bounded ===')
{
  const dir = __paths.archiveRoot()
  const before = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).length
  for (let i = 0; i < 8; i += 1) {
    saveArchive({ sessionId: 'sess-A', text: `distinct body ${i} `.repeat(50), label: 'pwsh', maxFiles: 4 })
  }
  const after = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).length
  check('archive is capped at maxFiles', after <= 4, `before=${before} after=${after}`)
}

console.log('\n=== never throws into the caller ===')
{
  // Point DSH_HOME at an unusable path and confirm the API degrades instead of throwing.
  const bad = path.join(TMP_HOME, 'not-a-dir')
  fs.writeFileSync(bad, 'x')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(bad, 'nested')
  let threw = false
  let result
  try {
    result = saveArchive({ sessionId: 's', text: 'y'.repeat(100) })
  } catch {
    threw = true
  }
  check('save does not throw on a broken home', !threw)
  check('save reports failure instead', result && result.ok === false, JSON.stringify(result))
  process.env.DSH_HOME = previous
}

fs.rmSync(TMP_HOME, { recursive: true, force: true })
console.log('')
console.log(fail === 0 ? 'ALL ARCHIVE CHECKS PASSED' : `${fail} CHECK(S) FAILED`)
process.exitCode = fail === 0 ? 0 : 1
