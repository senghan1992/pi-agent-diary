---
name: agent-diary
description: Write and maintain this project's agent diary (.ad/) — the memory that lets future coding sessions know what the project is, how it evolved and why. Use when recording finished work, writing PROJECT.md/STATUS.md, superseding or pinning decisions, backfilling a missed session, rolling up old months, or answering "why/when did we…" from past sessions.
---

# Agent diary

`.ad/` is the project's memory across sessions. The next agent knows nothing except what you leave here.
Write for **that reader**: a capable engineer who has the code and git, but not your conversation.

Tools differ by agent; the format is the same:

| Action | pi | other agents (shell) |
|---|---|---|
| record work | `diary_write` | `ad write --json '{…}'` |
| rewrite PROJECT / STATUS | `diary_update` | `ad update project\|status -` (markdown on stdin) |
| read a day / month / decision | `diary_read 2026-03-14` · `2026-03` · `D7k2qf` | `ad read …` |
| search all history | `diary_search` | `ad search <words>` |

## What lives where

| File | Loaded | Holds | Rule |
|---|---|---|---|
| `PROJECT.md` | every session | what & why, architecture, how to run/test, conventions | stable facts; **rewrite** when it drifts, never append |
| `STATUS.md` | every session | Now / Next / Open questions | overwrite to describe *today*; no history |
| `decisions.md` | pinned + newest | `[D#]` one line per decision | written by diary_write; ★ pinned, ~~struck~~ superseded |
| `journal/YYYY-MM/YYYY-MM-DD.md` | recalled when relevant | entries | append-only, via diary_write |
| `digests/YYYY-MM.md` | recalled when relevant | monthly roll-ups | generated automatically |

Everything has a size budget (`.ad/config.json`). A rejected write means *condense*, not split: drop what the
code or git already shows, merge bullets, delete stale lines. The pressure is what keeps sessions cheap.

## When to write

- After a coherent unit of work (feature, fix, investigation, refactor): **one entry per unit**, not per tool call.
- When a decision is made, even without code (picked a library, rejected an approach, learned a constraint).
- When reminded by `[agent-diary]`: write once, then end the turn. Don't mention the reminder.
- Not for trivial edits, pure Q&A, or anything a future session wouldn't need.

## A good entry (5–15 lines)

- **title**: specific and searchable. "Add retry with jitter to S3 uploader", not "Updates".
- **intent**: the user's goal or the problem, in 1–2 sentences. The most valuable field.
- **done**: 1–5 outcomes, not steps. "Uploads retry 5× with full jitter" beats "edited uploader.ts".
- **decisions**: `choice — reason (rejected: alternative)`. Each gets a short id like `D7k2qf`.
  - Prefix `★` only for rules every future session must follow (e.g. "★ all timestamps are UTC").
  - Pass `supersedes: ["D7k2qf"]` when this work replaces an earlier decision. Read `decisions` if unsure.
- **issues**: gotchas, dead ends, flaky things, anything that cost time.
- **next**: concrete follow-ups.
- **files**: key files only (≤ 6). **tags**: 1–3 short English lowercase words (`auth`, `build`), even when
  the entry is in another language: tags bridge languages in recall.
- **status**: a complete new STATUS.md whenever Now/Next changed.

Write in the language the user works in. No code dumps or logs; reference files.

**Never write secrets.** `.ad/` is committed to git. No tokens, keys, passwords, connection strings with
credentials, or customer data — say where they live instead ("in `.env` as `STRIPE_KEY`"). Writes that look
like they contain one are rejected.

## First time in a project

If PROJECT.md is the template, skim README, manifests, entry points and tests, then write it:

```markdown
# <name>
## What & why
<2–4 sentences: purpose, users, maturity>
## Architecture
- <dir/module> — <responsibility>
## How to run / test
- `<cmd>`
## Conventions
- <style, patterns, things to avoid>
```

## Keeping it healthy

- **PROJECT drift**: after a structural change (new module, changed build, new convention) rewrite PROJECT.md.
- **Too many pins**: if you're told pins don't fit, fold them into PROJECT.md's Conventions and unpin.
- **Missed sessions**: if the context lists sessions without entries, check `git log`/`git diff` for them and
  write **one** entry with `backfill: true` (shell: `ad write --backfill …`).
- **Roll-ups** of old months run automatically (pi uses the session model; Claude Code uses
  `summarizer` in config). Manual: `/diary compact`, or `ad compact plan` → write the reply → `ad compact commit`.

## Using the past

Memories relevant to the user's prompt are recalled automatically and briefly. When you need more, read the
specific day, month or `D#` they point to rather than the whole index. Treat the diary as a strong hint and
verify against the code before relying on it for something risky.
