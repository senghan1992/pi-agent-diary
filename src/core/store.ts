import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { AD_DIR, DEFAULT_CONFIG, type DiaryConfig } from "./config.ts";
import { DECISION_ID_RE, applyDecisionChanges, findDecision, normId, readDecisions, writeDecisions } from "./decisions.ts";
import { withLockSync } from "./lock.ts";
import { findSecrets, secretRejection } from "./secrets.ts";
import { DAY_RE, MONTH_RE, estimateTokens, hm, oneLine, toList, truncateToTokens, ymd } from "./util.ts";

// ───────────────────────────── paths ─────────────────────────────

export interface DiaryPaths {
	dir: string;
	project: string;
	status: string;
	decisions: string;
	index: string;
	config: string;
	journal: string;
	digests: string;
	archive: string;
	/** Machine-local, git-ignored state. */
	local: string;
	sessions: string;
	lock: string;
	compactLock: string;
}

export function diaryPaths(root: string): DiaryPaths {
	const dir = join(root, AD_DIR);
	const local = join(dir, ".local");
	return {
		dir,
		project: join(dir, "PROJECT.md"),
		status: join(dir, "STATUS.md"),
		decisions: join(dir, "decisions.md"),
		index: join(dir, "index.md"),
		config: join(dir, "config.json"),
		journal: join(dir, "journal"),
		digests: join(dir, "digests"),
		archive: join(dir, "archive"),
		local,
		sessions: join(local, "sessions"),
		lock: join(local, "lock"),
		compactLock: join(local, "compact.lock"),
	};
}

export interface RootInfo {
	/** Directory that owns (or would own) `.ad/`. */
	root: string;
	/** `.ad/` already exists there. */
	exists: boolean;
	/** `root` is a git work tree root — the default condition for auto-creating `.ad/`. */
	inGit: boolean;
}

/**
 * Where the diary for `cwd` lives: the nearest ancestor with `.ad/`, else the nearest git root,
 * else `cwd`. A diary is never auto-created outside a git repo or in the home directory.
 */
