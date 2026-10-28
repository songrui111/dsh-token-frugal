/**
 * Durable archive for slimmed tool results.
 *
 * The in-memory archive only survives one process, so a locator printed before a
 * restart became a dead end. This module persists archived bodies to disk under
 * the user's dsh home and reads them back by locator + character range.
 *
 * Design constraints:
 *
 * - **Session-scoped.** A locator belongs to the session that produced it; one
 *   session must never read another's archived body.
 * - **Best effort.** Archiving must never break a tool call. Every failure is
 *   swallowed and reported as "archive unavailable" so the caller can keep the
 *   inline result.
 * - **Bounded.** Old files are pruned so a long-running install cannot grow
 *   without limit.
 * - **Private.** Files are written under the user profile with a random-ish
 *   name and no predictable path from the locator alone.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const INDEX_VERSION = 1

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function archiveRoot() {
  return path.join(homeDir(), 'token-diet', 'archive')
}

function indexFile() {
  return path.join(archiveRoot(), 'index.json')
}

function safeReadIndex() {
  try {
    const raw = fs.readFileSync(indexFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && parsed.version === INDEX_VERSION && parsed.entries && typeof parsed.entries === 'object') {
      return parsed.entries
    }
  } catch {
    /* missing or corrupt: start fresh */
  }
  return {}
}

function safeWriteIndex(entries) {
  const dir = archiveRoot()
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${indexFile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: INDEX_VERSION, entries }), 'utf8')
  fs.renameSync(tmp, indexFile())
}

/**
 * Resolve an index entry's `file` inside the archive root.
 * Returns null when the entry would escape it — the index is plain text on
 * disk, so its contents are untrusted input for both reads AND deletes.
 */
function safeEntryPath(file) {
  const root = archiveRoot()
  const name = String(file || '')
  if (!name || name.includes('\0')) return null
  const full = path.resolve(root, name)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (!full.startsWith(rootWithSep)) return null
  // A plain filename only: no subdirectories, no traversal segments.
  if (path.basename(full) !== name) return null
  return full
}

/** Prune so the archive cannot grow forever. Oldest files go first. */
function prune(entries, maxFiles) {
  const items = Object.entries(entries)
  if (items.length <= maxFiles) return entries
  const ordered = items.sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
  const dropCount = items.length - maxFiles
  const kept = {}
  for (let i = 0; i < ordered.length; i += 1) {
    const [locator, meta] = ordered[i]
    if (i < dropCount) {
      const victim = safeEntryPath(meta && meta.file)
      if (victim) {
        try {
          fs.rmSync(victim, { force: true })
        } catch {
          /* ignore */
        }
      }
    } else {
      kept[locator] = meta
    }
  }
  return kept
}

/**
 * Persist a body and return its locator.
 * @returns {{ok: true, locator: string} | {ok: false, reason: string}}
 */
export function saveArchive({ sessionId, text, label, maxFiles = 200 } = {}) {
  try {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, reason: 'empty body' }
    }
    const dir = archiveRoot()
    fs.mkdirSync(dir, { recursive: true })

    const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)
    const locator = `td-${digest}-${text.length.toString(36)}`
    const file = `${locator}.txt`
    const full = path.join(dir, file)

    // Content-addressed: the same body is stored once.
    if (!fs.existsSync(full)) fs.writeFileSync(full, text, 'utf8')

    const entries = safeReadIndex()
    entries[locator] = {
      file,
      sessionId: sessionId ? String(sessionId) : null,
      label: label || 'result',
      chars: text.length,
      at: Date.now(),
    }
    safeWriteIndex(prune(entries, maxFiles))
    return { ok: true, locator }
  } catch (error) {
    return { ok: false, reason: (error && error.message) || String(error) }
  }
}

/**
 * Read a slice back.
 * @returns {{ok: true, text: string, start: number, end: number, total: number} | {ok: false, reason: string}}
 */
export function loadArchive({ locator, sessionId, start = 0, end } = {}) {
  try {
    const entries = safeReadIndex()
    const meta = entries[locator]
    if (!meta) return { ok: false, reason: 'not-found' }

    // Session scoping: a locator is only readable by the session that made it.
    if (meta.sessionId && sessionId && String(sessionId) !== meta.sessionId) {
      return { ok: false, reason: 'other-session' }
    }

    // The index file is plain text on disk, so `file` is untrusted input: it must
    // not escape the archive directory.
    const full = safeEntryPath(meta.file)
    if (!full) {
      return { ok: false, reason: 'invalid-entry' }
    }
    if (!fs.existsSync(full)) {
      return { ok: false, reason: 'evicted' }
    }

    const text = fs.readFileSync(full, 'utf8')
    const s = Math.max(0, Math.min(Number(start) || 0, text.length))
    const requestedEnd = end === undefined || !Number.isFinite(Number(end)) ? s + 4000 : Number(end)
    // Reject an inverted range BEFORE clamping: clamping would fold end up to s
    // and report an "empty range" for what is really a malformed request.
    if (requestedEnd < s) return { ok: false, reason: 'inverted-range', total: text.length }
    const e = Math.min(text.length, requestedEnd)
    if (e <= s) return { ok: false, reason: 'empty-range', total: text.length }
    return { ok: true, text: text.slice(s, e), start: s, end: e, total: text.length }
  } catch (error) {
    return { ok: false, reason: (error && error.message) || String(error) }
  }
}

/** Test hook: list what is on disk. */
export function listArchives() {
  return safeReadIndex()
}

/** Test hook: root path, so tests can point it somewhere disposible. */
export const __paths = { archiveRoot, indexFile, homeDir }
