import { existsSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { DiaryConfig } from "./config.ts";
import { parseDecisions } from "./decisions.ts";
import { diaryPaths, digestHeadline, isInitialized, listDays, listDigests, parseDay, read, writeFile } from "./store.ts";
import { daysSince, estimateTokens, oneLine } from "./util.ts";

/**
 * Lexical retrieval over the whole diary (hot journal, archive, digests, decisions), used to
 * surface *older* memories relevant to what the user just asked — the part of history that the
 * fixed-size session bundle cannot show. No embeddings, no network, no dependencies.
 *
 * - Latin text: lowercase words, camelCase/snake_case split, light plural stemming, stopwords.
 * - Hangul/CJK: character bigrams, so particles and endings don't block matches
 *   ("인증을", "인증이" both contain "인증").
 * - Ranking: BM25 (k1=1.2, b=0.75) with title/tag terms boosted and a mild recency bonus.
 */

const STOP = new Set(
	`a an and are as at be been but by can could did do does done for from had has have how i if in into is it its
	let me my no not of on or our please should so than that the their them then there these they this to too up us
	was we were what when where which who why will with would you your just also make made use used using get got
	add added fix fixed now new want need like into via about after before again all any each more most some such`
		.split(/\s+/)
		.filter(Boolean),
);

/** Hangul bigrams from request phrasing and verb endings ("…해줘", "확인해", "…습니다") — noise for recall. */
const STOP_KO = new Set(
	`해줘 해주 주세 세요 줘요 해요 려요 어요 아요 습니 니다 합니 하고 하는 해서 하면 했어 했다 됐어 되는 된다 있어 있는 없어 이거 그거 저거
	지금 그냥 좀더 확인 인해 봐줘 봐주 고쳐 쳐줘 만들 들어 어줘 알려 려줘 주라 할래 할까 싶어 같아 ㅎㅎ`
		.split(/\s+/)
		.filter(Boolean),
);

function stem(w: string): string {
	if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
	if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
	return w;
}

export function terms(text: string): string[] {
	const out: string[] = [];
	const spaced = text.normalize("NFKC").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	for (const m of spaced
		.toLowerCase()
		.matchAll(/\p{Script=Hangul}+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[a-z0-9]+/gu)) {
		const w = m[0];
		if (/^[a-z0-9]+$/.test(w)) {
			if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue;
			out.push(stem(w));
		} else if (w.length === 1) {
			continue;
		} else {
			for (let i = 0; i < w.length - 1; i++) {
				const bg = w.slice(i, i + 2);
				if (!STOP_KO.has(bg)) out.push(bg);
			}
		}
	}
	return out;
}

export type RecallKind = "entry" | "decision" | "digest";

interface Doc {
	id: string;
	kind: RecallKind;
	/** day (YYYY-MM-DD) for entries/decisions, month for digests — what diary_read accepts. */
	ref: string;
	day: string;
	title: string;
	body: string;
	/** term → weighted frequency. A plain object so the on-disk cache is usable straight from JSON.parse. */
	tf: Record<string, number>;
	len: number;
}

interface Corpus {
	docs: Doc[];
	avgLen: number;
}

function tfOf(...parts: [string, number][]): { tf: Record<string, number>; len: number } {
	const tf: Record<string, number> = Object.create(null);
	let len = 0;
	for (const [text, weight] of parts) {
		for (const t of terms(text)) {
			tf[t] = (tf[t] ?? 0) + weight;
			len += weight;
		}
	}
	return { tf, len };
}

function freq(doc: Doc, t: string): number {
	return Object.hasOwn(doc.tf, t) ? doc.tf[t] : 0;
}

/** Docs for one diary file. Pure function of the file's content, so it can be cached per file. */
function docsForFile(kind: "day" | "archived-day" | "decisions" | "digest", path: string): Doc[] {
	const docs: Doc[] = [];
	const content = read(path);
	if (kind === "day" || kind === "archived-day") {
		const day = basename(path, ".md");
		for (const e of parseDay(content, day, kind === "archived-day")) {
			const { tf, len } = tfOf([e.title, 3], [e.tags.join(" "), 3], [e.body, 1]);
			docs.push({ id: `e:${e.day}T${e.time}:${e.title.slice(0, 40)}`, kind: "entry", ref: e.day, day: e.day, title: e.title, body: e.body, tf, len });
		}
	} else if (kind === "decisions") {
		for (const dec of parseDecisions(content)) {
			if (dec.supersededBy) continue;
			const { tf, len } = tfOf([dec.text, 2]);
			docs.push({ id: `d:${dec.id}`, kind: "decision", ref: dec.id, day: dec.day, title: `${dec.id} ${dec.text}`, body: "", tf, len });
		}
	} else {
		const m = basename(path, ".md");
		const headline = digestHeadline(content);
		const sections = content
			.replace(/^---\n[\s\S]*?\n---\n/, "")
			.split(/^(?=## )/m)
			.filter((x) => x.trim() && !x.startsWith("## Source days") && x.startsWith("## "));
		sections.forEach((x, i) => {
			const head = x.match(/^## (.+)$/m)?.[1] ?? "";
			const { tf, len } = tfOf([headline, 2], [head, 2], [x, 1]);
			docs.push({ id: `g:${m}#${i}`, kind: "digest", ref: m, day: `${m}-15`, title: `${m} digest — ${head || headline}`, body: x.trim(), tf, len });
		});
	}
	return docs;
}

interface FileRef {
	key: string;
	path: string;
	kind: "day" | "archived-day" | "decisions" | "digest";
	stamp: string;
}

function diaryFiles(root: string): FileRef[] {
	const p = diaryPaths(root);
	const out: FileRef[] = [];
	const add = (path: string, kind: FileRef["kind"]) => {
		try {
			const st = statSync(path);
			out.push({ key: relative(root, path), path, kind, stamp: `${st.mtimeMs}:${st.size}` });
		} catch {
			/* vanished */
		}
	};
	for (const d of listDays(root, true)) add(d.path, d.archived ? "archived-day" : "day");
	if (existsSync(p.decisions)) add(p.decisions, "decisions");
	for (const m of listDigests(root)) add(join(p.digests, `${m}.md`), "digest");
	return out;
}

/**
 * Per-file cache, in memory and on disk (.ad/.local/recall-cache.json), so a process that starts fresh
 * for every prompt — Claude Code hooks — re-analyzes only files that changed since the last prompt.
 */
interface DiskCache {
	v: number;
	files: Record<string, { stamp: string; docs: Doc[] }>;
}
const CACHE_VERSION = 2;
const memory = new Map<string, { files: Map<string, { stamp: string; docs: Doc[] }>; sig: string; corpus: Corpus }>();

function cachePath(root: string): string {
	return join(diaryPaths(root).local, "recall-cache.json");
}

function loadDisk(root: string): Map<string, { stamp: string; docs: Doc[] }> {
	const out = new Map<string, { stamp: string; docs: Doc[] }>();
	try {
		const raw = JSON.parse(read(cachePath(root)) || "null") as DiskCache | null;
		if (raw?.v !== CACHE_VERSION) return out;
		for (const [k, f] of Object.entries(raw.files)) out.set(k, f);
	} catch {
		/* corrupt cache: rebuild */
	}
	return out;
}

function saveDisk(root: string, files: Map<string, { stamp: string; docs: Doc[] }>): void {
	const ser: DiskCache = { v: CACHE_VERSION, files: {} };
	for (const [k, f] of files) ser.files[k] = f;
	try {
		writeFile(cachePath(root), JSON.stringify(ser));
	} catch {
		/* cache is optional */
	}
}

function corpusFor(root: string): Corpus {
	const refs = diaryFiles(root);
	const sig = refs.map((r) => `${r.key}@${r.stamp}`).join("|");
	const mem = memory.get(root);
	if (mem && mem.sig === sig) return mem.corpus;

	const prev = mem?.files ?? loadDisk(root);
	const files = new Map<string, { stamp: string; docs: Doc[] }>();
	let dirty = !mem && prev.size !== refs.length;
	for (const r of refs) {
		const hit = prev.get(r.key);
		if (hit && hit.stamp === r.stamp) files.set(r.key, hit);
		else {
			files.set(r.key, { stamp: r.stamp, docs: docsForFile(r.kind, r.path) });
			dirty = true;
		}
	}
	if (prev.size !== files.size) dirty = true;
	if (dirty && isInitialized(root)) saveDisk(root, files);

	const docs = [...files.values()].flatMap((f) => f.docs);
	let total = 0;
	for (const d of docs) total += d.len;
	const corpus = { docs, avgLen: docs.length ? total / docs.length : 1 };
	memory.set(root, { files, sig, corpus });
	return corpus;
}

export interface RecallHit {
	id: string;
	kind: RecallKind;
	ref: string;
	day: string;
	title: string;
	score: number;
	snippet: string;
}

export interface RankOptions {
	limit?: number;
	minScore?: number;
	/** Skip these doc ids (already shown this session). */
	excludeIds?: Iterable<string>;
	/** Skip journal entries from these days (already visible in the injected timeline). */
	excludeDays?: Iterable<string>;
	/** Skip these decision ids (already injected). */
	excludeDecisions?: Iterable<string>;
	now?: Date;
}

function snippetFor(doc: Doc, qterms: Set<string>): string {
	if (doc.kind === "decision") return "";
	const lines = doc.body
		.split("\n")
		.map((l) => l.replace(/^\s*-\s*/, "").trim())
		.filter((l) => l && !l.startsWith("**Files**") && !l.startsWith("**Tags**"));
	const scored = lines.map((l, i) => {
		const ts = terms(l);
		const hits = ts.filter((t) => qterms.has(t)).length;
		const bonus = /^\*\*(Intent|Decisions)\*\*/.test(l) ? 0.5 : 0;
		return { l, i, s: hits + bonus };
	});
	const best = scored
		.filter((x) => x.s > 0)
		.sort((a, b) => b.s - a.s || a.i - b.i)
		.slice(0, 2)
		.sort((a, b) => a.i - b.i)
		.map((x) => oneLine(x.l.replace(/\*\*/g, ""), 180));
	return best.join(" · ");
}

export function rank(root: string, query: string, opts: RankOptions = {}): RecallHit[] {
	const q = [...new Set(terms(query))];
	if (q.length === 0) return [];
	const { docs, avgLen } = corpusFor(root);
	const N = docs.length;
	if (N === 0) return [];
	// Document frequency only for the query's terms — cheaper than maintaining a global table.
	const idf = new Map<string, number>();
	for (const t of q) {
		let n = 0;
		for (const d of docs) if (Object.hasOwn(d.tf, t)) n++;
		if (n) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
	}
	if (!idf.size) return [];
	const exIds = new Set(opts.excludeIds ?? []);
	const exDays = new Set(opts.excludeDays ?? []);
	const exDec = new Set(opts.excludeDecisions ?? []);
	const k1 = 1.2;
	const b = 0.75;
	const now = opts.now ?? new Date();
	const qset = new Set(q);

	const scored: { doc: Doc; score: number }[] = [];
	for (const doc of docs) {
		if (exIds.has(doc.id)) continue;
		if (doc.kind === "entry" && exDays.has(doc.day)) continue;
		if (doc.kind === "decision" && exDec.has(doc.ref)) continue;
		let s = 0;
		for (const [t, w] of idf) {
			const f = freq(doc, t);
			if (f) s += (w * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * doc.len) / avgLen));
		}
		if (s <= 0) continue;
		s *= 1 + 0.25 * Math.exp(-Math.max(0, daysSince(doc.day, now)) / 120);
		scored.push({ doc, score: s });
	}
	scored.sort((a, b) => b.score - a.score);
	const top = scored[0]?.score ?? 0;
	const min = Math.max(opts.minScore ?? 0, top * 0.45);
	// A decision is redundant when a selected entry already carries it ("[D12]" in its body).
	const picked: Doc[] = [];
	const covered = new Set<string>();
	for (const { doc } of scored.filter((x) => x.score >= min)) {
		if (picked.length >= (opts.limit ?? 8)) break;
		if (doc.kind === "decision" && covered.has(doc.ref)) continue;
		picked.push(doc);
		if (doc.kind === "entry") for (const m of doc.body.matchAll(/\[(D[0-9a-z]{1,8})\]/g)) covered.add(m[1]);
	}
	// Drop a decision picked before the entry that carries it.
	const scoreOf = new Map(scored.map((x) => [x.doc, x.score]));
	return picked
		.filter((doc) => !(doc.kind === "decision" && covered.has(doc.ref)))
		.map((doc) => ({ doc, score: scoreOf.get(doc) ?? 0 }))
		.map(({ doc, score }) => ({
			id: doc.id,
			kind: doc.kind,
			ref: doc.ref,
			day: doc.day,
			title: doc.title,
			score: Math.round(score * 100) / 100,
			snippet: snippetFor(doc, qset),
		}));
}

export function formatHit(h: RecallHit): string {
	if (h.kind === "decision") return `- ${h.title} (${h.day})`;
	const where = h.kind === "digest" ? h.ref : h.day;
	return `- [${where}] ${oneLine(h.title, 110)}${h.snippet ? `\n  ${h.snippet}` : ""}`;
}

/**
 * Memories to show alongside a user prompt, bounded by `budgets.recall`. Returns undefined when
 * nothing clears the relevance bar — silence is the common, correct outcome.
 */
export function recallFor(
	root: string,
	cfg: DiaryConfig,
	prompt: string,
	opts: Omit<RankOptions, "limit" | "minScore"> = {},
): { text: string; ids: string[] } | undefined {
	if (!cfg.recall.enabled) return undefined;
	const hits = rank(root, prompt.slice(0, 4000), { ...opts, limit: cfg.recall.maxItems, minScore: cfg.recall.minScore });
	if (!hits.length) return undefined;
	const header =
		"Possibly relevant memories from this project's agent diary (older than the timeline you were given). " +
		"Use them if they apply; read details with diary_read <date|D#|month>; ignore them otherwise.";
	const lines: string[] = [];
	const ids: string[] = [];
	let used = estimateTokens(header);
	for (const h of hits) {
		const line = formatHit(h);
		const t = estimateTokens(line) + 1;
		if (used + t > cfg.budgets.recall) break;
		lines.push(line);
		ids.push(h.id);
		used += t;
	}
	if (!lines.length) return undefined;
	return { text: `${header}\n${lines.join("\n")}`, ids };
}
