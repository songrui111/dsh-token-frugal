/**
 * dsh-token-prune — prune a session's input at the source.
 *
 * Three tools, all deferred-loaded so their schemas cost almost nothing per turn:
 *
 *   read_range     precise reads (line windows, symbol mentions, structural
 *                  outlines, capped output) instead of dumping whole files.
 *   tool_catalog   self-serve inventory: once tools stop being inlined, the
 *                  model must be able to rediscover what exists.
 *   fetch_recall   read back any slice of a pruned result by character offset.
 *
 * The difference from a compressing plugin: this one tries to keep expensive
 * content out of the context in the first place, rather than shrinking it after
 * it has arrived.
 *
 * Design notes
 * ------------
 * - Everything here is deterministic and local: no model call, no network.
 * - Output is hard-capped (maxLines / maxMatches) so a runaway match cannot
 *   re-create the very problem this plugin exists to solve.
 * - The catalog reads live state through ctx.tools / ctx.systemPrompt so it
 *   never goes stale; nothing is cached across steps.
 */

import { slimResult, slimShellResult, __cTest as ingestTest } from './ingest.js'
import { saveArchive, loadArchive } from './archive.js'

const DEFAULT_WINDOW = 40
const MAX_WINDOW = 400
const MAX_MATCHES = 200

/**
 * Archive handlers.
 *
 * Durable storage (disk) is the default, so a locator printed before a restart
 * still resolves afterwards. An in-process map remains as a fallback for when
 * the disk is unavailable, which keeps slimming working instead of failing.
 */
function makeArchive(config = {}) {
  const durable = config.durableArchive !== false
  const memory = new Map()
  let seq = 0
  const maxMemory = 40

  return {
    /** @returns {string} a locator the model can cite */
    remember(sessionId, text, label) {
      if (durable) {
        const saved = saveArchive({ sessionId, text, label, maxFiles: config.maxArchiveFiles || 200 })
        if (saved.ok) return saved.locator
        // Disk refused: keep the body in memory rather than losing it.
      }
      seq += 1
      const locator = `td-mem-${seq}`
      memory.set(locator, { sessionId, text, at: Date.now() })
      if (memory.size > maxMemory) {
        const oldest = memory.keys().next().value
        if (oldest !== undefined) memory.delete(oldest)
      }
      return locator
    },

    /** @returns {{ok:true,text,start,end,total} | {ok:false,reason,total?}} */
    recall(locator, sessionId, start, end) {
      const key = String(locator || '')
      const hit = memory.get(key)
      if (hit) {
        if (sessionId !== undefined && hit.sessionId !== undefined && hit.sessionId !== sessionId) {
          return { ok: false, reason: 'other-session' }
        }
        const total = hit.text.length
        const s = Math.max(0, Math.min(Number(start) || 0, total))
        const requested = end === undefined || !Number.isFinite(Number(end)) ? s + 4000 : Number(end)
        if (requested < s) return { ok: false, reason: 'inverted-range', total }
        const e = Math.min(total, requested)
        if (e <= s) return { ok: false, reason: 'empty-range', total }
        return { ok: true, text: hit.text.slice(s, e), start: s, end: e, total }
      }
      if (!durable) return { ok: false, reason: 'not-found' }
      return loadArchive({ locator: key, sessionId, start, end })
    },
  }
}

/** Unicode-safe code point length, matching the harness's own measuring rule. */
function cpLength(text) {
  let n = 0
  for (const _ of text) n += 1
  return n
}

/**
 * Resolve a relative path to a READABLE file, trying several anchors.
 *
 * Live probing in the desktop Host established two facts that drive this:
 *
 *   1. `fs.resolve()` almost never throws: it happily returns a target for a
 *      path that does not exist. The real failure surfaces on `readText()`.
 *      So "did resolve() succeed?" is useless as a test; we must try a read.
 *   2. `process.cwd()` (and `workingDirectory.defaultDirectory`, which equals it)
 *      is the PROFILE directory, not the user's workspace. Anchoring there sent
 *      every relative path into `...\.dsh\profiles\desktop\...` and read failed.
 *
 * Therefore: build a list of candidate anchors, and for each one resolve AND
 * read. The first anchor that yields readable text wins. Order:
 *
 *   1. `exec.agent` -> `workingDirectory.ensure(agent)`: the session's own
 *      directory. `exec.agent` really exists on the tool runtime context
 *      (`ToolExecutionInput.agent`), so this is the most precise source.
 *   2. `exec.cwd`: when the runtime supplies one.
 *   3. `process.cwd()`: last resort only.
 */