export function resolveRoot(cwd: string): RootInfo {
	let gitRoot: string | undefined;
	let dir = cwd;
	while (true) {
		if (existsSync(join(dir, AD_DIR, "PROJECT.md"))) return { root: dir, exists: true, inGit: existsSync(join(dir, ".git")) };
		if (!gitRoot && existsSync(join(dir, ".git"))) gitRoot = dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const root = gitRoot ?? cwd;
	return { root, exists: false, inGit: !!gitRoot && root !== homedir() };
}

export function read(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

export function writeFile(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	// write-then-rename so readers in other processes never see a half-written file
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, file);
}

export function locked<T>(root: string, fn: () => T): T {
	return withLockSync(diaryPaths(root).lock, fn);
}

// ─────────────────────────── templates ───────────────────────────

const TEMPLATE_MARK = "(not written yet";

const PROJECT_TEMPLATE = (name: string) => `# ${name}

<!-- agent-diary · PROJECT.md is loaded at the start of every session, within a token budget.
     Stable facts only: what this is and why, architecture, how to run/test, conventions.
     Rewrite it when it drifts; never append history (that is what journal/ is for). -->

## What & why
${TEMPLATE_MARK} — the agent fills this in after exploring the project)

## Architecture
-

## How to run / test
-

## Conventions
-
`;

const STATUS_TEMPLATE = `# Status

<!-- agent-diary · STATUS.md is loaded every session. Overwrite it to describe *now*; history lives in journal/. -->

## Now
-

## Next
-

## Open questions
-
`;

/**
 * Sharing `.ad/` through git: machine-local state and the generated timeline are not committed
 * (index.md is rebuilt on every write, so committing it would conflict on every merge); append-only
 * files use git's built-in `union` merge, so two branches adding entries the same day merge cleanly.
 */
export const GITIGNORE = `# agent-diary: machine-local state and generated files\n.local/\nindex.md\n*.tmp\n`;
export const GITATTRIBUTES = `# agent-diary: append-only files merge by keeping both sides' lines\ndecisions.md merge=union\njournal/**/*.md merge=union\n`;

export function isInitialized(root: string): boolean {
	return existsSync(diaryPaths(root).project);
}

/** Create `.ad/` with templates. Idempotent; returns true if it created the diary. */
export function ensureDiary(root: string, projectName = basename(root)): boolean {
	const p = diaryPaths(root);
	if (existsSync(p.project)) {
		ensureLayout(root);
		return false;
	}
	for (const d of [p.dir, p.journal, p.digests, p.archive, p.sessions]) mkdirSync(d, { recursive: true });
	if (!existsSync(p.status)) writeFile(p.status, STATUS_TEMPLATE);
	if (!existsSync(p.decisions)) writeDecisions(p.decisions, []);
	if (!existsSync(p.config)) writeFile(p.config, `${JSON.stringify(DEFAULT_CONFIG, null, "\t")}\n`);
	ensureLayout(root);
	writeFile(p.project, PROJECT_TEMPLATE(projectName));
	rebuildIndex(root);
	return true;
}

/** Keep .gitignore / .gitattributes current (also migrates diaries created by older versions). */
export function ensureLayout(root: string): void {
	const p = diaryPaths(root);
	for (const [name, content] of [
		[".gitignore", GITIGNORE],
		[".gitattributes", GITATTRIBUTES],
	] as const) {
		const f = join(p.dir, name);
		if (read(f) !== content) writeFile(f, content);
	}
}

/** True while PROJECT.md is still the untouched template. */
export function projectIsTemplate(root: string): boolean {
	return read(diaryPaths(root).project).includes(TEMPLATE_MARK);
}

// ──────────────────────────── journal ────────────────────────────

export interface DiaryEntry {
	/** Specific one-line headline. Becomes the timeline line, so make it searchable. */
	title: string;
	/** Why: the user's goal or the problem being solved. */
	intent?: string;
	/** Outcomes (not steps). */
	done?: string[] | string;
	/** Choices + reasons. Each gets an id (D<n>) in decisions.md. Prefix with ★ to pin. */
	decisions?: string[] | string;
	/** Gotchas, dead ends, known problems. */
	issues?: string[] | string;
	/** Concrete follow-ups. */
	next?: string[] | string;
	/** Key files touched. */
	files?: string[] | string;
	/** Short topic tags. English lowercase recommended — they bridge languages in recall. */
	tags?: string[] | string;
	/** Decision ids (e.g. "D3") this entry makes obsolete. */
	supersedes?: string[] | string;
	/** Existing decision ids to pin (always injected). */
	pin?: string[] | string;
}

/** One `## HH:MM · title` section of a journal day. */
export interface JournalEntry {
	day: string;
	time: string;
	title: string;
	body: string;
	tags: string[];
	archived: boolean;
}

export function dayPath(root: string, day: string): string {
	return join(diaryPaths(root).journal, day.slice(0, 7), `${day}.md`);
}

function bullets(label: string, items: string[]): string {
	if (items.length === 0) return "";
	if (items.length === 1) return `- **${label}**: ${items[0]}\n`;
	return `- **${label}**:\n${items.map((i) => `  - ${i}`).join("\n")}\n`;
}

export function normalizeTag(t: string): string {
	return t
		.trim()
		.replace(/^#/, "")
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}_/-]/gu, "");
}

