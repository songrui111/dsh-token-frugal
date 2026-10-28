/**
 * Ingest slimming (the "C" half of the diet).
 *
 * A single `web_fetch` of a docs page can return ~177,000 characters — roughly
 * 46k tokens — and every one of those tokens is re-sent on each later step.
 * Most of that content is never needed: the model wanted one section, or an
 * answer that was in the first screenful.
 *
 * This module turns an oversized tool result into:
 *   - a bounded head (what you would have read anyway),
 *   - a structural digest (headings, so the model knows what else is there),
 *   - the total size, and
 *   - a locator the model can pass to `fetch_recall` for an exact slice later.
 *
 * Everything here is pure and deterministic: no network, no model call, no IO.
 * Storage is injected so it can be unit-tested and so a failed spill can fall
 * back to keeping the result inline.
 */

/** Above this many characters, a fetched body is slimmed. */
const DEFAULT_MAX_INLINE_CHARS = 8000
/** Characters of the head kept inline. */
const DEFAULT_HEAD_CHARS = 1500
/** Structural lines kept as a digest. */
const DEFAULT_MAX_HEADINGS = 40

/** Collapse runs of blank space so a head does not pay for page layout. */
/**
 * Collapse runs of blank space so a head does not pay for page layout.
 *
 * Leading indentation is PRESERVED: a head may contain code, and for Python or
 * YAML the indentation IS the syntax. Only intra-line runs and excess blank
 * lines are compressed.
 */
function squeeze(text) {
  return String(text)
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const indent = /^[ \t\u00a0]*/.exec(line)[0].replace(/\u00a0/g, ' ')
      const rest = line.slice(indent.length).replace(/[ \t\u00a0]+/g, ' ').trimEnd()
      return indent + rest
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Decode the handful of HTML entities that appear inside heading text.
 *
 * Without this a digest says "Coroutines&#182;" while the page says
 * "Coroutines¶" — the model is handed a landmark it cannot find by searching
 * the archived text, which defeats the point of the digest.
 */
function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' }
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] ?? whole)
}

