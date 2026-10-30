# dsh-readprune

Save tokens in a DeepSeek Harness session by keeping content out of the context
in the first place.

A Host plugin that **prunes input at the source** rather than compressing it
afterwards: read any file by line range or symbol mention instead of whole, and
bound oversized tool results at the boundary while keeping a recovery path.

## What makes this different

Most token-saving plugins work on content that has *already* entered the
context: they summarize it, fold it, or trim it after the fact. This one tries
to keep the expensive content out in the first place:

- A question about one function no longer costs a whole file.
- A 177,000-character docs page no longer costs a whole page.

Nothing is rewritten by a model, and nothing is lost: every pruned body is
archived and readable again by offset.

## Three deferred-loaded tools

| Tool | What it does |
|---|---|
| `read_range` | Reads **only the lines asked for**: a line window, every mention of a symbol with context, or a structural outline. Hard-capped output. |
| `tool_catalog` | One-line inventory of the tools this session can call, so a deferred toolset stays discoverable. |
| `fetch_recall` | Reads any slice of a pruned result by absolute character offset. |

## Two result-shaping passes

Scoped by tool name through `tools/post-execute`:

- **Web pages** — a bounded prose head (starting at the page's content landmark
  when it marks one) plus a digest of the page's headings.
- **Shell output** — head **and** tail. Diagnostics live at the end, and the
  host's own byte cap otherwise drops them.

## Measured

### Session level (the number that matters)

A tool result is re-sent on every step after it enters, so its real cost is
`size x (steps remaining)`. Modeling a 30-step session with four file reads:

| | Prompt tokens |
|---|---:|
| Whole-file reads | 667,776 |
| Pruned reads | 374,512 |
| **Saving** | **293,264 (43.9%)** |

The saving grows with session length: 33.6% at 10 steps, 43.9% at 30, 47.8% at
100. It is capped below 50% because a fixed prompt baseline (opening message,
system prompt, tool schemas) is paid on every step and is not touched here.

Reproduce it yourself:

```
npm run measure:session
```

### Per operation

Same question, only the read strategy changed:

| File | Lines | Whole read | `read_range` | Saved |
|---|---:|---:|---:|---:|
| index.js | 464 | 4,661 tok | 188 tok | 96.0% |
| client.js | 710 | 9,389 tok | 274 tok | 97.1% |
| bench/index.js | 875 | 8,999 tok | 513 tok | 94.3% |

Oversized results:

| Body | Raw | Pruned | Saved |
|---|---:|---:|---:|
| docs page (live fetch) | 46,582 tok | 583 tok | 98.7% |
| shell output (2.8M chars, host-capped) | 16,842 tok | 1,515 tok | 91.0% |

The per-operation figures are large because one operation can replace a whole
file. They are **not** whole-session savings — use the session table for that.

Token counts use a deterministic approximation of the harness token rule
(CJK about 1.7 chars/token, code about 3.8 chars/token). They compare
strategies; they do not predict a bill.

## Install

```bash
dsh plugin install dsh-readprune
```

The row id stays `token-diet` across renames, so a `config` override in your own
`cordis.patch.yml` keeps applying.

## Config

| Key | Default | Meaning |
|---|---|---|
| `guide` | `true` | Inject the "prefer `read_range`" prompt section. Without it the tools exist but a model keeps dumping whole files. Costs ~162 tokens per turn. |
| `exposeCatalog` | `true` | Register `tool_catalog`. |
| `slim` | `true` | Prune oversized results via `tools/post-execute`. |
| `slimWebTools` | `["web_fetch"]` | Web-shaped results: prose head + heading digest. |
| `slimShellTools` | `["pwsh","bash","wsl","tty_run"]` | Shell-shaped results: head + tail. `post-execute` is a **global** waterfall, so only listed tools are touched. |
| `maxInlineChars` | `8000` | Above this size a result is pruned. |
| `headChars` | `1500` | Web mode: characters kept inline. |
| `shellHeadLines` / `shellTailLines` | `60` / `60` | Shell mode: lines kept from each end. |
| `durableArchive` | `true` | Archive pruned bodies under `~/.dsh/token-diet/archive` so locators survive a restart. Falls back to memory if the disk refuses. |
| `maxArchiveFiles` | `200` | Oldest archived bodies are pruned past this count. |

## Tests

```
npm test               # five suites, no network
npm run measure:reads  # the per-operation table
npm run measure:page   # the web page figure (fetches docs.python.org)
npm run measure:session # the session table
```

`npm test` covers tool invocation end to end, the pruning passes on an offline
fixture, the `post-execute` wiring (including proof that `read`/`grep`/`edit`
are untouched), and the durable archive.

## Honest limits

- **It cannot shrink other plugins' tool schemas.** There is no service or event
  to mark another plugin's `ToolSchema` as `deferLoading`; only this plugin's
  own tools are deferred. On a heavily loaded profile the fixed per-turn schema
  cost remains.
- **`symbol` mode is textual, not semantic.** It matches substrings, so `save`
  also hits `savesSelection`. Use `mode: outline` when the identifier is unknown.
- **`read` is untouched.** The upstream file tools keep working, so a model can
  always fall back — which means savings appear only when it actually chooses
  `read_range`.
- **Archived bodies are plain files** under `~/.dsh/token-diet/archive`,
  readable by anything running as you. Do not enable this on shared machines if
  fetched content may be sensitive.
- **`spillStore` is not used.** Its runtime availability could not be confirmed,
  and a hard dependency on it would disable pruning entirely if absent.

## Licence

MIT. Icon is original artwork drawn for this plugin.