/** Render an entry. `decisionLines` are the already-numbered decisions ("[D12] …"). */
export function formatEntry(entry: DiaryEntry, now: Date, decisionLines: string[]): string {
	const files = toList(entry.files).map((f) => (f.startsWith("`") ? f : `\`${f}\``));
	const tags = [...new Set(toList(entry.tags).map(normalizeTag).filter(Boolean))];
	let out = `\n## ${hm(now)} · ${oneLine(entry.title, 100)}\n`;
	if (entry.intent?.trim()) out += `- **Intent**: ${oneLine(entry.intent, 600)}\n`;
	out += bullets("Done", toList(entry.done));
	out += bullets("Decisions", decisionLines);
	out += bullets("Issues", toList(entry.issues));
	out += bullets("Next", toList(entry.next));
	if (files.length) out += `- **Files**: ${files.join(", ")}\n`;
	if (tags.length) out += `- **Tags**: ${tags.map((t) => `#${t}`).join(" ")}\n`;
	return out;
}

const ENTRY_HEAD = /^## (\d{2}:\d{2}) · (.+)$/;

export function parseDay(content: string, day: string, archived = false): JournalEntry[] {
	const legacyTags = (content.match(/^tags:\s*\[(.*)\]\s*$/m)?.[1] ?? "")
		.split(",")
		.map((t) => normalizeTag(t))
		.filter(Boolean);
	const out: JournalEntry[] = [];
	let cur: JournalEntry | undefined;
	for (const line of content.split("\n")) {
		const m = line.match(ENTRY_HEAD);
		if (m) {
			cur = { day, time: m[1], title: m[2].trim(), body: "", tags: [], archived };
			out.push(cur);
		} else if (cur) cur.body += `${line}\n`;
	}
	for (const e of out) {
		const tagLine = e.body.match(/^- \*\*Tags\*\*: (.+)$/m)?.[1] ?? "";
		const tags = [...tagLine.matchAll(/#([^\s#]+)/g)].map((x) => x[1]);
		e.tags = tags.length ? tags : legacyTags;
		e.body = e.body.trim();
	}
	return out;
}

export interface WriteResult {
	ok: boolean;
	message: string;
	tokens: number;
	budget: number;
}

export interface AppendResult extends WriteResult {
	path?: string;
	day?: string;
	decisionIds: string[];
}

/**
 * Append an entry to today's journal. Rejects entries over `budgets.entry` so the agent condenses
 * them; journal files are append-only, so concurrent writers never clobber each other.
 */
export function appendEntry(root: string, cfg: DiaryConfig, entry: DiaryEntry, now: Date = new Date()): AppendResult {
	const budget = cfg.budgets.entry;
	if (!entry.title?.trim()) return { ok: false, message: "Entry needs a title.", tokens: 0, budget, decisionIds: [] };

	const preview = formatEntry(entry, now, toList(entry.decisions).map((d, i) => `[D${900 + i}] ${d}`));
	const tokens = estimateTokens(preview);
	const leaks = findSecrets(`${preview}\n${toList(entry.supersedes).join(" ")}`);
	if (leaks.length) return { ok: false, tokens, budget, decisionIds: [], message: `${secretRejection("Entry", leaks)} Nothing was written.` };
	if (tokens > budget) {
		return {
			ok: false,
			tokens,
			budget,
			decisionIds: [],
			message:
				`Entry rejected: ~${tokens} tokens exceeds the per-entry budget ${budget}. Condense: outcomes not steps, ` +
				`≤5 bullets per field, no code or logs (reference files instead). Nothing was written; retry.`,
		};
	}

	ensureDiary(root);
	return locked(root, () => {
		const p = diaryPaths(root);
		const day = ymd(now);
		const decisions = readDecisions(p.decisions);
		const { decisions: next, added, notes, changed } = applyDecisionChanges(decisions, {
			day,
			add: toList(entry.decisions),
			supersede: toList(entry.supersedes),
			pin: toList(entry.pin),
		});
		const decisionLines = added.map((d) => `[${d.id}] ${d.pinned ? "★ " : ""}${d.text}`);

		const file = dayPath(root, day);
		if (!existsSync(file)) {
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, `---\ndate: ${day}\n---\n# ${day}\n`, "utf8");
		}
		appendFileSync(file, formatEntry(entry, now, decisionLines), "utf8");
		if (changed) writeDecisions(p.decisions, next);
		updateIndexDayUnlocked(root, day);

		const ids = added.map((d) => d.id);
		const msg = [`Logged to ${relative(root, file)}${ids.length ? ` (decisions ${ids.join(", ")})` : ""}.`, ...notes];
		return { ok: true, message: msg.join("\n"), tokens, budget, path: file, day, decisionIds: ids };
	});
}

// ───────────────────────── PROJECT / STATUS ─────────────────────────

export type CuratedDoc = "project" | "status";

export function writeCuratedDoc(root: string, cfg: DiaryConfig, doc: CuratedDoc, content: string): WriteResult {
	const budget = cfg.budgets[doc];
	const tokens = estimateTokens(content);
	const name = doc === "project" ? "PROJECT.md" : "STATUS.md";
	const leaks = findSecrets(content);
	if (leaks.length) return { ok: false, tokens, budget, message: secretRejection(name, leaks) };
	if (!content.trim()) return { ok: false, tokens, budget, message: `${name} rejected: empty content.` };
	if (tokens > budget) {
		return {
			ok: false,
			tokens,
			budget,
			message:
				`${name} rejected: ~${tokens} tokens exceeds budget ${budget}. Rewrite it shorter — drop what the code or git ` +
				`already shows, merge bullets, delete stale items, move history to the journal — and retry.`,
		};
	}
	ensureDiary(root);
	locked(root, () => writeFile(diaryPaths(root)[doc], `${content.replace(/\s*$/, "")}\n`));
	return { ok: true, tokens, budget, message: `${name} updated (~${tokens}/${budget} tokens).` };
}

export function readCuratedDoc(root: string, doc: CuratedDoc): string {
	return read(diaryPaths(root)[doc]);
}

/** Days since a curated doc was last written, or undefined if missing. */
export function docAgeDays(root: string, doc: CuratedDoc, now: Date = new Date()): number | undefined {
	try {
		return Math.floor((now.getTime() - statSync(diaryPaths(root)[doc]).mtimeMs) / 86_400_000);
	} catch {
		return undefined;
	}
}

// ───────────────────────────── listing ─────────────────────────────

export interface DayRef {
	day: string;
	path: string;
	archived: boolean;
}

export function listMonthDirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((m) => MONTH_RE.test(m) && statSync(join(dir, m)).isDirectory())
		.sort();
}

