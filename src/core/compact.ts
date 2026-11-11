import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DiaryConfig } from "./config.ts";
import { type Decision, activeDecisions, extractIds, applyDecisionChanges, readDecisions, writeDecisions } from "./decisions.ts";
import { tryLock, unlock } from "./lock.ts";
import { findSecrets, secretRejection } from "./secrets.ts";
import {
	type JournalEntry,
	type WriteResult,
	diaryPaths,
	listDayFiles,
	listMonthDirs,
	locked,
	parseDay,
	read,
	rebuildIndexUnlocked,
	writeFile,
} from "./store.ts";
import { MONTH_RE, estimateTokens, oneLine, truncateToTokens, ymd } from "./util.ts";

/**
 * Roll-up: a journal month that has gone cold is summarized into one digest (≤ budgets.digest),
 * and its day files move to archive/ — still readable and searchable, no longer in the timeline.
 *
 * Summarization is map-reduce so no month is ever truncated: the month is cut into chunks at
 * entry boundaries, each chunk becomes notes, and the notes become the digest. The summarizer is
 * injected (pi: a background model call; CLI: any command such as `claude -p`), so this module
 * stays agent-agnostic and testable.
 */

export interface CompactCandidate {
	month: string;
	days: number;
	tokens: number;
}

/** Months entirely older than `hotDays`, excluding the current month. Oldest first. */
export function compactCandidates(root: string, cfg: DiaryConfig, now: Date = new Date()): CompactCandidate[] {
	const p = diaryPaths(root);
	const cutoff = ymd(new Date(now.getTime() - cfg.hotDays * 86_400_000));
	const thisMonth = ymd(now).slice(0, 7);
	const out: CompactCandidate[] = [];
	for (const m of listMonthDirs(p.journal)) {
		if (m >= thisMonth) continue;
		const files = listDayFiles(join(p.journal, m));
		if (!files.length) continue;
		if (files[files.length - 1].slice(0, -3) >= cutoff) continue;
		// Display-only size hint: estimated from bytes (UTF-8 ≈ 3 bytes per Hangul char ≈ 1 token; ASCII ≈ 4 bytes
		// per token) so this check stays a directory listing however much history is pending.
		const bytes = files.reduce((n, f) => n + statSync(join(p.journal, m, f)).size, 0);
		const tokens = Math.ceil(bytes / 3);
		out.push({ month: m, days: files.length, tokens });
	}
	return out;
}

export function monthEntries(root: string, month: string): JournalEntry[] {
	const dir = join(diaryPaths(root).journal, month);
	return listDayFiles(dir).flatMap((f) => parseDay(read(join(dir, f)), f.slice(0, -3)));
}

function renderEntry(e: JournalEntry): string {
	return `### ${e.day} ${e.time} · ${e.title}\n${e.body}`;
}

/** Split a month into chunks of at most ~chunkTokens, never splitting an entry. */
export function chunkMonth(root: string, month: string, chunkTokens = 9000): string[] {
	const chunks: string[] = [];
	let cur: string[] = [];
	let used = 0;
	for (const e of monthEntries(root, month)) {
		let text = renderEntry(e);
		let t = estimateTokens(text);
		if (t > chunkTokens) {
			text = truncateToTokens(text, chunkTokens);
			t = chunkTokens;
		}
		if (used + t > chunkTokens && cur.length) {
			chunks.push(cur.join("\n\n"));
			cur = [];
			used = 0;
		}
		cur.push(text);
		used += t;
	}
	if (cur.length) chunks.push(cur.join("\n\n"));
	return chunks;
}

function monthDecisions(root: string, month: string): Decision[] {
	return activeDecisions(readDecisions(diaryPaths(root).decisions)).filter((d) => d.day.startsWith(month));
}

const LANG = "Write in the same language the entries are written in.";

export function notesPrompt(month: string, part: number, parts: number, chunk: string): string {
	return [
		`You are condensing part ${part}/${parts} of a software project's agent diary for ${month}.`,
		`Extract compact notes (≤ 500 tokens) for a later monthly digest: goals pursued, outcomes, decisions with their reasons and decision ids [D#], lessons and gotchas, unresolved threads. Keep dates for important events. No preamble.`,
		LANG,
		"",
		"<entries>",
		chunk,
		"</entries>",
	].join("\n");
}