async function anchorCandidates(ctx, exec) {
  const anchors = []
  const push = (dir) => {
    if (typeof dir === 'string' && dir && !anchors.includes(dir)) anchors.push(dir)
  }

  // 1. The session's own directory, resolved through its Agent.
  try {
    const wd = ctx.get('workingDirectory')
    const agent = exec && exec.agent
    if (wd && agent && typeof wd.ensure === 'function') {
      push(await wd.ensure(agent, exec && exec.signal))
    }
  } catch {
    /* agent-less or service absent: fall through */
  }

  // 2. An explicitly supplied runtime cwd.
  if (exec && typeof exec.cwd === 'string') push(exec.cwd)

  // 3. Deployment fallback.
  try {
    const wd = ctx.get('workingDirectory')
    if (wd && typeof wd.defaultDirectory === 'string') push(wd.defaultDirectory)
  } catch {
    /* ignore */
  }
  push(process.cwd())

  return anchors
}

/**
 * Read `path` from the first anchor that actually yields text.
 * Returns { text, target, anchor } or throws the last error.
 */
async function readWithAnchors(ctx, path, exec) {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('filesystem service unavailable; cannot read files')

  const raw = String(path)
  const signal = exec && exec.signal
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/]|~)/.test(raw)

  const tryRead = async (target) => {
    const text = await fs.readText(target, signal)
    if (typeof text !== 'string') throw new Error('filesystem returned a non-text result')
    return text
  }

  if (isAbsolute) {
    const target = await fs.resolve(raw, { signal })
    return { text: await tryRead(target), target, anchor: null }
  }

  const tried = []
  let lastError
  for (const anchor of await anchorCandidates(ctx, exec)) {
    try {
      const target = await fs.resolve(raw, { cwd: anchor, signal })
      const text = await tryRead(target)
      return { text, target, anchor }
    } catch (error) {
      lastError = error
      tried.push(anchor)
    }
  }

  // A precise diagnostic beats "not found": name what was tried.
  const detail = lastError && lastError.message ? lastError.message : String(lastError)
  throw new Error(
    `cannot read ${JSON.stringify(raw)} from any anchor (tried: ${tried.join(' | ') || 'none'}); ` +
      `last error: ${detail}. Pass an absolute path if the file lives outside these roots.`,
  )
}

function clamp(value, lo, hi, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(lo, Math.min(hi, Math.trunc(value)))
}

/* ------------------------------------------------------------------ *
 * read_range
 * ------------------------------------------------------------------ */

const readRangeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'File path (workspace-relative or absolute).' },
    mode: {
      type: 'string',
      enum: ['lines', 'symbol', 'outline'],
      description:
        "lines = read a line window; symbol = every line mentioning a term plus context; outline = structural lines only (braces/imports/exports).",
    },
    start: { type: 'integer', description: 'lines mode: 1-based first line (default 1).' },
    end: { type: 'integer', description: 'lines mode: 1-based last line (default start+39).' },
    symbol: { type: 'string', description: 'symbol mode: identifier or text to locate.' },
    context: { type: 'integer', description: 'symbol mode: context lines around each hit (default 2).' },
    maxLines: { type: 'integer', description: 'Cap on returned lines regardless of mode (default 40, max 400).' },
  },
  required: ['path'],
}

function sliceLines(lines, start, end) {
  const from = Math.max(1, start)
  const to = Math.min(lines.length, end)
  if (to < from) return { lines: [], from, to }
  return { lines: lines.slice(from - 1, to), from, to }
}

function formatNumbered(lines, firstLineNumber) {
  return lines.map((text, i) => `${String(firstLineNumber + i).padStart(5)}| ${text}`).join('\n')
}