export function listDayFiles(monthDir: string): string[] {
	if (!existsSync(monthDir)) return [];
	return readdirSync(monthDir)
		.filter((f) => f.endsWith(".md") && DAY_RE.test(f.slice(0, -3)))
		.sort();
}

/** Journal days, oldest first. Includes archived (rolled-up) days when `includeArchive`. */
export function listDays(root: string, includeArchive = false): DayRef[] {
	const p = diaryPaths(root);
	const out: DayRef[] = [];
	const scan = (base: string, archived: boolean) => {
		for (const m of listMonthDirs(base)) {
			for (const f of listDayFiles(join(base, m))) out.push({ day: f.slice(0, -3), path: join(base, m, f), archived });
		}
	};
	if (includeArchive) scan(p.archive, true);
	scan(p.journal, false);
	return out.sort((a, b) => a.day.localeCompare(b.day));
}

export function listDigests(root: string): string[] {
	const dir = diaryPaths(root).digests;
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md") && MONTH_RE.test(f.slice(0, -3)))
		.map((f) => f.slice(0, -3))
		.sort();
}

export function readDigest(root: string, month: string): string {
	return read(join(diaryPaths(root).digests, `${month}.md`));
}

export function digestHeadline(content: string): string {
	return content.match(/^headline:\s*(.+)$/m)?.[1]?.trim() ?? "(digest)";
}

// ───────────────────────────── index ─────────────────────────────

