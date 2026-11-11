# Changelog

## [0.3.0] - 2026-11-11

### Changed
- **Decision ids are short content hashes** (`D7k2qf`) instead of counters, so branches and teammates can never mint
  the same id. Existing numeric ids (`D12`) and pre-id lines keep working.
- `.ad/index.md` is generated and now git-ignored; `ad read index` / recall compute the timeline live.
- Interactive pi no longer waits on exit for a background roll-up (cancelled safely, retried next session).
  Print/RPC mode keeps a 45 s grace period (`AGENT_DIARY_SHUTDOWN_GRACE_MS`).
- `bin/ad.js` runs `src/` in a source checkout, so a stale `dist/` can't shadow edits.

### Added
- `.ad/.gitattributes` with `merge=union` for journal days and `decisions.md`; duplicate decision versions left
  by a merge reconcile on read. Existing diaries are migrated on the next write.
- Claude Code: roll-ups run by default with `claude -p --model haiku` when `claude` is on PATH.
- Persistent per-file recall cache (`.ad/.local/recall-cache.json`) for per-prompt hook processes.
- Secret detection: writes containing credentials are rejected without echoing them; skill rule added.
- `ad doctor` warns when `index.md` is committed. `AGENT_DIARY_DEBUG=1` traces the pi extension.

### Performance
- Writes update only the changed day's line in `index.md` (full rebuild only when the index is out of step with
  the journal, e.g. after a `git pull`; checked at session start).
- The session bundle opens only the newest `recentDays` day files; roll-up candidates are sized from file sizes.
  With 6 years of never-rolled-up history: one write 123 → 15 ms, session start 222 → 24 ms.

## [0.2.0] - 2026-11-11

### Added
- **Per-prompt recall**: older entries, decisions and digests relevant to each user prompt are injected (BM25,
  Hangul/CJK bigrams, bounded by `budgets.recall`, deduplicated per session).
- **Decision ids** (`[D#]`), `supersedes` and `pin` (★). Pinned decisions are always loaded; superseded ones drop out.
- **Automatic roll-ups**: cold months are map-reduced into digests in the background (pi: session model or
  `compactModel`; CLI: `summarizer` command). Proposed pins/supersessions are applied.
- **Per-entry budget** (`budgets.entry`).
- Nudges also ask for PROJECT.md when it is a template and STATUS.md when it is stale; compaction forces a nudge.
- Claude Code: `ad hook session-start`, prompt recall, detection of `ad write` to clear nudges, background roll-up.
- `ad doctor`, `ad search` (ranked; `--regex` for patterns), `ad read D#`, `ad compact run`, `ad write --backfill`.
- Test suite: core, recall, roll-up, a pi extension harness, CLI/hook integration, parallel writers.
- English README (Korean in `README.ko.md`), design doc, CI.

### Changed
- `.ad/.pending/` → `.ad/.local/sessions/` (machine-local, git-ignored, expires after `pendingTtlDays`).
- `.ad/` is auto-created only inside a git repository, after real file changes.
- `diary_compact` tool removed in favour of automatic roll-ups and `/diary compact`.
- Token estimate counts 1 token per non-ASCII character (safer for Korean).
- Published package ships compiled `dist/` for the CLI and library.

### Fixed
- Concurrent writes from several sessions no longer race (append-only journal, cross-process lock, atomic writes).
- `ad write` no longer clears other sessions' unrecorded state.

## [0.1.0] - 2026-11-06

- Initial version: `.ad/` layout, budgets, monthly digests, pi extension, skill, `ad` CLI.