function runReadRange(args, fileText) {
  const lines = fileText.split(/\r\n|\r|\n/)
  const total = lines.length
  const maxLines = clamp(args.maxLines, 1, MAX_WINDOW, DEFAULT_WINDOW)
  const mode = args.mode || (args.symbol ? 'symbol' : 'lines')

  if (mode === 'lines') {
    const start = clamp(args.start, 1, total || 1, 1)
    const end = clamp(args.end, start, total || start, start + DEFAULT_WINDOW - 1)
    const capEnd = Math.min(end, start + maxLines - 1)
    const picked = sliceLines(lines, start, capEnd)
    return {
      header: `${args.path}:${picked.from}-${picked.to} of ${total} lines${capEnd < end ? ` (capped at maxLines=${maxLines})` : ''}`,
      body: formatNumbered(picked.lines, picked.from),
    }
  }

  if (mode === 'symbol') {
    const needle = String(args.symbol || '')
    if (!needle) throw new Error('symbol mode requires a non-empty `symbol`')
    const ctxLines = clamp(args.context, 0, 20, 2)
    const hits = []
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(needle)) hits.push(i + 1)
      if (hits.length > MAX_MATCHES * 4) break
    }
    if (hits.length === 0) {
      return { header: `${args.path}: no line contains ${JSON.stringify(needle)} (${total} lines)`, body: '' }
    }
    // Merge overlapping windows so the same line is never paid for twice.
    const windows = []
    for (const lineNo of hits) {
      const from = Math.max(1, lineNo - ctxLines)
      const to = Math.min(total, lineNo + ctxLines)
      const last = windows[windows.length - 1]
      if (last && from <= last.to + 1) last.to = Math.max(last.to, to)
      else windows.push({ from, to })
    }
    let emitted = 0
    const chunks = []
    for (const w of windows) {
      if (emitted >= maxLines) break
      const room = maxLines - emitted
      const to = Math.min(w.to, w.from + room - 1)
      const picked = sliceLines(lines, w.from, to)
      chunks.push(formatNumbered(picked.lines, picked.from))
      emitted += picked.lines.length
    }
    const truncated = emitted < windows.reduce((s, w) => s + (w.to - w.from + 1), 0)
    return {
      header: `${args.path}: ${hits.length} match(es) for ${JSON.stringify(needle)} in ${total} lines; showing ${emitted} line(s)${truncated ? ` (capped at maxLines=${maxLines})` : ''}`,
      body: chunks.join('\n...\n'),
    }
  }

  if (mode === 'outline') {
    // An outline is already a compressed view: every retained line is structure.
    // Applying the small `lines`-mode window here silently truncated deep members
    // (the exported entry point was cut off), so the cap is the structural maximum.
    const outlineCap = clamp(args.maxLines, 1, MAX_WINDOW, MAX_WINDOW)
    const patterns = [
      // declarations: `export`/`default` prefixes must not hide the declaration itself
      /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*\w*\s*[({]/,
      /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/,
      /^\s*(export\s+)?(default\s+)?(const|let|var)\s+\w+\s*=/,
      /^\s*(export\s+)?(interface|type|enum)\s+\w+/,
      // other languages commonly opened in this harness
      /^\s*(def|class)\s+\w+/,
      /^\s*func\s+/,
      /^\s*(struct|impl|trait|fn)\s+/,
      /^\s*(public|private|protected|static)\s+/,
      // bare import/export lines are structure too, but only as a fallback marker
      /^\s*import\s+/,
      /^\s{0,3}#{1,6}\s+/,
    ]
    const picked = []
    for (let i = 0; i < lines.length && picked.length < outlineCap; i += 1) {
      const line = lines[i]
      if (!line.trim()) continue
      if (patterns.some((re) => re.test(line))) picked.push({ n: i + 1, text: line })
    }
    return {
      header: `${args.path}: outline, ${picked.length} structural line(s) of ${total}`,
      body: picked.map((p) => `${String(p.n).padStart(5)}| ${p.text}`).join('\n'),
    }
  }

  throw new Error(`unknown mode ${JSON.stringify(mode)}`)
}

/* ------------------------------------------------------------------ *
 * tool_catalog
 * ------------------------------------------------------------------ */

const toolCatalogSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Optional case-insensitive substring to filter tool names and descriptions.' },
    detail: { type: 'string', description: 'brief = name + first sentence only (default); full = include parameter names.' },
  },
}

const catalogOutputSchema = {
  type: 'object',
  properties: {
    tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' } },
        required: ['name', 'description'],
      },
    },
  },
  required: ['tools'],
}

function firstSentence(text) {
  const trimmed = String(text || '').trim()
  // Sentence ends in both Latin and CJK punctuation (。！？), so a Chinese tool
  // description is cut at its first sentence too.
  const cut = trimmed.split(/(?<=[.!?。！？])\s*/)[0] || trimmed
  return cut.length > 140 ? `${cut.slice(0, 137)}...` : cut
}