/** Join entry titles up to `max` chars on whole titles, then "(+N more)". */
function joinTitles(titles: string[], max: number): string {
	if (!titles.length) return "(no entries)";
	const out: string[] = [];
	let len = 0;
	for (const t of titles) {
		const s = oneLine(t, 100);
		if (out.length && len + s.length + 3 > max) break;
		out.push(s);
		len += s.length + 3;
	}
	const more = titles.length - out.length;
	return `${out.join(" / ")}${more ? ` (+${more} more)` : ""}`;
}

function dayLine(d: DayRef): string {
	const entries = parseDay(read(d.path), d.day);
	const tags = [...new Set(entries.flatMap((e) => e.tags))];
	const tagStr = tags.length ? `  ${tags.map((t) => `#${t}`).join(" ")}` : "";
	return `- [[${d.day}]] ${joinTitles(entries.map((e) => e.title), 180)}${tagStr}`;
}

function digestLine(root: string, month: string): string {
	return `- [[${month}]] 📦 ${oneLine(digestHeadline(readDigest(root, month)), 160)}`;
}

/** Sort key: a digest month sorts just below its own days ("2026-09-00"). */
const lineKey = (line: string) => {
	const ref = line.match(/^- \[\[([\d-]+)\]\]/)?.[1] ?? "";
	return ref.length === 7 ? `${ref}-00` : ref;
};

/**
 * Timeline lines (one per hot journal day and per digest month), newest first. With `limit`, only the
 * newest `limit` day files and digests are opened, so the cost does not grow with history. File names
 * sort by date, so the newest days are known from directory listings alone.
 */
export function buildIndexLines(root: string, limit?: number): string[] {
	let days = listDays(root, false);
	let months = listDigests(root);
	if (limit !== undefined) {
		days = days.slice(-limit);
		months = months.slice(-limit);
	}
	const lines = [...days.map(dayLine), ...months.map((m) => digestLine(root, m))];
	lines.sort((a, b) => lineKey(b).localeCompare(lineKey(a)));
	return limit === undefined ? lines : lines.slice(0, limit);
}

const INDEX_HEADER =
	"# Timeline\n\n<!-- agent-diary · generated, do not edit. Newest first. 📦 = monthly digest (originals in archive/). -->\n\n";

function writeIndex(root: string, lines: string[]): void {
	writeFile(diaryPaths(root).index, `${INDEX_HEADER}${lines.join("\n")}\n`);
}

function rebuildIndexUnlocked(root: string): void {
	writeIndex(root, buildIndexLines(root));
}

export function rebuildIndex(root: string): void {
	locked(root, () => rebuildIndexUnlocked(root));
}

/** index.md lines if they cover exactly the days/digests on disk (plus `extraDay`), else undefined. */
function indexState(root: string, extraDay?: string): { lines: string[]; days: DayRef[] } | undefined {
	const current = read(diaryPaths(root).index);
	if (!current.startsWith(INDEX_HEADER)) return undefined;
	const lines = current.slice(INDEX_HEADER.length).split("\n").filter((l) => l.startsWith("- [["));
	const days = listDays(root, false);
	const expected = new Set([...days.map((d) => d.day), ...listDigests(root)]);
	const present = new Set(lines.map((l) => l.match(/^- \[\[([\d-]+)\]\]/)?.[1] ?? ""));
	if (extraDay) present.add(extraDay);
	if (present.size !== expected.size || ![...present].every((k) => expected.has(k))) return undefined;
	return { lines, days };
}

/** Rebuild index.md only if it is out of step with the journal (e.g. after a git pull). Cheap: listings only. */
export function refreshIndexIfStale(root: string): boolean {
	if (!isInitialized(root) || indexState(root)) return false;
	rebuildIndex(root);
	return true;
}