function safeFromCodePoint(code) {
  try {
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
}

/**
 * Pull structural landmarks out of a body so the model can see what it is
 * missing without reading it: markdown headings, HTML <h1>-<h3>, and lines that
 * look like section labels. Capped, because a digest that is long is not a digest.
 */
function digest(text, maxHeadings = DEFAULT_MAX_HEADINGS) {
  const out = []
  const lines = String(text).split(/\r\n|\r|\n/)

  for (const raw of lines) {
    if (out.length >= maxHeadings) break
    const line = raw.trim()
    if (!line) continue

    // markdown ATX heading
    const md = /^(#{1,3})\s+(.{1,120})$/.exec(line)
    if (md) {
      const label = decodeEntities(md[2]).trim()
      if (label) out.push(`${'  '.repeat(md[1].length - 1)}- ${label}`)
      continue
    }
    // HTML heading. Strip markup AND decode entities so the label is the text a
    // reader actually sees; permalink glyphs (¶) are decoration, not structure.
    const html = /<h([1-3])[^>]*>([\s\S]{1,200}?)<\/h\1>/i.exec(line)
    if (html) {
      const label = decodeEntities(html[2].replace(/<[^>]+>/g, ''))
        .replace(/[¶#§]\s*$/u, '')
        .trim()
      if (label) out.push(`${'  '.repeat(Number(html[1]) - 1)}- ${label}`)
      continue
    }
    // A short PLAIN-TEXT line ending in a colon is a section label. Markup lines
    // are excluded: a live run turned "<p>There are three main types of ...:"
    // into a bogus heading, which reads like structure but is prose.
    const looksLikeMarkup = /^<[a-zA-Z!/]/.test(line)
    if (!looksLikeMarkup && line.length <= 80 && /[:：]$/.test(line) && !/^[-*|+]/.test(line)) {
      const label = decodeEntities(line).replace(/[¶#§]\s*$/u, '').trim()
      if (label) out.push(`- ${label}`)
    }
  }

  // Dedupe while keeping order: docs pages repeat nav headings.
  const seen = new Set()
  return out.filter((h) => {
    const key = h.trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Slice an archived body by absolute character offsets.
 * Returns null when the request is out of range, so the caller can report it.
 */
export function recallSlice(text, start, end) {
  const s = Math.max(0, Math.min(Number(start) || 0, text.length))
  const e = Math.min(text.length, Math.max(s, Number(end) || 0))
  if (e <= s) return null
  return { text: text.slice(s, e), start: s, end: e, total: text.length }
}

/**
 * Find where readable prose begins, so the retained head is text a model can
 * use instead of document scaffolding (doctype, nav lists, wrapper divs).
 *
 * Order of preference:
 *
 * 1. A `<main>` / `<article>` / `role="main"` landmark. This is the cheap,
 *    standards-based version of "content extraction": pages that mark their
 *    main region (docs sites, blogs, most modern CMSs) tell us exactly where the
 *    prose starts, and on a live docs page this is the difference between a
 *    head made of navigation links and a head made of the actual document.
 * 2. The first real heading (h1-h3).
 * 3. The first paragraph of meaningful length.
 * 4. Offset 0.
 *
 * Deliberately NOT a full content-extraction algorithm: that would change how
 * many characters survive, and the surviving count is already bounded by
 * headChars. What improves here is the QUALITY of the retained window only.
 */
function findProseStart(body) {
  const source = String(body)

  // A content-root element that actually carries text, not an empty shell.
  const landmark = /<(main|article)\b[^>]*>[\s\S]{80,}?<\/\1>/i.exec(source)
    || /<[a-z][^>]*\brole\s*=\s*["']main["'][^>]*>[\s\S]{80,}?<\/[a-z]+>/i.exec(source)
  if (landmark) {
    // Continue from the landmark's opening tag so its own <h1> leads the head.
    return landmark.index
  }

  const heading = /<h[1-3]\b[^>]*>[\s\S]{4,200}?<\/h[1-3]>/i.exec(source)
  const para = /<p\b[^>]*>[\s\S]{60,}?<\/p>/i.exec(source)

  const candidates = [heading, para].filter(Boolean).map((m) => m.index)
  if (candidates.length === 0) return 0
  return Math.min(...candidates)
}

/**
 * Strip the parts of an HTML document that carry no meaning for a reader:
 * <head> (meta/og/title/charset tags), <script>, <style>, and comments.
 *
 * A live run showed why this matters: the retained "head" of a docs page was
 * entirely `<meta property="og:...">` tags, so the model paid for keywords it
 * could never use. Dropping this chrome makes both the head and the digest
 * describe the actual document.
 */
function stripChrome(text) {
  const source = String(text)
  // Only HTML documents get HTML treatment. A JSON API response or a plain-text
  // body may legitimately CONTAIN "<style>" or "<main>" as data; stripping those
  // would corrupt the payload the model is reading.
  if (!looksLikeHtml(source)) return source
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
}

/**
 * Does this body read as an HTML document?
 *
 * Requires a structural signal (doctype, <html>, or a head/body tag), not just
 * any angle bracket: a JSON payload full of "<tag>" strings is data, not markup.
 */
function looksLikeHtml(text) {
  const head = String(text).slice(0, 4000)
  return /<!doctype\s+html/i.test(head) || /<html[\s>]/i.test(head) || /<body[\s>]/i.test(head) || /<head[\s>]/i.test(head)
}

/**
 * Slim a SHELL output, which fails differently from a web page.
 *
 * A command's diagnostics land at the END: the error, the exit summary, the
 * "N files copied". The host's own cap keeps only the head, and it cuts at a
 * byte offset that can split the last line — so a failing command shows its
 * noisy preamble and loses the reason it failed, and the model has to re-run it.
 *
 * This mode keeps head AND tail, cuts on line boundaries, and reports how much
 * was dropped from the middle.
 */
export function slimShellResult(content, opts = {}) {
  const maxInline = opts.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS
  const headLines = opts.headLines ?? 60
  const tailLines = opts.tailLines ?? 60
  const label = opts.label ?? 'output'

  const text = typeof content === 'string' ? content : String(content ?? '')
  if (text.length <= maxInline) return { slimmed: false }

  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length <= headLines + tailLines) {
    // Long but few lines: fall back to a character window with a tail.
    const head = text.slice(0, Math.floor(maxInline * 0.6))
    const tail = text.slice(-Math.floor(maxInline * 0.3))
    const out = [
      `[token-diet] ${label} was ${text.length.toLocaleString()} characters in ${lines.length} long lines.`,
      `Middle omitted; full text archived — call fetch_recall(locator, start, end) for any slice.`,
      '',
      '--- head ---',
      head,
      '',
      '--- tail ---',
      tail,
    ].join('\n')
    return { slimmed: out.length < text.length, text: out, archived: text, chars: text.length }
  }

  const head = lines.slice(0, headLines)
  const tail = lines.slice(-tailLines)
  const dropped = lines.length - headLines - tailLines

  const out = [
    `[token-diet] ${label} was ${lines.length.toLocaleString()} lines (${text.length.toLocaleString()} characters); ` +
      `showing the first ${headLines} and last ${tailLines}.`,
    `Middle ${dropped.toLocaleString()} lines omitted; full text archived — call fetch_recall(locator, start, end).`,
    '',
    `--- head (first ${headLines} lines) ---`,
    ...head,
    '',
    `--- ... ${dropped.toLocaleString()} lines omitted ... ---`,
    '',
    `--- tail (last ${tailLines} lines) ---`,
    ...tail,
  ].join('\n')

  return { slimmed: out.length < text.length, text: out, archived: text, chars: text.length }
}

/**
 * Decide whether a tool result is worth slimming, and produce the replacement.
 *
 * @returns {{slimmed: false} | {slimmed: true, text: string, archived: string, chars: number}}
 */
export function slimResult(content, opts = {}) {
  const maxInline = opts.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS
  const headChars = opts.headChars ?? DEFAULT_HEAD_CHARS
  const maxHeadings = opts.maxHeadings ?? DEFAULT_MAX_HEADINGS
  const label = opts.label ?? 'result'

  const text = typeof content === 'string' ? content : String(content ?? '')
  if (text.length <= maxInline) return { slimmed: false }

  // Keep the ORIGINAL archived verbatim (recall must return real bytes), but
  // derive the head and digest from the meaningful body.
  const isHtml = looksLikeHtml(text)
  const body = isHtml ? stripChrome(text) : text

  // Prefer the first readable paragraph over raw markup: skip to the first
  // block of prose so the head is something the model can actually use.
  // Non-HTML bodies (JSON, plain text) start at the beginning: there is no
  // document scaffold to skip, and skipping would hide their real header.
  const proseStart = isHtml ? findProseStart(body) : 0
  const head = squeeze(body.slice(proseStart, proseStart + headChars))
  // A document's table of contents normally sits at the TOP of the page, so the
  // digest must scan the whole body. Scanning only the tail produced an empty
  // digest for exactly the pages (docs sites) that need one most.
  const headings = digest(body, maxHeadings)

  const parts = [
    `[token-diet] ${label} was ${text.length.toLocaleString()} characters; showing the first ${head.length} plus a structural digest.`,
    `Full text is archived; call fetch_recall(locator, start, end) for any slice.`,
    '',
    '--- head ---',
    head,
  ]

  if (headings.length) {
    parts.push('', `--- digest (${headings.length} landmarks across the whole body) ---`, ...headings)
  } else {
    parts.push('', '--- digest --- (no headings detected; recall by offset)')
  }

  const out = parts.join('\n')
  return { slimmed: out.length < text.length, text: out, archived: text, chars: text.length }
}

/** Exported for tests. */
export const __cTest = { squeeze, digest, recallSlice, DEFAULT_MAX_INLINE_CHARS }
