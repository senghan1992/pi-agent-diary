import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DiaryConfig } from "./config.ts";
import { diaryPaths, read, writeFile } from "./store.ts";
import { oneLine } from "./util.ts";

/**
 * Per-session facts gathered mechanically from agent events — no LLM cost. They drive the
 * "please record this" nudge, de-duplicate recall, and, if a session ends without an entry
 * (crash, quit, ignored nudge), let the next session backfill from them.
 *
 * Stored in .ad/.local/sessions/<id>.json (git-ignored, machine-local).
 */
export interface SessionState {
	sessionId: string;
	agent: string;
	startedAt: string;
	updatedAt: string;
	prompts: string[];
	filesChanged: string[];
	/** Successful file-mutating tool calls. */
	mutations: number;
	/** `mutations` at the last diary entry from this session. */
	recordedMutations: number;
	/** `mutations` when the agent was last reminded to write. */
	nudgedAt: number;
	/** `filesChanged.length` at the last entry or reminder. */
	filesMark: number;
	bashCalls: number;
	/** Recall item ids already shown in this session. */
	recalled: string[];
}

export function newSession(sessionId: string, agent: string): SessionState {
	const now = new Date().toISOString();
	return {
		sessionId,
		agent,
		startedAt: now,
		updatedAt: now,
		prompts: [],
		filesChanged: [],
		mutations: 0,
		recordedMutations: 0,
		nudgedAt: 0,
		filesMark: 0,
		bashCalls: 0,
		recalled: [],
	};
}

function file(root: string, sessionId: string): string {
	return join(diaryPaths(root).sessions, `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

export function loadSession(root: string, sessionId: string): SessionState | undefined {
	const raw = read(file(root, sessionId));
	if (!raw) return undefined;
	try {
		return { ...newSession(sessionId, "unknown"), ...(JSON.parse(raw) as Partial<SessionState>) };
	} catch {
		return undefined;
	}
}

export function saveSession(root: string, s: SessionState): void {
	s.updatedAt = new Date().toISOString();
	writeFile(file(root, s.sessionId), JSON.stringify(s, null, 2));
}

export function unrecorded(s: SessionState): number {
	return Math.max(0, s.mutations - s.recordedMutations);
}

export function markRecorded(s: SessionState): void {
	s.recordedMutations = s.mutations;
	s.nudgedAt = s.mutations;
	s.filesMark = s.filesChanged.length;
}

export function markNudged(s: SessionState): void {
	s.nudgedAt = s.mutations;
	s.filesMark = s.filesChanged.length;
}

/**
 * Should the agent be asked to write now (checked when a turn is about to end)? Yes when, since the
 * last entry or reminder, there were `nudgeAfterMutations` edits or `nudgeAfterFiles` distinct files
 * changed — a multi-file feature in few edits counts; a one-line fix doesn't. `force` (conversation
 * compaction imminent) needs just one unreminded edit. Never twice for the same work.
 */
export function nudgeDue(s: SessionState, cfg: DiaryConfig, force = false): boolean {
	if (cfg.autoWrite !== "auto" || unrecorded(s) === 0) return false;
	const newEdits = s.mutations - Math.max(s.recordedMutations, s.nudgedAt);
	if (newEdits <= 0) return false;
	if (force) return true;
	const newFiles = s.filesChanged.length - s.filesMark;
	return newEdits >= cfg.nudgeAfterMutations || newFiles >= cfg.nudgeAfterFiles;
}

export function recordFile(s: SessionState, rel: string): void {
	if (!rel || rel.startsWith(".ad/") || rel.startsWith("..") || s.filesChanged.includes(rel)) return;
	if (s.filesChanged.length < 40) s.filesChanged.push(rel);
}

export function recordPrompt(s: SessionState, prompt: string): void {
	if (s.prompts.length < 5 && prompt.trim()) s.prompts.push(prompt.trim().slice(0, 300));
}

/** Other sessions that changed files without recording them. Expired ones are deleted. */
export function listUnrecorded(root: string, cfg: DiaryConfig, excludeSessionId?: string, now = new Date()): SessionState[] {
	const dir = diaryPaths(root).sessions;
	if (!existsSync(dir)) return [];
	const out: SessionState[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		const path = join(dir, f);
		const ageDays = (now.getTime() - statSync(path).mtimeMs) / 86_400_000;
		const s = loadSession(root, f.slice(0, -5));
		if (!s) continue;
		if (ageDays > cfg.pendingTtlDays) {
			rmSync(path, { force: true });
			continue;
		}
		if (s.sessionId !== excludeSessionId && unrecorded(s) > 0) out.push(s);
	}
	return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** After a backfill entry: mark every other session as recorded. */
export function markAllRecorded(root: string, cfg: DiaryConfig, exceptSessionId?: string): number {
	const list = listUnrecorded(root, cfg, exceptSessionId);
	for (const s of list) {
		markRecorded(s);
		saveSession(root, s);
	}
	return list.length;
}

export function describeSession(s: SessionState): string {
	const prompts = s.prompts.map((p) => `"${oneLine(p, 80)}"`).join("; ");
	const files =
		s.filesChanged.slice(0, 8).join(", ") + (s.filesChanged.length > 8 ? ` (+${s.filesChanged.length - 8})` : "");
	return `- ${s.startedAt.slice(0, 16).replace("T", " ")} (${s.agent}) · ${unrecorded(s)} unrecorded edits · prompts: ${prompts || "-"} · files: ${files || "-"}`;
}