export function digestPrompt(month: string, material: string, decisions: Decision[], budget: number, fromNotes: boolean): string {
	const dec = decisions.length ? decisions.map((d) => `- [${d.id}]${d.pinned ? " ★" : ""} ${d.day} · ${d.text}`).join("\n") : "(none)";
	return [
		`Write the monthly digest for ${month} of a software project's agent diary. Future coding sessions read it to understand what happened and why, so keep intent, outcomes, decisions with reasons, and lessons; drop step-by-step detail and anything git already shows.`,
		`Hard limit: ${Math.floor(budget * 0.9)} tokens for the DIGEST part. ${LANG}`,
		"",
		"Decisions recorded this month:",
		dec,
		"",
		"Reply in exactly this format:",
		"HEADLINE: <one line, ≤ 120 chars, the month's main story>",
		"PIN: <comma-separated ids of decisions that remain fundamental for the project going forward, or none>",
		"SUPERSEDE: <comma-separated ids of decisions this month's later work made obsolete, or none>",
		"DIGEST:",
		"## Goals",
		"## Outcomes",
		"## Key decisions",
		"## Lessons",
		"## Unresolved",
		"",
		fromNotes ? "<notes>" : "<entries>",
		material,
		fromNotes ? "</notes>" : "</entries>",
	].join("\n");
}

export interface DigestDraft {
	headline: string;
	digest: string;
	pin: string[];
	supersede: string[];
}

function ids(line: string | undefined): string[] {
	if (!line || /^\s*none\s*$/i.test(line)) return [];
	return extractIds(line);
}

export function parseDigestReply(text: string): DigestDraft {
	const t = text.replace(/^```\w*\n?|```\s*$/g, "").trim();
	const headline = t.match(/^HEADLINE:\s*(.+)$/m)?.[1]?.trim();
	const pin = ids(t.match(/^PIN:\s*(.*)$/m)?.[1]);
	const supersede = ids(t.match(/^SUPERSEDE:\s*(.*)$/m)?.[1]);
	const idx = t.search(/^DIGEST:\s*$/m);
	const digest = idx >= 0 ? t.slice(idx).replace(/^DIGEST:\s*\n?/, "").trim() : t.replace(/^(HEADLINE|PIN|SUPERSEDE):.*$/gm, "").trim();
	return { headline: oneLine(headline || digest.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "(digest)", 160), digest, pin, supersede };
}

/** Write the digest, archive the month's days, and apply pin/supersede (limited to that month's decisions). */
export function commitDigest(root: string, cfg: DiaryConfig, month: string, draft: DigestDraft): WriteResult {
	const budget = cfg.budgets.digest;
	if (!MONTH_RE.test(month)) return { ok: false, tokens: 0, budget, message: `Bad month "${month}" (want YYYY-MM).` };
	const tokens = estimateTokens(draft.digest);
	const leaks = findSecrets(`${draft.headline}\n${draft.digest}`);
	if (leaks.length) return { ok: false, tokens, budget, message: secretRejection("Digest", leaks) };
	if (!draft.digest.trim()) return { ok: false, tokens, budget, message: "Digest is empty." };
	if (tokens > budget) {
		return {
			ok: false,
			tokens,
			budget,
			message: `Digest rejected: ~${tokens} tokens exceeds budget ${budget}. Keep intent, outcomes, decisions + reasons, lessons; drop details.`,
		};
	}
	return locked(root, () => {
		const p = diaryPaths(root);
		const src = join(p.journal, month);
		if (!existsSync(src)) return { ok: false, tokens, budget, message: `No hot journal for ${month}.` };
		const days = listDayFiles(src).map((f) => f.slice(0, -3));
		const fm = `---\nmonth: ${month}\nheadline: ${oneLine(draft.headline, 160)}\ndays: [${days.join(", ")}]\n---\n`;
		writeFile(
			join(p.digests, `${month}.md`),
			`${fm}# ${month}\n\n${draft.digest.trim()}\n\n## Source days\n${days.map((d) => `[[${d}]]`).join(" ")}\n`,
		);
		const dest = join(p.archive, month);
		mkdirSync(dest, { recursive: true });
		for (const f of readdirSync(src)) renameSync(join(src, f), join(dest, f));
		rmdirSync(src);

		const allowed = new Set(monthDecisions(root, month).map((d) => d.id));
		const { decisions, changed } = applyDecisionChanges(readDecisions(p.decisions), {
			day: month,
			pin: draft.pin.filter((id) => allowed.has(id)),
			supersede: draft.supersede.filter((id) => allowed.has(id)),
		});
		if (changed) writeDecisions(p.decisions, decisions);
		rebuildIndexUnlocked(root);
		return { ok: true, tokens, budget, message: `Rolled up ${month}: digest ~${tokens} tokens, ${days.length} day(s) → archive/${month}/.` };
	});
}

