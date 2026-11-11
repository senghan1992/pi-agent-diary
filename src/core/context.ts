import type { DiaryConfig } from "./config.ts";
import { compactCandidates } from "./compact.ts";
import { activeDecisions, pinnedWithin, readDecisions } from "./decisions.ts";
import { describeSession, listUnrecorded } from "./session.ts";
import { buildIndexLines, diaryPaths, isInitialized, projectIsTemplate, readCuratedDoc } from "./store.ts";
import { estimateTokens, truncateToTokens } from "./util.ts";

export type Flavor = "pi" | "cli";

export interface ContextOptions {
	/** The current session (its own unrecorded facts are not reported back to it). */
	sessionId?: string;
	flavor?: Flavor;
	/** Roll-ups run automatically for this caller; don't ask the agent to do them. */
	autoCompacting?: boolean;
	now?: Date;
}

export interface ContextBundle {
	text: string;
	tokens: number;
	/** Journal days whose titles are in the timeline (recall skips them). */
	shownDays: string[];
	/** Decision ids included (recall skips them). */
	shownDecisions: string[];
}

function strip(md: string): string {
	return md.replace(/<!--[\s\S]*?-->\n?/g, "").trim();
}

const HOW: Record<Flavor, string> = {
	pi: "Tools: diary_write (record work; can replace STATUS, supersede/pin decisions), diary_update (rewrite PROJECT/STATUS), diary_read (YYYY-MM-DD | YYYY-MM | D# | index | decisions), diary_search. The agent-diary skill has the writing guidelines.",
	cli: "CLI: `ad write --json '{\"title\":…,\"intent\":…,\"done\":[…],\"decisions\":[…],\"next\":[…],\"status\":…}'`, `ad update project|status -`, `ad read <YYYY-MM-DD|YYYY-MM|D#|index|decisions>`, `ad search <words>`. The agent-diary skill has the writing guidelines.",
};

/**
 * The bundle injected at session start. Bounded by budgets.context no matter how much history
 * exists: PROJECT/STATUS/pinned are capped at write time, timeline and decisions are windowed,
 * and if the total still overflows, lower-priority sections are trimmed first.
 */
export function buildContext(root: string, cfg: DiaryConfig, opts: ContextOptions = {}): ContextBundle {
	const how = HOW[opts.flavor ?? "pi"];
	if (!isInitialized(root)) {
		const text = [
			`No agent diary exists for this project yet. It will be created in ${root}/.ad/ when you first record work.`,
			"After meaningful work, record an entry; then describe the project in PROJECT.md so future sessions start informed.",
			how,
		].join("\n");
		return { text, tokens: estimateTokens(text), shownDays: [], shownDecisions: [] };
	}

	const header = [
		`This project keeps an agent diary in ${root}/.ad/ — memory written by previous agent sessions. Use it to orient quickly, but verify against the code when it matters.`,
		"Record your own work before you finish; keep PROJECT/STATUS accurate.",
		how,
	].join("\n");

	const project = strip(readCuratedDoc(root, "project"));
	const status = strip(readCuratedDoc(root, "status"));
	const timeline = buildIndexLines(root, cfg.recentDays);
	const shownDays = timeline.map((l) => l.match(/^- \[\[(\d{4}-\d{2}-\d{2})\]\]/)?.[1]).filter((d): d is string => !!d);

	const all = readDecisions(diaryPaths(root).decisions);
	const pinned = pinnedWithin(all, cfg.budgets.pinned);
	const pinnedIds = new Set(all.filter((d) => pinned.lines.includes(d.raw)).map((d) => d.id));
	const recent = activeDecisions(all)
		.filter((d) => !pinnedIds.has(d.id))
		.slice(-cfg.recentDecisions);

	const notes: string[] = [];
	if (projectIsTemplate(root)) notes.push("PROJECT.md is still the template: after exploring the code, write it with diary_update doc=project.");
	if (pinned.dropped) notes.push(`${pinned.dropped} pinned decision(s) did not fit the pinned budget — consolidate them into PROJECT.md and unpin.`);
	const others = listUnrecorded(root, cfg, opts.sessionId, opts.now).slice(-3);
	if (others.length) {
		notes.push(
			`${others.length} earlier session(s) changed files without a diary entry. When convenient, check git log/diff and write one backfill entry (backfill: true). Captured facts:\n${others.map(describeSession).join("\n")}`,
		);
	}
	const due = compactCandidates(root, cfg, opts.now);
	if (due.length && !(opts.autoCompacting && cfg.autoCompact === "auto") && cfg.autoCompact !== "off") {
		notes.push(`Roll-up due for ${due.map((c) => c.month).join(", ")}. Run it when idle (pi: /diary compact; CLI: ad compact run).`);
	}

	const sections: { title: string; body: string; min: number }[] = [
		{ title: "", body: header, min: Number.MAX_SAFE_INTEGER },
		{ title: "PROJECT", body: project, min: 500 },
		{ title: "STATUS", body: status, min: 300 },
		{ title: "Pinned decisions", body: pinned.lines.join("\n"), min: 200 },
		{ title: `Timeline (newest ${timeline.length} days)`, body: timeline.join("\n"), min: 150 },
		{ title: "Recent decisions", body: recent.map((d) => d.raw).join("\n"), min: 100 },
		{ title: "Notes", body: notes.join("\n"), min: 80 },
	].filter((s) => s.body.trim());

	let total = sections.reduce((n, s) => n + estimateTokens(s.body), 0);
	for (let i = sections.length - 1; i >= 0 && total > cfg.budgets.context; i--) {
		const s = sections[i];
		const cur = estimateTokens(s.body);
		const target = Math.max(Math.min(s.min, cur), cur - (total - cfg.budgets.context));
		if (target < cur) {
			s.body = truncateToTokens(s.body, target, "…(trimmed — diary_read for more)");
			total -= cur - estimateTokens(s.body);
		}
	}

	const text = sections.map((s) => (s.title ? `## ${s.title}\n${s.body}` : s.body)).join("\n\n");
	const shownDecisions = all.filter((d) => text.includes(`[${d.id}]`)).map((d) => d.id);
	return { text, tokens: estimateTokens(text), shownDays, shownDecisions };
}