/**
 * Update index.md for one changed day: re-render that day's line only. Falls back to a full rebuild when
 * index.md is missing or out of step with the files on disk (different set of days/digests, e.g. after a
 * git pull, a hand edit or a deleted file). index.md is a convenience view for humans: agents read the
 * timeline from the journal itself, so it is never a source of truth. Caller holds the lock.
 */
export function updateIndexDayUnlocked(root: string, day: string): void {
	const state = indexState(root, day);
	if (!state) return rebuildIndexUnlocked(root);
	const { lines, days } = state;
	const ref = days.find((d) => d.day === day);
	if (!ref) return rebuildIndexUnlocked(root);
	const next = lines.filter((l) => lineKey(l) !== day);
	next.push(dayLine(ref));
	next.sort((a, b) => lineKey(b).localeCompare(lineKey(a)));
	writeIndex(root, next);
}

export { rebuildIndexUnlocked };

// ───────────────────────────── read ─────────────────────────────

/** Read a target: index | project | status | decisions | D<n> | YYYY-MM-DD | YYYY-MM. */
export function readTarget(root: string, target: string, maxTokens = 6000): string {
	const p = diaryPaths(root);
	const t = target.trim();
	let out: string;
	if (t === "index") out = `# Timeline\n\n${buildIndexLines(root).join("\n")}\n`;
	else if (t === "project") out = read(p.project);
	else if (t === "status") out = read(p.status);
	else if (t === "decisions") out = read(p.decisions);
	else if (/^\[?D/i.test(t) && DECISION_ID_RE.test(normId(t))) {
		const d = findDecision(readDecisions(p.decisions), t);
		const id = d?.id ?? normId(t);
		if (!d) out = `No decision ${id}.`;
		else {
			const entry = listDays(root, true)
				.filter((x) => x.day === d.day)
				.flatMap((x) => parseDay(read(x.path), x.day, x.archived))
				.find((e) => e.body.includes(`[${id}]`));
			out = `${d.raw}\n\n${entry ? `From ${d.day} ${entry.time} · ${entry.title}\n${entry.body}` : "(source entry not found)"}`;
		}
	} else if (DAY_RE.test(t)) {
		out = read(dayPath(root, t)) || read(join(p.archive, t.slice(0, 7), `${t}.md`)) || `No journal entry for ${t}.`;
	} else if (MONTH_RE.test(t)) {
		const digest = readDigest(root, t);
		const days = listDays(root, true).filter((d) => d.day.startsWith(t));
		out = digest
			? `${digest}\n(original days, readable individually: ${days.map((d) => d.day).join(", ") || "none"})`
			: days.map((d) => read(d.path)).join("\n\n") || `Nothing recorded for ${t}.`;
	} else {
		out = `Unknown target "${t}". Use index | project | status | decisions | D<n> | YYYY-MM-DD | YYYY-MM.`;
	}
	return truncateToTokens(out, maxTokens, `…(truncated at ~${maxTokens} tokens — read a narrower target or use diary_search)`);
}

// ──────────────────────────── grep ────────────────────────────

export interface GrepHit {
	file: string;
	line: number;
	text: string;
}

/** Plain regex search over every diary file, newest journal days first. */
export function grep(root: string, query: string, limit = 30): GrepHit[] {
	const p = diaryPaths(root);
	let re: RegExp;
	try {
		re = new RegExp(query, "i");
	} catch {
		re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	}
	const files = [
		p.project,
		p.status,
		p.decisions,
		...listDigests(root)
			.reverse()
			.map((m) => join(p.digests, `${m}.md`)),
		...listDays(root, true)
			.reverse()
			.map((d) => d.path),
	];
	const hits: GrepHit[] = [];
	for (const f of files) {
		const lines = read(f).split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (re.test(lines[i])) {
				hits.push({ file: relative(root, f), line: i + 1, text: oneLine(lines[i], 200) });
				if (hits.length >= limit) return hits;
			}
		}
	}
	return hits;
}
