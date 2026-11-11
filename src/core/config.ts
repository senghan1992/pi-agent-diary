import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AD_DIR = ".ad";

export type AutoMode = "auto" | "remind" | "off";

export interface DiaryConfig {
	/**
	 * Hard token caps (estimated). Writes exceeding a cap are rejected, so the agent has to curate
	 * instead of append. Together they bound what a new session pays, however long the history gets.
	 */
	budgets: {
		/** PROJECT.md — injected every session. */
		project: number;
		/** STATUS.md — injected every session. */
		status: number;
		/** One journal entry. Keeps entries skimmable and roll-ups lossless. */
		entry: number;
		/** One monthly digest. */
		digest: number;
		/** Pinned decisions, injected every session. */
		pinned: number;
		/** Memories recalled for one user prompt. */
		recall: number;
		/** The whole bundle injected at session start. */
		context: number;
	};
	/** Most-recent journal days shown in the injected timeline. */
	recentDays: number;
	/** Most-recent active (not superseded) decisions injected. */
	recentDecisions: number;
	/** Per-prompt recall of older, relevant diary entries. */
	recall: {
		enabled: boolean;
		/** Max items recalled per prompt. */
		maxItems: number;
		/** Minimum BM25 score for an item to be recalled. Raise if recall is noisy. */
		minScore: number;
	};
	/** A journal month whose newest day is older than this many days is rolled up into a digest. */
	hotDays: number;
	/** auto: ask the agent to write when unrecorded work piles up. remind: footer only. off: nothing. */
	autoWrite: AutoMode;
	/** Unrecorded file edits before the agent is asked to write an entry. */
	nudgeAfterMutations: number;
	/** …or this many distinct files changed since the last entry/reminder. */
	nudgeAfterFiles: number;
	/** auto: roll up due months in the background. remind: only mention it. off: never. */
	autoCompact: AutoMode;
	/** pi: model for background roll-ups as "provider/model-id". Default: the session's model. */
	compactModel?: string;
	/**
	 * CLI: shell command used as summarizer for `ad compact run` (prompt on stdin, answer on stdout),
	 * e.g. "claude -p --model haiku". Env AGENT_DIARY_SUMMARIZER overrides.
	 */
	summarizer?: string;
	/** Session facts from sessions that never wrote an entry are dropped after this many days. */
	pendingTtlDays: number;
}

export const DEFAULT_CONFIG: DiaryConfig = {
	budgets: { project: 1200, status: 600, entry: 450, digest: 1000, pinned: 350, recall: 450, context: 3000 },
	recentDays: 7,
	recentDecisions: 8,
	recall: { enabled: true, maxItems: 4, minScore: 4 },
	hotDays: 30,
	autoWrite: "auto",
	nudgeAfterMutations: 6,
	nudgeAfterFiles: 2,
	autoCompact: "auto",
	pendingTtlDays: 14,
};

/**
 * Whether `.ad/` is created automatically once an agent changes files inside a git repository.
 * Global switch (there is no per-project config before `.ad/` exists): AGENT_DIARY_AUTO_INIT=0 disables.
 */
export function autoInitEnabled(): boolean {
	return process.env.AGENT_DIARY_AUTO_INIT !== "0";
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadConfig(root: string): DiaryConfig {
	const file = join(root, AD_DIR, "config.json");
	const base = structuredClone(DEFAULT_CONFIG);
	if (!existsSync(file)) return base;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isObject(raw)) return base;
		return {
			...base,
			...(raw as Partial<DiaryConfig>),
			budgets: { ...base.budgets, ...(isObject(raw.budgets) ? raw.budgets : {}) },
			recall: { ...base.recall, ...(isObject(raw.recall) ? raw.recall : {}) },
		} as DiaryConfig;
	} catch {
		return base;
	}
}
