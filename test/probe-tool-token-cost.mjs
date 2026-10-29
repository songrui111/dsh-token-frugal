/**
 * Probe: how many tokens does each tool definition cost in the system prompt?
 *
 * Reads the live tool inventory + the live prompt assembly from the running
 * Harness and prices them with the live tokenMeter estimator. We do NOT reimplement
 * the estimator: we call the real one via ctx.tokenMeter.estimateMessage.
 *
 * Run for HOST measurement:  dsh --profile <p> ... (see README)
 * Simpler variant: this file is executed as a throwaway cordis *preset* plugin.
 */

const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g

/** Fallback heuristic only; prefer ctx.tokenMeter. */
function heuristic(text) {
  if (!text) return 0
  const cjk = (text.match(CJK) || []).length
  const rest = text.length - cjk
  return Math.ceil(cjk * 0.6 + rest * 0.25)
}

function schemaCost(tool) {
  // The model sees name + description + JSON schema. JSON.stringify approximates
  // the wire form; the real adapter may add framing, which is a constant offset
  // and cancels out in a "which tools cost most" ranking.
  const json = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })
  return json
}

export function apply(ctx) {
  ctx.effect(() => {
    // Give the host a moment to finish assembling plugins before probing.
    const timer = setTimeout(() => {
      try {
        const tools = ctx.tools.schemas()
        const meter = ctx.get('tokenMeter')

        const rows = tools.map((t) => {
          const json = schemaCost(t)
          const tokens = meter
            ? Math.ceil(meter.estimateMessage({ role: 'system', content: [{ type: 'text', text: json }], source: { kind: 'system-prompt' } }))
            : heuristic(json)
          return { name: t.name, chars: json.length, tokens }
        })
        rows.sort((a, b) => b.tokens - a.tokens)

        const total = rows.reduce((s, r) => s + r.tokens, 0)
        const header = [
          '=== TOKEN DIET PROBE: tool schema cost (live) ===',
          `tools: ${rows.length}   schema-only tokens: ${total}`,
          `estimator: ${meter ? 'ctx.tokenMeter (live)' : 'heuristic fallback'}`,
          '',
          'rank | tokens | chars | tool',
        ]
        const body = rows.map((r, i) => `${String(i + 1).padStart(4)} | ${String(r.tokens).padStart(6)} | ${String(r.chars).padStart(6)} | ${r.name}`)

        const output = [...header, ...body].join('\n')
        process.stderr.write('\n' + output + '\n')
        // Also surface to the user via the TTY when available.
        try {
          console.error(output)
        } catch { /* ignore */ }
      } catch (error) {
        process.stderr.write('[token-diet test] failed: ' + String(error && error.stack || error) + '\n')
      }
    }, 1500)
    return () => clearTimeout(timer)
  })
}

export const inject = ['tools']
