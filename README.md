# dsh-token-frugal

Stop paying for files and pages you didn't need to read.

A small Host plugin for DeepSeek Harness that adds three deferred-loaded tools:

| Tool | What it does |
|---|---|
| `read_range` | Reads **only the lines you asked for**: a line window, every mention of a symbol with context, or a structural outline. Hard-capped output. |
| `tool_catalog` | Lists the tools this session can actually call, one line each. Because once tools are deferred, the model must be able to rediscover them. |
| `fetch_recall` | Reads any slice of a tool result that was slimmed, by absolute character offset. |

It also **slims oversized `web_fetch` results**: a docs page can be ~177,000 characters (鈮?6k tokens) and every token of it is re-sent on each later turn. Above a threshold the plugin keeps a bounded head plus a digest of the page's headings, and offers `fetch_recall` for the rest.

## Why

Every tool round trip re-sends the whole conversation. Dumping a 600-line file to answer "where is `saveSelection` defined" writes ~3,000 tokens into the context **permanently** — and that cost is re-paid on every later turn.

`read_range` in `symbol` mode answers the same question with the matching lines only.

## Measured (offline, on real files from this workspace)

Same question, different read strategy:

| File | Lines | Whole read | `symbol` mode | Saved |
|---|---:|---:|---:|---:|
| `dsh-token-diet/index.js` | 464 | 4,661 tok | 188 tok | **96.0%** |
| `publisher-radar/client/client.js` | 710 | 9,389 tok | 274 tok | **97.1%** |
| `dsh-agent-bench/lib/index.js` | 875 | 8,999 tok | 513 tok | **94.3%** |
| **total** | | **23,049** | **975** | **95.8%** |

Oversized fetch results, same idea:

| Body | Raw | Slimmed | Saved |
|---|---:|---:|---:|
| docs page-shaped fixture | 4,742 tok | 495 tok | **89.6%** |
| Live `docs.python.org/3/library/asyncio-task.html` | 46,582 tok | ~579 tok | **98.8%** |

Token figures are a deterministic approximation of the Harness token rule (CJK 鈮?1.7 chars/token, code 鈮?3.8 chars/token). They are for comparison, not billing.

**Savings scale with file size.** Small scripts save less because the per-call header and window context floor dominates.

## Install

```bash
dsh plugin install dsh-token-frugal
```

Or install the folder as a bundle. The row id is `token-diet`; override `config` in your own `cordis.patch.yml` to change behaviour across upgrades.

## Config

| Key | Default | Meaning |
|---|---|---|
| `guide` | `true` | Inject the "prefer `read_range` over whole-file reads" prompt section. This is what makes the savings actually happen: without it the tools exist but a model keeps dumping whole files. |
| `exposeCatalog` | `true` | Register `tool_catalog`. Set `false` for a read-only diet (keeps your own tool inventory untouched). |
| `slim` | `true` | Slim oversized tool results via `tools/post-execute`. |
| `slimWebTools` | `["web_fetch"]` | Web-shaped results: prose head + heading digest. |
| `slimShellTools` | `["pwsh","bash","wsl","tty_run"]` | Shell-shaped results: **head + tail**, because diagnostics live at the end. Deliberately narrow: `post-execute` is a **global** waterfall, so only listed tools are touched. |
| `maxInlineChars` | `8000` | Above this character count a result is slimmed. |
| `headChars` | `1500` | Web mode: characters kept inline as the head. |
| `shellHeadLines` / `shellTailLines` | `60` / `60` | Shell mode: lines kept from each end. |
| `durableArchive` | `true` | Archive slimmed bodies under `~/.dsh/token-diet/archive` so locators survive a restart. Falls back to memory if the disk refuses. |
| `maxArchiveFiles` | `200` | Oldest archived bodies are pruned past this count. |

### Why shell output keeps its tail

A failing command writes its reason at the end — `Access is denied`, the exit summary, the copy count. The host's own cap (`maxOutputBytes`, 64000) keeps only the head and can cut mid-line, so the model sees the noise and never the error, then re-runs the command. Keeping head **and** tail is both cheaper (measured 91% fewer tokens than the capped head-only result) and more correct.

### About the guidance section

- It costs **~162 tokens per turn** (612 chars). That is the price of the suggestion, and it is why `guide` is a switch: measure both ways on your own workload.
- It renders **only while `read_range` is visible** to the rendering scope, so a preset, a restriction, or a failed registration cannot leave instructions pointing at a tool that is gone.
- Section order is `210`, chosen to sit in the plugin-guidance band (`150` ssh, `152` docker, `200` task board) without colliding.

## Honest limits

- **It does not shrink other plugins' tool schemas.** There is no service or event to mark another plugin's `ToolSchema` as `deferLoading`; only this plugin's own tools are deferred. On a heavily loaded profile the fixed per-turn schema cost remains (measured 56k tokens across 169 tools on one such profile).
- **Symbol mode is textual, not semantic.** It matches substrings, so `save` also hits `savesSelection`. Use `mode: outline` first when you don't know the exact identifier.
- **`read` is untouched.** The upstream file tools keep working, so the model can always fall back — which also means the savings only appear when the model actually chooses `read_range`.
- **Slimmed bodies are archived on disk** under `~/.dsh/token-diet/archive`, content-addressed and session-scoped, so a locator survives a restart (verified across two processes). Two caveats: pruning keeps the most recent `maxArchiveFiles` bodies, and archived bodies are **plain files under your user profile** — readable by anything running as you. Do not enable this on shared machines if fetched content may be sensitive.
- **`spillStore` is not used.** Its runtime availability could not be confirmed, and a hard dependency on it would disable slimming entirely if absent. The plugin owns its own small store instead.

## Licence

MIT. Icon is original artwork drawn for this plugin.
