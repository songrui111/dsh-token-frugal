/**
 * C (ingest slimming) verification with a FIXED, offline fixture.
 *
 * The previous version fetched a live page and silently skipped its key
 * assertions when the network failed — a green run that proved nothing. This
 * version carries the fixture inline so it always exercises the real code paths,
 * and it additionally checks digest labels are findable in the source.
 */
import { slimResult, __cTest } from '../ingest.js'

const { recallSlice, digest, squeeze } = __cTest
const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g
const est = (s) => {
  const c = (s.match(CJK) || []).length
  return Math.ceil(c / 1.7 + (s.length - c) / 3.8)
}

let fail = 0
const check = (label, cond, extra = '') => {
  if (!cond) {
    fail += 1
    console.log(`  FAIL ${label} ${extra}`)
  } else console.log(`  ok   ${label}`)
}

/** A realistic docs page: nav chrome, entity-encoded anchors, nested headings. */
const PAGE = [
  '<!DOCTYPE html><html><head><title>Coroutines and tasks</title></head><body>',
  '<div role="navigation"><h3><a href="../contents.html">Table of Contents</a></h3>',
  '<ul><li><a href="#coroutines">Coroutines</a></li></ul></div>',
  '<section>',
  '<h1>Coroutines and tasks<a class="headerlink" href="#coroutines-and-tasks" title="Permalink">&#182;</a></h1>',
  '<p>This section outlines high-level asyncio APIs to work with coroutines and tasks.</p>',
  '<h2>Coroutines<a class="headerlink" href="#coroutines">&#182;</a></h2>',
  '<p>Coroutines declared with the async/await syntax are the preferred way of writing asyncio applications.</p>',
  '<h2>Awaitables<a class="headerlink" href="#awaitables">&#182;</a></h2>',
  '<p>We say that an object is an awaitable object if it can be used in an await expression.</p>',
  '<h2>Creating Tasks<a class="headerlink" href="#creating-tasks">&#182;</a></h2>',
  '<p>Wrap the coro coroutine into a Task and schedule its execution.</p>',
  '<h2>Task cancellation<a class="headerlink" href="#task-cancellation">&#182;</a></h2>',
  '<p>CancelledError is raised when a task is cancelled.</p>',
  '</section>',
  '<section><h2>Notes &amp; caveats</h2><p>Use &lt;await&gt; carefully &mdash; blocking calls stall the loop.</p></section>',
  '</body></html>',
].join('\n')

// Pad it past the threshold with body text so slimming engages, as a real docs
// page would be far larger than this excerpt.
const BIG = PAGE + '\n' + '<p>' + 'Lorem ipsum dolor sit amet. '.repeat(600) + '</p>'

console.log('=== fixture ===')
console.log(`  fixture size: ${BIG.length} chars`)

console.log('\n=== slimming ===')
{
  const res = slimResult(BIG, { label: 'coroutines.html' })
  check('large body is slimmed', res.slimmed)
  const rawTok = est(BIG)
  const slimTok = est(res.text)
  console.log(`  raw=${rawTok} slim=${slimTok} saved=${((100 * (rawTok - slimTok)) / rawTok).toFixed(1)}%`)
  check('slimming removes most tokens', slimTok < rawTok / 2, `${slimTok} vs ${rawTok}`)

  const small = 'short body'
  check('small body is left untouched', slimResult(small).slimmed === false)
}

console.log('\n=== content landmark selection (live-page finding) ===')
{
  // The real docs page had a <nav> ToC before <div role="main">. Without the
  // landmark rule the head was a list of navigation links.
  const page =
    '<!DOCTYPE html><html><head><title>Doc</title></head><body>' +
    '<div class="nav"><h3>Table of Contents</h3><ul><li>Coroutines</li></ul></div>' +
    '<div class="body" role="main">' +
    '<h1>Coroutines and tasks</h1>' +
    '<p>' + 'This section outlines high-level asyncio APIs. '.repeat(500) + '</p>' +
    '</div></body></html>'

  const res = slimResult(page, { label: 'web_fetch' })
  const headSection = res.text.split('--- digest')[0]
  check('main landmark is honoured', res.text.includes('Coroutines and tasks'), headSection.slice(0, 260))
  check('navigation is skipped when a landmark exists', !headSection.includes('Table of Contents'), headSection.slice(0, 260))

  // <main> and <article> work the same way. Bodies must exceed the inline
  // threshold, or slimming does not engage and there is no text to inspect.
  for (const tag of ['main', 'article']) {
    const p2 =
      '<html><body><div>nav</div><' + tag + '><h1>Body Title</h1><p>' + 'x'.repeat(12000) + '</p></' + tag + '></body></html>'
    const r2 = slimResult(p2, { label: 'web_fetch' })
    check(`<${tag}> landmark is honoured`, r2.slimmed && r2.text.includes('Body Title'), r2.text ? r2.text.slice(0, 200) : 'not slimmed')
  }

  // Pages with no landmark must still work through the heading/paragraph fallback.
  const plain = '<html><body><div>nav junk</div><h1>Only Title</h1><p>' + 'y'.repeat(12000) + '</p></body></html>'
  const r3 = slimResult(plain, { label: 'web_fetch' })
  check('fallback still finds the heading', r3.slimmed && r3.text.includes('Only Title'), r3.text ? r3.text.slice(0, 200) : 'not slimmed')
}

