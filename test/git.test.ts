import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { appendEntry, diaryPaths, ensureDiary, readDecisions, readTarget } from "../src/core/index.ts";
import { at, config, tmpProject } from "./helpers.ts";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const cfg = config();

function git(cwd: string, ...args: string[]) {
	const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
	return { code: r.status, out: r.stdout + r.stderr };
}

describe("sharing .ad through git", { skip: !hasGit && "git not installed" }, () => {
	test("two branches writing the same day merge without conflicts; decision states reconcile", () => {
		const root = tmpProject(false);
		git(root, "init", "-q");
		ensureDiary(root);
		const base = appendEntry(root, cfg, { title: "base", decisions: ["retry in client"] }, at(2026, 11, 2));
		const old = base.decisionIds[0];
		assert.equal(git(root, "add", "-A").code, 0);
		git(root, "commit", "-qm", "base");
		const tracked = git(root, "ls-files", ".ad").out;
		assert.doesNotMatch(tracked, /index\.md/, "generated timeline is not committed");
		assert.doesNotMatch(tracked, /\.local/);

		git(root, "checkout", "-qb", "a");
		const a = appendEntry(root, cfg, { title: "branch A work", decisions: ["use vite"] }, at(2026, 11, 3, 10));
		git(root, "commit", "-qam", "a");
		git(root, "add", "-A");
		git(root, "commit", "-qm", "a2");

		git(root, "checkout", "-q", "main");
		const b = appendEntry(root, cfg, { title: "branch B work", decisions: ["★ retry in server — central"], supersedes: [old] }, at(2026, 11, 3, 11));
		git(root, "add", "-A");
		git(root, "commit", "-qm", "b");

		const m = git(root, "merge", "-q", "--no-edit", "a");
		assert.equal(m.code, 0, m.out);
		assert.doesNotMatch(readFileSync(join(root, ".ad/journal/2026-11/2026-11-03.md"), "utf8"), /^(<<<<<<<|>>>>>>>)/m);

		const day = readTarget(root, "2026-11-03");
		assert.match(day, /branch A work/);
		assert.match(day, /branch B work/);
		const ds = readDecisions(diaryPaths(root).decisions);
		const ids = ds.map((d) => d.id);
		assert.equal(new Set(ids).size, ids.length, "no duplicate ids after union merge");
		assert.ok(ids.includes(a.decisionIds[0]) && ids.includes(b.decisionIds[0]));
		assert.equal(ds.find((d) => d.id === old)?.supersededBy, b.decisionIds[0], "supersede survives the merge");
		assert.equal(ds.find((d) => d.id === b.decisionIds[0])?.pinned, true);
		assert.match(readTarget(root, "index"), /branch A work.*branch B work|branch B work.*branch A work/);
	});
});
