# agent-diary

**Your coding agent keeps a diary of the project, so the next session already knows it.**

[한국어](README.ko.md)

You work through prompts in [pi](https://pi.dev) or Claude Code. You don't write docs, and you shouldn't have to.
agent-diary makes the agent record what it did and *why* in a `.ad/` folder inside your repo. Every new
session then starts with a compact picture of the project: what it is, where it stands, what was decided, and what
happened recently. Older memories resurface when they matter.

```
new session  ──▶  PROJECT · STATUS · pinned + recent decisions · last 7 days      (≤ 3,000 tokens, always)
your prompt  ──▶  + older diary entries relevant to this prompt, if any           (≤ 450 tokens, usually 0)
agent works  ──▶  edits are counted (no LLM cost); after real work the agent writes one short entry
month ends   ──▶  cold months roll up into digests in the background; originals stay searchable
```

No setup per project, no commands to remember, no docs to curate. Install it once and keep coding.

## Install

### pi

```bash
pi install npm:pi-agent-diary
```

That's it. In any git repository where the agent changes files, `.ad/` appears and starts filling up.

### Claude Code

```bash
npm install -g pi-agent-diary          # provides the `ad` command
```

Then merge [`integrations/claude-code/settings.json`](integrations/claude-code/settings.json) into
`~/.claude/settings.json`. To also give Claude the writing guidelines, link the skill:

```bash
mkdir -p ~/.claude/skills && ln -s "$(npm root -g)/pi-agent-diary/skills/agent-diary" ~/.claude/skills/agent-diary
```

Old months are rolled up with `claude -p --model haiku` when `claude` is on your PATH (set `"summarizer"` in
`.ad/config.json` to use something else, or `AGENT_DIARY_SUMMARIZER=none` to disable).

pi and Claude Code share the same `.ad/`, so you can switch between them freely.

## What it does for you

| Moment | What happens | Cost |
|---|---|---|
| Session starts | The diary bundle is put in the system prompt: PROJECT.md, STATUS.md, pinned and recent decisions, a 7-day timeline, and notes such as "a previous session didn't record its work" | ≤ `budgets.context` (3,000) tokens, fixed for the session, so the prompt cache stays warm and it survives conversation compaction |
| You send a prompt | Older entries, decisions and digests related to the prompt are recalled. Korean, Japanese and Chinese work out of the box (character bigrams), as do English and mixed text | ≤ 450 tokens, and nothing at all when nothing is relevant. Each memory is recalled at most once per session |
| The agent edits files | Edits are counted from tool events; no model calls | 0 |
| Enough unrecorded work (6 edits), or the conversation is about to be compacted | The agent is asked, invisibly and once, to write a short entry, plus PROJECT/STATUS if they're missing or stale | one short turn |
| A session ends without an entry | Its prompts and changed files stay in `.ad/.local/` and the next session is asked to backfill | 0 |
| A month goes cold (30 days) | It is rolled up into a ≤ 1,000-token digest in the background. Long months are map-reduced, never truncated. Still-relevant decisions get pinned and obsolete ones struck | a few background model calls per month |

### "Won't the diary eat my context as it grows?"

No. This is the core design constraint, and it's enforced, not hoped for:

- **Hard budgets.** PROJECT ≤ 1,200, STATUS ≤ 600, entry ≤ 450, digest ≤ 1,000, pinned decisions ≤ 350 tokens.
  An oversize write is **rejected**, so the agent has to condense instead of append.
- **Windows.** Only the last 7 days and the 8 newest active decisions are injected. Superseded decisions drop out.
- **A total cap.** If the bundle still exceeds 3,000 tokens, low-priority sections are trimmed first.
- **Pull, not push, for the past.** Everything older is reached through relevance-ranked recall and search.
- **Roll-ups** keep the timeline at one line per month for anything older than 30 days.

The test suite builds a year of daily entries and asserts the session bundle stays within budget.

## The `.ad/` folder

```
.ad/
├── PROJECT.md          what & why, architecture, how to run/test, conventions   (curated, always loaded)
├── STATUS.md           Now / Next / Open questions                               (overwritten, always loaded)
├── decisions.md        [D7k2qf] one line per decision · ★ pinned · ~~superseded~~
├── index.md            generated timeline, one line per day / digest month
├── journal/2026-11/2026-11-06.md
├── digests/2026-09.md
├── archive/2026-09/…   rolled-up originals (still readable and searchable)
├── config.json
└── .local/             machine-local session state (git-ignored)
```

**Commit it.** Teammates, other machines and other agents then share the same memory. It's plain Markdown
with `[[wikilinks]]`, so you can open `.ad/` as an Obsidian vault and browse your project's history like a wiki.

It is built to live in git with several people and branches writing at once:

- `.ad/.gitattributes` merges the append-only files (journal days, `decisions.md`) with git's `union` driver,
  so two branches recording work on the same day merge without conflicts.
- Decision ids are short content hashes, so two branches can never create the same id. If a merge leaves two
  versions of one decision, they are reconciled when read: superseded wins and a pin survives.
- The generated `index.md` and the machine-local `.local/` are git-ignored. `ad doctor` tells you if an older
  setup committed `index.md`.
- Writes that look like they contain credentials (API keys, tokens, private keys, URLs with passwords) are
  rejected, and the value is never echoed back.

A journal entry looks like this:

```markdown
## 14:32 · Fix token refresh race in auth middleware
- **Intent**: Users were logged out when two requests refreshed the token at once.
- **Done**: Refresh is serialized per user; added a regression test for parallel refresh.
- **Decisions**: [Dq3m8a] Per-user mutex around refresh — simplest correct fix (rejected: request queue, too invasive)
- **Issues**: The old test mocked the clock globally, which hid the race.
- **Files**: `src/auth/refresh.ts`, `test/auth/refresh.test.ts`
- **Tags**: #auth
```

## Using it

You don't need to do anything. When you want control:

**pi:** `/diary` (status) · `/diary init` · `/diary write [note]` · `/diary compact` · `/diary recall` (what was recalled) · `/diary show` · `/diary reload`

**Agent tools (pi):** `diary_write`, `diary_update`, `diary_read`, `diary_search`

**CLI:**

```bash
ad stats                      # what a session costs, what's due
ad doctor                     # health check
ad search why vite            # relevance search across all history (any language)
ad read 2026-10-12            # a day · 2026-10 a month · Dq3m8a a decision with its source entry
ad write --json '{"title":"…","intent":"…","done":["…"],"decisions":["choice — reason"]}'
ad update project -  < PROJECT.md
ad compact run --summarizer "claude -p --model haiku"
```

## Configuration

`.ad/config.json` (created with defaults):

```jsonc
{
  "budgets": { "project": 1200, "status": 600, "entry": 450, "digest": 1000,
               "pinned": 350, "recall": 450, "context": 3000 },
  "recentDays": 7,              // days of timeline in every session
  "recentDecisions": 8,         // newest active decisions in every session
  "recall": { "enabled": true, "maxItems": 4, "minScore": 4 },  // raise minScore if recall is noisy
  "hotDays": 30,                // months older than this are rolled up
  "autoWrite": "auto",          // auto | remind (footer only) | off
  "nudgeAfterMutations": 6,     // unrecorded edits before the agent is asked to write
  "autoCompact": "auto",        // auto | remind | off
  "compactModel": "provider/model-id",  // pi: cheaper model for roll-ups (default: session model)
  "summarizer": "claude -p --model haiku",       // CLI / Claude Code: command used for roll-ups
  "pendingTtlDays": 14
}
```

`AGENT_DIARY_AUTO_INIT=0` disables automatic creation of `.ad/`. You can still use `/diary init` or `ad init`.
Outside a git repository, `.ad/` is never created automatically.

## Design

Why an extension + skill + library, and how each part keeps the context bounded: see [docs/DESIGN.md](docs/DESIGN.md).

## Development

```bash
npm install
npm run check        # typecheck + tests (node:test, no build needed)
npm run build        # dist/ for the npm package
pi -e ./src/pi/extension.ts   # try the extension without installing
```

Requires Node ≥ 22.18. The source runs directly with Node's type stripping, and pi loads it through jiti.

## License

MIT
