/**
 * Conservative token estimate (no tokenizer dependency). ASCII ≈ 4 chars/token; any other
 * character (Hangul, CJK, accents, emoji) counts as one token, which over-estimates most
 * tokenizers slightly. Budgets are guard rails, so erring high is the safe direction.
 */
export function estimateTokens(text: string): number {
	let ascii = 0;
	let other = 0;
	for (const ch of text) {
		if (ch.charCodeAt(0) < 128) ascii++;
		else other++;
	}
	return Math.ceil(ascii / 4 + other);
}

/** Truncate text to roughly `maxTokens`, cutting at a line boundary. */
export function truncateToTokens(text: string, maxTokens: number, marker = "…(truncated)"): string {
	if (estimateTokens(text) <= maxTokens) return text;
	const out: string[] = [];
	let used = estimateTokens(marker) + 1;
	for (const line of text.split("\n")) {
		const t = estimateTokens(line) + 1;
		if (used + t > maxTokens) break;
		out.push(line);
		used += t;
	}
	out.push(marker);
	return out.join("\n");
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local-time YYYY-MM-DD. */
export function ymd(d: Date = new Date()): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-time HH:MM. */
export function hm(d: Date = new Date()): string {
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whole days between a YYYY-MM-DD string and `now` (local time). */
export function daysSince(day: string, now: Date = new Date()): number {
	const [y, m, d] = day.split("-").map(Number);
	const then = new Date(y, (m ?? 1) - 1, d ?? 1);
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((today.getTime() - then.getTime()) / 86_400_000);
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-\d{2}$/;

/** Accept a string or string[] and return a clean string[]. Models send either. */
export function toList(v: unknown): string[] {
	if (v == null) return [];
	if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
	return String(v)
		.split("\n")
		.map((x) => x.replace(/^\s*[-*]\s*/, "").trim())
		.filter(Boolean);
}

export function oneLine(s: string, max = 120): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