function stripCtx(text) {
  // Tool descriptions sometimes carry full usage bodies; keep the model-facing line only.
  return firstSentence(
    String(text || '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

/* ------------------------------------------------------------------ *
 * Prompt guidance (the "Raw 鏀舵暃" half)
 * ------------------------------------------------------------------ */

/**
 * Order band for plugin plumbing guidance. Other Host plugins own 150
 * (`@linxin666/dsh-ssh`) and 152 (`@hyzyn/dsh-docker`), and 200 belongs to a
 * task board; 210 keeps this section in the same family band without colliding.
 */
const GUIDANCE_ORDER = 210

const GUIDANCE_TEXT = [
  '## Reading files without burning context',
  '',
  'Prefer `read_range` over a whole-file read. Every tool result stays in the',
  'conversation and is re-sent on every later step, so one 600-line dump costs',
  'its tokens again on each turn.',
  '',
  '- Do not know where the code is? Use `mode: "symbol"` with the identifier.',
  '- Do not know the file\'s shape? Use `mode: "outline"` first, then read the',
  '  few line ranges it points at.',
  '- Know the exact lines? Use `mode: "lines"` with `start`/`end`.',
  '- Only read a whole file when its full content is genuinely required.',
  '- `tool_catalog` lists available tools when you are unsure what exists.',
].join('\n')

/**
 * Render guidance only while the tools it describes are reachable in the
 * rendering scope. A restriction, a preset, or a failed registration that
 * removes `read_range` must not leave instructions pointing at it.
 * An unreadable registry renders the text unchanged: guidance that outlives a
 * momentary read failure is recoverable; guidance for a tool that is gone is not.
 */
function visibleToolText(tools, toolNames, text) {
  if (tools === undefined) return () => text
  return (context) => {
    try {
      for (const name of toolNames) {
        if (tools.get(name, context && context.scope) !== undefined) return text
      }
    } catch {
      return text
    }
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export const inject = ['tools']

export function apply(ctx, config = {}) {
  const exposeCatalog = config.exposeCatalog !== false
  const guide = config.guide !== false
  // One archive per mounted plugin instance: durable by default, with an
  // in-process fallback so slimming keeps working if the disk is unavailable.
  const archive = makeArchive(config)

  // Guidance is the half that makes "read raw less" actually happen: the tools
  // exist either way, but a model that is never told to prefer them keeps
  // dumping whole files, and the savings stay at zero.
  if (guide) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt) {
      // The guidance body tells the model to prefer `read_range`; `tool_catalog`
      // is only mentioned in passing. So the gate must be `read_range` alone:
      // an "any of these is visible" gate kept the section rendering after the
      // tool it describes was gone, which is exactly the failure mode the
      // visibility convention exists to prevent.
      ctx.effect(() =>
        systemPrompt.section({
          name: 'token-diet:reading',
          order: GUIDANCE_ORDER,
          text: visibleToolText(ctx.get('tools'), ['read_range'], GUIDANCE_TEXT),
        }),
      )
    }
  }

  ctx.effect(() => {
    const disposers = []

    disposers.push(
      ctx.tools.register({
        name: 'read_range',
        description:
          'Read a file frugally: return only the lines you asked for. Prefer this over dumping a whole file. ' +
          'mode=lines reads a window, mode=symbol finds every mention of a term with context, ' +
          'mode=outline lists only structural lines. Output is capped by maxLines.',
        parameters: readRangeSchema,
        deferLoading: true,
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          render: (_args, value) => [{ type: 'text', text: String(value && value.text ? value.text : '') }],
        },
        async execute(args, exec) {
          try {
            const { text: fileText } = await readWithAnchors(ctx, args.path, exec)
            const { header, body } = runReadRange(args, fileText)
            const text = body ? `${header}\n${body}` : header
            return { text, chars: cpLength(text) }
          } catch (error) {
            return { text: `read_range failed: ${error && error.message ? error.message : String(error)}` }
          }
        },
      }),
    )

    if (exposeCatalog) {
      disposers.push(
        ctx.tools.register({
          name: 'tool_catalog',
          description:
            'List the tools this session can call, with one-line descriptions. ' +
            'Use it when unsure whether a capability exists (installed plugins add tools). ' +
            'Filter with `query`; keep calls small.',
          parameters: toolCatalogSchema,
          deferLoading: true,
          output: {
            schema: catalogOutputSchema,
            render: (_args, value) => {
              const tools = (value && value.tools) || []
              const text = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
              return [{ type: 'text', text: text || '(no matching tool)' }]
            },
          },
          execute(args = {}) {
            const query = String(args.query || '').toLowerCase()
            const detail = args.detail === 'full'
            const seen = new Set()
            const tools = []
            for (const schema of ctx.tools.schemas()) {
              if (seen.has(schema.name)) continue
              seen.add(schema.name)
              const desc = stripCtx(schema.description)
              if (query && !`${schema.name} ${desc}`.toLowerCase().includes(query)) continue
              let line = desc
              if (detail) {
                const params = schema.parameters && schema.parameters.properties ? Object.keys(schema.parameters.properties) : []
                if (params.length) line = `${desc} [params: ${params.join(', ')}]`
              }
              tools.push({ name: schema.name, description: line })
            }
            return { tools }
          },
        }),
      )
    }

    // fetch_recall: the way back into anything that was slimmed.
    disposers.push(
      ctx.tools.register({
        name: 'fetch_recall',
        description:
          'Read a slice of a previously slimmed tool result (for example a large web_fetch body). ' +
          'The locator and total size are printed in the slimmed result. Uses absolute character ' +
          'offsets over the archived original text.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            locator: { type: 'string', description: 'Locator shown in the slimmed result header.' },
            start: { type: 'integer', description: 'Start character offset (0-based, default 0).' },
            end: { type: 'integer', description: 'End character offset, exclusive (default start+4000).' },
          },
          required: ['locator'],
        },
        deferLoading: true,
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          render: (_args, value) => [{ type: 'text', text: String(value && value.text ? value.text : '') }],
        },
        execute(args, exec) {
          const sessionId = exec && exec.agent ? exec.agent.id : undefined
          const start = Number.isFinite(args.start) ? args.start : 0
          const end = Number.isFinite(args.end) ? args.end : start + 4000
          const result = archive.recall(args.locator, sessionId, start, end)

          if (!result.ok) {
            const detail =
              result.reason === 'other-session'
                ? 'it belongs to a different session'
                : result.reason === 'evicted'
                  ? 'its file has been removed from disk'
                  : result.reason === 'inverted-range'
                    ? `its end offset is before its start offset`
                    : result.reason === 'empty-range'
                      ? `it covers an empty range of a ${result.total}-character body`
                      : 'it may have been pruned, or it belongs to another session'
            return { text: `fetch_recall: cannot read locator ${JSON.stringify(args.locator)} — ${detail}.` }
          }

          return {
            text: `${args.locator}: characters ${result.start}-${result.end} of ${result.total}\n${result.text}`,
            chars: cpLength(result.text),
          }
        },
      }),
    )

    // Ingest slimming: bound what an oversized tool result contributes to the
    // context. Scoped BY TOOL NAME because `post-execute` is a global waterfall
    // and must not rewrite unrelated results.
    //
    // Two shapes, because they fail differently:
    //   web pages  -> keep a prose head + heading digest (web_fetch).
    //   shell      -> keep head AND tail; diagnostics live at the end, and the
    //                 host's own byte cap otherwise drops them entirely.
    const webTools = new Set(config.slimWebTools || ['web_fetch'])
    const shellTools = new Set(config.slimShellTools || ['pwsh', 'bash', 'wsl', 'tty_run'])
    const servedTools = new Set([...webTools, ...shellTools])
    const maxInlineChars = config.maxInlineChars || 8000
    if (config.slim !== false) {
      ctx.effect(() =>
        ctx.on('tools/post-execute', async (exec, result, next) => {
          const decision = await next()
          try {
            if (!servedTools.has(exec.name)) return decision
            const content = decision && decision.content
            if (!Array.isArray(content)) return decision

            const textParts = content.filter((b) => b && b.type === 'text')
            if (textParts.length !== 1) return decision
            const original = String(textParts[0].text || '')
            if (original.length <= maxInlineChars) return decision

            // A failed call must keep its own shape: errors are diagnostic text,
            // and rewriting them can hide the reason the call failed.
            const slim = shellTools.has(exec.name) && !webTools.has(exec.name)
              ? slimShellResult(original, {
                  label: exec.name,
                  maxInlineChars,
                  headLines: config.shellHeadLines,
                  tailLines: config.shellTailLines,
                })
              : slimResult(original, { label: exec.name, maxInlineChars, headChars: config.headChars })
            if (!slim.slimmed) return decision

            const sessionId = exec.agent ? exec.agent.id : undefined
            const locator = archive.remember(sessionId, slim.archived, exec.name)
            const header = slim.text.replace(
              'call fetch_recall(locator, start, end)',
              `call fetch_recall(locator="${locator}", start, end)`,
            )
            return {
              ...decision,
              content: [{ type: 'text', text: header }, ...content.filter((b) => b !== textParts[0])],
            }
          } catch {
            // Never break a tool call because slimming failed: keep the original.
            return decision
          }
        }),
      )
    }

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }
  })
}

/* Exported for local verification without a running Host. */
export const __test = { runReadRange, cpLength, stripCtx, firstSentence, ingestTest, makeArchive }