export type Summarize = (prompt: string, signal?: AbortSignal) => Promise<string>;

export interface CompactRun {
	month: string;
	ok: boolean;
	message: string;
	calls: number;
}

/** Roll up one month with the given summarizer. Holds a non-blocking lock so only one process compacts. */
export async function runCompaction(
	root: string,
	cfg: DiaryConfig,
	month: string,
	summarize: Summarize,
	signal?: AbortSignal,
): Promise<CompactRun> {
	const lock = diaryPaths(root).compactLock;
	if (!tryLock(lock)) return { month, ok: false, message: "Another roll-up is running.", calls: 0 };
	let calls = 0;
	const call = async (prompt: string) => {
		if (signal?.aborted) throw new Error("aborted");
		calls++;
		return summarize(prompt, signal);
	};
	try {
		const chunks = chunkMonth(root, month);
		if (!chunks.length) return { month, ok: false, message: `Nothing to roll up for ${month}.`, calls };
		const decisions = monthDecisions(root, month);
		let material = chunks[0];
		let fromNotes = false;
		if (chunks.length > 1) {
			const notes: string[] = [];
			for (let i = 0; i < chunks.length; i++) notes.push(await call(notesPrompt(month, i + 1, chunks.length, chunks[i])));
			material = notes.map((n, i) => `### Part ${i + 1}\n${n.trim()}`).join("\n\n");
			fromNotes = true;
		}
		let draft = parseDigestReply(await call(digestPrompt(month, material, decisions, cfg.budgets.digest, fromNotes)));
		if (estimateTokens(draft.digest) > cfg.budgets.digest) {
			const retry = parseDigestReply(
				await call(
					`This digest is ~${estimateTokens(draft.digest)} tokens; the limit is ${Math.floor(cfg.budgets.digest * 0.85)}. ` +
						`Shorten it, keep the same reply format (HEADLINE/PIN/SUPERSEDE/DIGEST) and the same language.\n\n` +
						`HEADLINE: ${draft.headline}\nPIN: ${draft.pin.join(", ") || "none"}\nSUPERSEDE: ${draft.supersede.join(", ") || "none"}\nDIGEST:\n${draft.digest}`,
				),
			);
			draft = { ...retry, headline: retry.headline || draft.headline };
			if (estimateTokens(draft.digest) > cfg.budgets.digest) {
				draft.digest = truncateToTokens(draft.digest, cfg.budgets.digest - 20, "…(shortened)");
			}
		}
		const r = commitDigest(root, cfg, month, draft);
		return { month, ok: r.ok, message: r.message, calls };
	} catch (e) {
		return { month, ok: false, message: `Roll-up of ${month} failed: ${(e as Error).message}`, calls };
	} finally {
		unlock(lock);
	}
}

/** Roll up every due month, oldest first. Stops at the first failure. */
export async function runDueCompactions(
	root: string,
	cfg: DiaryConfig,
	summarize: Summarize,
	signal?: AbortSignal,
	now: Date = new Date(),
): Promise<CompactRun[]> {
	const out: CompactRun[] = [];
	for (const c of compactCandidates(root, cfg, now)) {
		if (signal?.aborted) break;
		const r = await runCompaction(root, cfg, c.month, summarize, signal);
		out.push(r);
		if (!r.ok) break;
	}
	return out;
}
