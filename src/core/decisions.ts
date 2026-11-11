import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { estimateTokens, oneLine } from "./util.ts";

/**
 * decisions.md is the project's decision log, one line per decision, oldest first:
 *
 *   - [D7k2qf] 2026-11-06 · Per-user mutex for token refresh — simplest (rejected: queue) — [[2026-11-06]]
 *   - [Dm3x0a] ★ 2026-11-06 · All timestamps are UTC — [[2026-11-06]]                        (pinned)
 *   - [D4bz1c] ~~2026-10-02 · Retry in the client~~ → D7k2qf — [[2026-10-02]]                  (superseded)
 *
 * Ids are short content hashes, not counters, so two branches or teammates writing at the same time
 * can never mint the same id. The file is merged with git's `union` driver (see .ad/.gitattributes);
 * if a merge leaves two versions of one decision, they are reconciled on read: superseded wins, a pin
 * survives, the newer wording is kept. Numeric ids from older versions (D12) stay valid.
 */
export interface Decision {
	id: string;
	day: string;
	text: string;
	pinned: boolean;
	/** Id or date of what replaced it. */
	supersededBy?: string;
	raw: string;
}

const HEADER = `# Decisions

<!-- agent-diary · one line per decision, oldest first. ★ = pinned (always loaded), ~~struck~~ = superseded.
     Written by diary_write and roll-ups; edit by hand only to fix wording. -->
`;

const ID = "D[0-9a-z]{1,8}";
const LINE = new RegExp(
	`^- \\[(${ID})\\] (★ )?(~~)?(\\d{4}-\\d{2}-\\d{2}) · (.+?)(?:~~ → (\\S+))? — \\[\\[\\d{4}-\\d{2}-\\d{2}\\]\\]\\s*$`,
);
const LEGACY = /^- (\d{4}-\d{2}-\d{2}) · (.+?) — \[\[\d{4}-\d{2}-\d{2}\]\]\s*$/;
export const DECISION_ID_RE = new RegExp(`^${ID}$`);

/** 5-char base36 hash of the decision; salted on the (astronomically rare) collision. */
export function decisionId(day: string, text: string, taken: Set<string> = new Set()): string {
	for (let salt = 0; ; salt++) {
		const h = createHash("sha1").update(`${day}\0${text}\0${salt}`).digest();
		const id = `D${(h.readUInt32BE(0) % 36 ** 5).toString(36).padStart(5, "0")}`;
		if (!taken.has(id)) return id;
	}
}

export function formatDecision(d: Omit<Decision, "raw">): string {
	const body = `${d.day} · ${d.text}`;
	const core = d.supersededBy ? `~~${body}~~ → ${d.supersededBy}` : body;
	return `- [${d.id}] ${d.pinned && !d.supersededBy ? "★ " : ""}${core} — [[${d.day}]]`;
}

export function parseDecisions(content: string): Decision[] {
	const out: Decision[] = [];
	const byId = new Map<string, Decision>();
	const taken = new Set<string>();
	for (const line of content.split("\n")) {
		const m = line.match(LINE);
		let d: Decision | undefined;
		if (m) {
			d = { id: m[1], pinned: !!m[2], day: m[4], text: m[5].replace(/~~$/, ""), supersededBy: m[3] ? m[6] : undefined, raw: line };
		} else {
			const l = line.match(LEGACY);
			if (l) d = { id: decisionId(l[1], l[2], taken), day: l[1], text: l[2], pinned: false, raw: "" };
		}
		if (!d) continue;
		const prev = byId.get(d.id);
		if (prev) {
			// Two versions of one decision (e.g. after a union merge): reconcile in place.
			prev.supersededBy ??= d.supersededBy;
			prev.pinned = (prev.pinned || d.pinned) && !prev.supersededBy;
			prev.text = d.text;
			prev.raw = formatDecision(prev);
			continue;
		}
		d.raw = formatDecision(d);
		byId.set(d.id, d);
		taken.add(d.id);
		out.push(d);
	}
	return out;
}

