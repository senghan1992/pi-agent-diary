import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { sleepSync } from "./util.ts";

const STALE_MS = 30_000;
const TIMEOUT_MS = 10_000;

/**
 * Cross-process mutex built on atomic mkdir. Several agent sessions (pi + Claude Code, or two
 * terminals) may write the same diary at once; read-modify-write paths (decisions, index, STATUS)
 * run under this lock. A lock older than 30 s is treated as abandoned by a crashed process.
 */
export function withLockSync<T>(lockDir: string, fn: () => T): T {
	mkdirSync(dirname(lockDir), { recursive: true });
	const deadline = Date.now() + TIMEOUT_MS;
	while (true) {
		try {
			mkdirSync(lockDir);
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			try {
				if (Date.now() - statSync(lockDir).mtimeMs > STALE_MS) {
					rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue; // released between mkdir and stat
			}
			if (Date.now() > deadline) throw new Error(`agent-diary: timed out waiting for lock ${lockDir}`);
			sleepSync(25);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

/** Non-blocking variant for long jobs (roll-ups): returns false if someone else holds the lock. */
export function tryLock(lockDir: string): boolean {
	mkdirSync(dirname(lockDir), { recursive: true });
	try {
		mkdirSync(lockDir);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		try {
			if (Date.now() - statSync(lockDir).mtimeMs > 30 * 60_000) {
				rmSync(lockDir, { recursive: true, force: true });
				mkdirSync(lockDir);
				return true;
			}
		} catch {
			/* fallthrough */
		}
		return false;
	}
}

export function unlock(lockDir: string): void {
	rmSync(lockDir, { recursive: true, force: true });
}