console.log('\n=== document chrome is dropped (found in live probing) ===')
{
  // A live docs page kept `<meta property="og:...">` and a <nav> list as its
  // head, so the model paid for keywords it could never use.
  const withChrome =
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta property="og:title" content="X">' +
    '<meta property="og:url" content="https://example.com"><title>T</title></head>' +
    '<body><script>var x = "should not appear";</script>' +
    '<h1>Real Title</h1>\n<p>' + 'Meaningful sentence about the topic. '.repeat(400) + '</p></body></html>'

  const res = slimResult(withChrome, { label: 'web_fetch' })
  check('meta/og tags are not in the head', !res.text.includes('og:title'), res.text.slice(0, 300))
  check('script contents are not in the head', !res.text.includes('should not appear'))
  check('the page title survives', res.text.includes('Real Title'), res.text.slice(0, 300))
  check('archived text is still the verbatim original', res.archived === withChrome)
}

console.log('\n=== non-HTML payloads are NOT treated as markup ===')
{
  // A JSON API response may contain "<style>" or "<main>" as DATA. Stripping it
  // would corrupt what the model reads.
  const payload = {
    items: Array.from({ length: 2000 }, (_, i) => ({
      id: i,
      html: '<main>important content ' + i + '</main>',
      css: '<style>.x{}</style>',
    })),
  }
  const json = JSON.stringify(payload, null, 2)
  const res = slimResult(json, { label: 'web_fetch' })
  check('json is slimmed', res.slimmed)
  check('json payload keeps its <style> string', res.text.includes('<style>.x{}</style>'), res.text.slice(0, 300))
  check('json payload keeps its <main> string', res.text.includes('<main>important content 0</main>'))
  check('json head starts at the real body, not mid-structure', res.text.includes('"items"'), res.text.slice(0, 260))
  check('json archived verbatim', res.archived === json)
}

console.log('\n=== digest fidelity (the bug this round found) ===')
{
  const res = slimResult(BIG, { label: 'coroutines.html' })
  const landmarks = res.text.split('\n').filter((l) => /^\s*- /.test(l)).map((l) => l.replace(/^\s*- /, '').trim())

  check('digest found headings', landmarks.length >= 5, `${landmarks.length}: ${landmarks.join(' | ')}`)
  check('no leftover HTML entities in landmarks', !landmarks.some((l) => /&#?\w+;/.test(l)), landmarks.join(' | '))
  check('permalink glyph stripped', !landmarks.some((l) => /[¶#§]/.test(l)), landmarks.join(' | '))
  check('entities decoded to readable text', landmarks.some((l) => l.includes('&')), landmarks.join(' | '))
  // A live run turned "<p>There are three main types of ...:" into a heading.
  check('paragraph text is not mistaken for a heading', !landmarks.some((l) => /^</.test(l)), landmarks.join(' | '))

  // Each landmark must be findable in the *decoded* source, so the model can
  // locate it after recall instead of searching for text that does not exist.
  const decodedSource = BIG
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&mdash;/g, '—')
  const unfindable = landmarks.filter((l) => !decodedSource.includes(l))
  check('every landmark is findable in the source', unfindable.length === 0, unfindable.join(' | '))
}

console.log('\n=== recall round-trip ===')
{
  const sample = 'ABCDEFGHIJ' + 'x'.repeat(100) + 'Z'
  check('exact slice', recallSlice(sample, 5, 15).text === sample.slice(5, 15))
  check('reports true total', recallSlice(sample, 5, 15).total === sample.length)
  check('clamps past end', recallSlice(sample, sample.length - 3, sample.length + 999).end === sample.length)
  check('rejects empty range', recallSlice(sample, 10, 10) === null)
  check('rejects inverted range', recallSlice(sample, 20, 5) === null)
  check('negative start clamps to 0', recallSlice(sample, -50, 5).start === 0)
  check('real page slice matches source bytes', recallSlice(BIG, 1000, 1300).text === BIG.slice(1000, 1300))
}

console.log('\n=== safety ===')
{
  check('never returns larger than input', (() => {
    const t = 'a'.repeat(9000)
    const r = slimResult(t)
    return !r.slimmed || r.text.length < t.length
  })())
  check('squeeze preserves content order', squeeze('a  \n\n\n  b').replace(/\s/g, '') === 'ab')
  // A head may carry code. Collapsing leading indentation would corrupt Python
  // or YAML, where indentation is syntax.
  const py = 'def f():\n    if x:\n        return 1\n    return 0\n'
  check('squeeze preserves code indentation', squeeze(py) === py.trim(), JSON.stringify(squeeze(py)))
  check('squeeze still collapses inside a line', squeeze('a    b') === 'a b')
  check('squeeze still collapses blank lines', squeeze('a\n\n\n\nb') === 'a\n\nb')
  check('digest dedupes repeated headings', digest('# A\n# A\n# B').length === 2)
  check('archived text is the verbatim original', (() => {
    const r = slimResult(BIG)
    return r.archived === BIG
  })())
}

console.log('')
console.log(fail === 0 ? 'ALL C CHECKS PASSED' : `${fail} CHECK(S) FAILED`)
process.exitCode = fail === 0 ? 0 : 1