export function readDecisions(file: string): Decision[] {
	try {
		return parseDecisions(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

export function writeDecisions(file: string, decisions: Decision[]): void {
	mkdirSync(dirname(file), { recursive: true });
	const body = decisions.map((d) => formatDecision(d)).join("\n");
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${HEADER}\n${body}${body ? "\n" : ""}`, "utf8");
	renameSync(tmp, file);
}

export interface DecisionChanges {
	day: string;
	/** New decision texts. A leading ★ pins the decision. */
	add?: string[];
	/** Ids to mark superseded (by the first added decision, or by `day`). */
	supersede?: string[];
	/** Ids to pin. */
	pin?: string[];
	/** Ids to unpin. */
	unpin?: string[];
}

export interface DecisionChangeResult {
	decisions: Decision[];
	added: Decision[];
	changed: boolean;
	notes: string[];
}

/** Accept "D7k2qf", "[d7k2qf]", "7k2qf", "D12", "12". */
export function normId(s: string): string {
	const m = s.trim().match(/^\[?D?([0-9a-z]{1,8})\]?$/i);
	return m ? `D${m[1].toLowerCase()}` : s.trim();
}

/** Pure: returns the new decision list. */
export function applyDecisionChanges(current: Decision[], ch: DecisionChanges): DecisionChangeResult {
	const decisions = current.map((d) => ({ ...d }));
	const notes: string[] = [];
	let changed = false;
	const taken = new Set(decisions.map((d) => d.id));
	const added: Decision[] = [];
	for (const raw of ch.add ?? []) {
		const pinned = /^\s*★/.test(raw);
		const text = oneLine(raw.replace(/^\s*★\s*/, ""), 240);
		if (!text) continue;
		const id = decisionId(ch.day, text, taken);
		taken.add(id);
		const d: Decision = { id, day: ch.day, text, pinned, raw: "" };
		decisions.push(d);
		added.push(d);
		changed = true;
	}
	const byId = new Map(decisions.map((d) => [d.id.toLowerCase(), d]));
	const find = (s: string) => byId.get(normId(s).toLowerCase());
	const replacement = added[0]?.id ?? ch.day;
	for (const raw of ch.supersede ?? []) {
		const d = find(raw);
		if (!d) notes.push(`Unknown decision ${normId(raw)} (not superseded).`);
		else if (!d.supersededBy && !added.includes(d)) {
			d.supersededBy = replacement;
			d.pinned = false;
			changed = true;
		}
	}
	for (const raw of ch.pin ?? []) {
		const d = find(raw);
		if (!d) notes.push(`Unknown decision ${normId(raw)} (not pinned).`);
		else if (d.supersededBy) notes.push(`${d.id} is superseded; not pinned.`);
		else if (!d.pinned) {
			d.pinned = true;
			changed = true;
		}
	}
	for (const raw of ch.unpin ?? []) {
		const d = find(raw);
		if (d?.pinned) {
			d.pinned = false;
			changed = true;
		}
	}
	for (const d of decisions) d.raw = formatDecision(d);
	return { decisions, added, changed, notes };
}

export function findDecision(all: Decision[], id: string): Decision | undefined {
	const want = normId(id).toLowerCase();
	return all.find((d) => d.id.toLowerCase() === want);
}

export function activeDecisions(all: Decision[]): Decision[] {
	return all.filter((d) => !d.supersededBy);
}

/** Pinned decisions that fit in `budget` tokens (newest first win), plus how many were dropped. */
export function pinnedWithin(all: Decision[], budget: number): { lines: string[]; dropped: number } {
	const pinned = activeDecisions(all).filter((d) => d.pinned);
	const lines: string[] = [];
	let used = 0;
	for (const d of [...pinned].reverse()) {
		const t = estimateTokens(d.raw) + 1;
		if (used + t > budget) break;
		lines.unshift(d.raw);
		used += t;
	}
	return { lines, dropped: pinned.length - lines.length };
}

/** For prompts and parsers: ids appearing in free text ("D7k2qf, D12"). */
export function extractIds(text: string): string[] {
	return [...text.matchAll(/\bD[0-9a-z]{1,8}\b/gi)].map((m) => normId(m[0]));
}
