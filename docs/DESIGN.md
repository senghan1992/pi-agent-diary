# Design

## Goal

A coding agent (pi, Claude Code, …) records what it did and why, as a by-product of working, in `.ad/` inside the
repository. Every new session starts knowing what the project is, how it got here, what was decided and where it
stands, **without the user writing or curating anything.**

## The constraint: history grows, context doesn't

A diary that grows without limit is a context bomb. Four mechanisms keep the per-session cost constant:

1. **Tiers.** Always loaded (PROJECT, STATUS, pinned decisions) → windowed (7-day timeline, 8 newest decisions)
   → recalled when relevant (any entry, decision, digest) → searchable only (everything, including archive).
2. **Hard write budgets.** Every always-loaded document and every journal entry has a token cap. Oversize writes
   are rejected with instructions to condense, so curation is forced instead of appending.
3. **A total cap.** The session bundle is assembled by priority and trimmed from the bottom if it still exceeds
   `budgets.context`.
4. **Roll-ups.** Cold months become one digest each. Day files move to `archive/`, so they leave the timeline but
   stay readable and searchable.

Start-of-session cost is therefore O(1) in history length. Recall cost is bounded per prompt and usually zero.

## The second problem: the middle distance

A fixed window hides everything between "last week" and "the digest". An agent doesn't know what it doesn't know,
so it won't search on its own. **Per-prompt recall** closes this gap:

- An in-process BM25 index over entries, active decisions and digest sections, rebuilt only when diary files change.
- Tokenization: Latin words (camelCase split, light stemming, stopwords) plus **character bigrams for Hangul/CJK**,
  so Korean particles don't block matches ("인증을" and "인증이" share "인증"). A small stop-list removes request
  phrasing ("해줘", "확인").
- A relevance floor (absolute `minScore` and relative to the top hit), so the common outcome is silence.
- Deduplication: nothing already in the session bundle, nothing recalled earlier in the session, and no decision
  next to the entry that already contains it.
- Delivered as a hidden message with the prompt, capped at `budgets.recall`.

No embeddings, no network, no native dependencies. Lexical recall with English tags as a bridge covers most
"why did we…" moments. An embedding backend can be added behind the same `rank()` interface if needed.

## Decisions as first-class records

`decisions.md` lines carry ids (`[D7k2qf]`, a 5-character content hash, so concurrent branches never mint the same id). An entry can `supersede` older decisions (struck through and dropped from
injection, history kept) and `pin` the few that every session must know. Roll-ups propose pins and supersessions for
the month's decisions, so long-lived rules survive while stale ones fade. When pins outgrow their budget, the agent
is told to fold them into PROJECT.md.

## Roll-up without loss

Summarization is map-reduce. A month is cut into ~9k-token chunks at entry boundaries; each chunk becomes notes;
the notes become the digest. The reply format (`HEADLINE / PIN / SUPERSEDE / DIGEST`) is parsed leniently. An
oversize digest is retried once and only then shortened. A failure leaves the journal untouched. A non-blocking
lock ensures only one process rolls up at a time.

The summarizer is injected. pi uses `ctx.modelRegistry.complete()` in the background (optionally a cheaper
`compactModel`); the CLI uses any shell command (`claude -p --model haiku`, `llm`, …) given as `summarizer`.

## Getting entries written without the user asking

| Signal | Source | Action |
|---|---|---|
| N unrecorded edits | tool events (pi) / PostToolUse (Claude Code) | once per N edits, ask for one entry before the turn ends (pi: `agent_before_settle` + hidden message; Claude Code: `Stop` hook block) |
| conversation compaction imminent | `session_before_compact` | force the next nudge, since detail is about to be lost |
| PROJECT template / STATUS stale | file state | the nudge also asks for those |
| session ended unrecorded | `.local/sessions/*.json` | next session is told and backfills (`backfill: true`) |

Nudges never repeat for the same work, and the agent is told not to mention them.

## Robustness

- **Git.** `.ad/` is meant to be committed. Append-only files merge with git's `union` driver (`.ad/.gitattributes`);
  generated `index.md` and machine-local `.local/` are ignored; duplicate decision lines left by a merge reconcile on
  read (superseded wins, a pin survives, newer wording kept). Tested with a real two-branch merge.
- **Secrets.** Every write (entries, PROJECT/STATUS, digests) is scanned for well-known credential formats and
  `name = value` assignments; matches are rejected without echoing the value.
- **Claude Code performance.** Hooks start a new process per prompt, so recall keeps a per-file index cache in
  `.ad/.local/recall-cache.json`; only files whose mtime/size changed are re-analyzed. With three years of daily use
  (~3,300 entries) a prompt hook takes ~235 ms, ~85 ms above bare Node startup.
- **Cost that doesn't grow with history.** Even if roll-ups never run, a write re-renders only its own day's
  timeline line and a session start opens only the newest `recentDays` day files (6 years of unrolled history:
  15 ms per write, 24 ms per session start). `index.md` is a human convenience view, rebuilt when it falls out of
  step with the journal; agents always read the journal itself.
- **Exit.** Interactive pi never waits on exit: a running roll-up is cancelled (it writes only at the end, so this is
  safe) and runs again next session. Print/RPC runs wait up to 45 s so short scripted sessions can finish one.

- **Concurrency.** Journal files are append-only; read-modify-write paths (decisions, index, curated docs) run under
  a cross-process `mkdir` lock with stale-lock recovery; whole-file writes go through write-then-rename. Tested with
  parallel writer processes.
- **Fail-safe hooks.** Every pi hook is wrapped: a diary failure warns once and never breaks the session. CLI hooks
  swallow all errors and exit 0.
- **Scope.** `.ad/` is auto-created only at a git root (never in `$HOME`), only after real file changes, and can be
  disabled with `AGENT_DIARY_AUTO_INIT=0`. Edits to `.ad/` itself don't count as work.
- **Prompt cache.** The bundle is frozen per session and lives in a named system-prompt section, which pi patches in
  place; it also survives conversation compaction.

## Why extension + skill + library

- **Library (`src/core`)**: format, budgets, recall, roll-ups, in one agent-agnostic place.
- **Extension (`src/pi`)**: anything that must happen *automatically* (inject, count, nudge, roll up). Leaving it
  to the model means it stops the first time the model forgets.
- **Skill (`skills/agent-diary`)**: *how to write well*. Too long to inject always; skills load on demand
  (only name + description are resident). The Agent Skills format also works in Claude Code.
- **CLI (`ad`)**: the same behaviour for agents with hooks + a shell instead of custom tools, and for humans.

## Not done (yet)

- Embedding recall (behind `rank()`), if lexical recall proves insufficient in practice.
- A cross-project library (`~/.agent-diary/library`) mirroring every `.ad/` for a personal, searchable wiki.
- Detecting PROJECT.md drift from structural changes (new top-level dirs, manifest changes).
- An exact tokenizer; the estimate deliberately errs high (1 token per non-ASCII character).
