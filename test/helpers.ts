import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type DiaryConfig } from "../src/core/index.ts";

/** Fresh temp dir; `git: true` makes it look like a repository root. */
export function tmpProject(git = true): string {
	const dir = mkdtempSync(join(tmpdir(), "ad-test-"));
	if (git) mkdirSync(join(dir, ".git"));
	return dir;
}

export function config(patch: Partial<DiaryConfig> = {}): DiaryConfig {
	const base = structuredClone(DEFAULT_CONFIG);
	return { ...base, ...patch, budgets: { ...base.budgets, ...(patch.budgets ?? {}) }, recall: { ...base.recall, ...(patch.recall ?? {}) } };
}

export function at(y: number, m: number, d: number, h = 10, min = 0): Date {
	return new Date(y, m - 1, d, h, min);
}

export function daysAgo(n: number, h = 10): Date {
	const d = new Date();
	d.setHours(h, 0, 0, 0);
	d.setDate(d.getDate() - n);
	return d;
}
