import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	appendEntry,
	buildIndexLines,
	commitDigest,
	dayPath,
	refreshIndexIfStale,
	decisionId,
	buildContext,
	diaryPaths,
	ensureDiary,
	estimateTokens,
	grep,
	listUnrecorded,
	loadSession,
	markAllRecorded,
	newSession,
	nudgeDue,
	parseDay,
	parseDecisions,
	readDecisions,
	readTarget,
	resolveRoot,
	saveSession,
	writeCuratedDoc,
} from "../src/core/index.ts";
import { at, config, tmpProject } from "./helpers.ts";

const cfg = config();

describe("layout", () => {
	test("init creates the layout; resolveRoot finds it from a subdirectory", () => {
		const root = tmpProject();
		assert.deepEqual(resolveRoot(root), { root, exists: false, inGit: true });
		ensureDiary(root, "demo");
		for (const f of ["PROJECT.md", "STATUS.md", "decisions.md", "index.md", "config.json", ".gitignore"]) {
			assert.ok(existsSync(join(root, ".ad", f)), f);
		}
		assert.match(readFileSync(join(root, ".ad/.gitignore"), "utf8"), /^\.local\/$/m);
		assert.equal(resolveRoot(join(root, ".ad", "journal")).root, root);
		assert.equal(resolveRoot(join(root, ".ad", "journal")).exists, true);
	});

	test("outside git, the root is cwd and auto-creation is not allowed", () => {
		const dir = tmpProject(false);
		assert.equal(resolveRoot(dir).inGit, false);
	});
});

describe("journal", () => {
	test("entries are appended with tags, numbered decisions and an index line", () => {
		const root = tmpProject();
		const r1 = appendEntry(
			root,
			cfg,
			{ title: "인증 토큰 갱신 경쟁 조건 수정", intent: "로그인이 풀림", done: ["mutex 추가"], decisions: ["mutex 사용 — 단순함 (rejected: queue)"], tags: ["Auth"] },
			at(2026, 11, 6, 14, 32),
		);
		const r2 = appendEntry(root, cfg, { title: "Add tests", done: "unit tests\nintegration tests", tags: ["auth", "test"] }, at(2026, 11, 6, 16));
		assert.ok(r1.ok && r2.ok);
		const [d1] = r1.decisionIds;
		assert.match(d1, /^D[0-9a-z]{5}$/);

		const day = readFileSync(join(root, ".ad/journal/2026-11/2026-11-06.md"), "utf8");
		assert.match(day, /## 14:32 · 인증 토큰/);
		assert.ok(day.includes(`- **Decisions**: [${d1}] mutex 사용`));
		assert.match(day, /  - integration tests/);
		assert.match(day, /- \*\*Tags\*\*: #auth #test/);
		const entries = parseDay(day, "2026-11-06");
		assert.equal(entries.length, 2);
		assert.deepEqual(entries[1].tags, ["auth", "test"]);
		assert.match(readTarget(root, "index"), /\[\[2026-11-06\]\] 인증 토큰 .* \/ Add tests  #auth #test/);
		assert.match(readTarget(root, d1), /From 2026-11-06 14:32 · 인증 토큰/);
		assert.match(readTarget(root, d1.toLowerCase()), /From 2026-11-06 14:32/);
		assert.match(readTarget(root, "nope"), /^Unknown target/);
		assert.ok(grep(root, "MUTEX").length >= 2);
	});

	test("an entry over the per-entry budget is rejected and nothing is written", () => {
		const root = tmpProject();
		const r = appendEntry(root, config({ budgets: { entry: 80 } as any }), { title: "big", done: ["가".repeat(200)] });
		assert.equal(r.ok, false);
		assert.match(r.message, /per-entry budget/);
		assert.equal(existsSync(join(root, ".ad")), false);
	});

	test("an entry without a title is rejected", () => {
		assert.equal(appendEntry(tmpProject(), cfg, { title: " " }).ok, false);
	});

	test("concurrent writers from separate processes lose nothing", async () => {
		const root = tmpProject();
		ensureDiary(root);
		const core = fileURLToPath(new URL("../src/core/index.ts", import.meta.url));
		const script = `import { appendEntry, DEFAULT_CONFIG } from ${JSON.stringify(core)};
for (let i = 0; i < 15; i++) appendEntry(process.argv[2], DEFAULT_CONFIG, { title: "w" + process.argv[3] + "-" + i, decisions: ["d" + i] });`;
		const file = join(root, "writer.mts");
		writeFileSync(file, script);
		const run = (n: number) =>
			new Promise<number>((resolve) => {
				const p = spawn(process.execPath, [file, root, String(n)], { stdio: "inherit" });
				p.on("close", (code) => resolve(code ?? 1));
			});
		const codes = await Promise.all([1, 2, 3, 4].map(run));
		assert.deepEqual(codes, [0, 0, 0, 0]);
		const day = localDay();
		const text = readFileSync(join(root, ".ad/journal", day.slice(0, 7), `${day}.md`), "utf8");
		assert.equal((text.match(/^## /gm) ?? []).length, 60);
		const ids = readDecisions(diaryPaths(root).decisions).map((d) => d.id);
		assert.equal(new Set(ids).size, 60, "every decision got a unique id");
		const line = readTarget(root, "index").split("\n").find((l) => l.startsWith(`- [[${day}]]`)) ?? "";
		const shown = (line.match(/w\d-\d+/g) ?? []).length;
		assert.ok(shown > 0 && line.includes(`(+${60 - shown} more)`), line);
	});

});

function localDay(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("decisions", () => {
	test("supersede and pin by id (case-insensitive, with or without brackets)", () => {
		const root = tmpProject();
		const first = appendEntry(root, cfg, { title: "a", decisions: ["retry in client", "★ store dates as UTC"] }, at(2026, 10, 1));
		const [client, utc] = first.decisionIds;
		assert.match(client, /^D[0-9a-z]{5}$/);
		const r = appendEntry(
			root,
			cfg,
			{ title: "b", decisions: ["retry in server — central", "log as JSON"], supersedes: [`[${client.toUpperCase()}]`], pin: ["Dzzzzz"] },
			at(2026, 10, 2),
		);
		assert.match(r.message, /Unknown decision Dzzzzz/);
		const [server, json] = r.decisionIds;
		appendEntry(root, cfg, { title: "c", pin: [json.slice(1)] }, at(2026, 10, 3));
		const ds = readDecisions(diaryPaths(root).decisions);
		assert.deepEqual(ds.map((d) => d.id), [client, utc, server, json], "file order = chronological order");
		assert.equal(ds[0].supersededBy, server);
		assert.equal(ds[1].pinned, true);
		assert.equal(ds[3].pinned, true);
		assert.equal(ds[0].raw, `- [${client}] ~~2026-10-01 · retry in client~~ → ${server} — [[2026-10-01]]`);
		assert.match(readFileSync(diaryPaths(root).decisions, "utf8"), new RegExp(`- \\[${utc}\\] ★ 2026-10-01 · store dates as UTC`));
	});

	test("ids are stable content hashes; old numeric ids and pre-id lines still parse", () => {
		assert.equal(decisionId("2026-01-01", "x"), decisionId("2026-01-01", "x"));
		assert.notEqual(decisionId("2026-01-01", "x"), decisionId("2026-01-02", "x"));
		const taken = new Set([decisionId("2026-01-01", "x")]);
		assert.notEqual(decisionId("2026-01-01", "x", taken), decisionId("2026-01-01", "x"), "salted on collision");
		const parsed = parseDecisions(
			"# Decisions\n- [D2] ★ 2026-01-01 · a — b — [[2026-01-01]]\n- 2026-01-02 · legacy line — [[2026-01-02]]\n",
		);
		assert.deepEqual(parsed.map((d) => [d.id, d.text, d.pinned]), [
			["D2", "a — b", true],
			[decisionId("2026-01-02", "legacy line", new Set(["D2"])), "legacy line", false],
		]);
	});

	test("duplicate versions of one decision (after a union merge) reconcile", () => {
		const parsed = parseDecisions(
			[
				"- [Dabcde] 2026-01-01 · old wording — [[2026-01-01]]",
				"- [Dfghij] 2026-01-02 · other — [[2026-01-02]]",
				"- [Dabcde] ★ 2026-01-01 · new wording — [[2026-01-01]]",
				"- [Dfghij] ~~2026-01-02 · other~~ → Dklmno — [[2026-01-02]]",
				"- [Dfghij] ★ 2026-01-02 · other — [[2026-01-02]]",
			].join("\n"),
		);
		assert.deepEqual(parsed.map((d) => [d.id, d.text, d.pinned, d.supersededBy]), [
			["Dabcde", "new wording", true, undefined],
			["Dfghij", "other", false, "Dklmno"],
		]);
	});
});

describe("curated docs", () => {
	test("over-budget PROJECT/STATUS is rejected and the old content kept", () => {
		const root = tmpProject();
		const small = config({ budgets: { status: 50 } as any });
		assert.equal(writeCuratedDoc(root, small, "status", "# Status\n- ok").ok, true);
		assert.equal(writeCuratedDoc(root, small, "status", "가".repeat(80)).ok, false);
		assert.equal(writeCuratedDoc(root, small, "status", "  ").ok, false);
		assert.match(readTarget(root, "status"), /- ok/);
	});
});

describe("session bundle", () => {
	test("stays within budget after a year of daily work; pinned decisions always shown", () => {
		const root = tmpProject();
		ensureDiary(root);
		writeCuratedDoc(root, cfg, "project", `# P\n${"- 아키텍처 설명 한 줄\n".repeat(80)}`.slice(0, 1150));
		writeCuratedDoc(root, cfg, "status", `# S\n${"- 진행 상황\n".repeat(60)}`.slice(0, 580));
		const ids: string[] = [];
		for (let i = 0; i < 365; i++) {
			const r = appendEntry(root, cfg, { title: `작업 ${i}: 기능 개선`, done: ["a", "b"], decisions: [`${i === 3 ? "★ " : ""}결정 ${i} — 이유`], tags: ["x"] }, at(2025, 11, 1 + i));
			ids.push(r.decisionIds[0]);
		}
		const b = buildContext(root, cfg, { now: at(2026, 11, 1) });
		assert.ok(b.tokens <= cfg.budgets.context, `context ${b.tokens} > ${cfg.budgets.context}`);
		assert.ok(b.text.includes(`## Pinned decisions\n- [${ids[3]}] ★`));
		assert.match(b.text, /Roll-up due/);
		assert.equal(b.shownDays.length, cfg.recentDays);
		assert.ok(b.shownDecisions.includes(ids[3]) && b.shownDecisions.includes(ids[364]));
		assert.ok(estimateTokens(b.text) === b.tokens);
	});

	test("empty-project bundle explains auto-creation", () => {
		const b = buildContext(tmpProject(), cfg);
		assert.match(b.text, /No agent diary exists/);
	});
});

describe("sessions", () => {
	test("nudge cadence, unrecorded listing, backfill and expiry", () => {
		const root = tmpProject();
		ensureDiary(root);
		const s = newSession("s1", "pi");
		s.mutations = 5;
		assert.equal(nudgeDue(s, cfg), false);
		assert.equal(nudgeDue(s, cfg, true), true, "forced after compaction");
		s.mutations = 6;
		assert.equal(nudgeDue(s, cfg), true);
		s.nudgedAt = 6;
		assert.equal(nudgeDue(s, cfg), false, "not twice for the same work");
		const t = newSession("t", "pi");
		t.mutations = 2;
		t.filesChanged.push("a.ts", "b.ts");
		assert.equal(nudgeDue(t, cfg), true, "multi-file work in few edits");
		t.mutations = 1;
		t.filesChanged = ["a.ts"];
		assert.equal(nudgeDue(t, cfg), false, "a one-line fix is not worth an entry");
		s.prompts.push("로그인 버그 고쳐줘");
		s.filesChanged.push("src/auth.ts");
		saveSession(root, s);

		assert.match(buildContext(root, cfg, { sessionId: "s2" }).text, /without a diary entry[\s\S]*로그인 버그[\s\S]*src\/auth.ts/);
		assert.doesNotMatch(buildContext(root, cfg, { sessionId: "s1" }).text, /without a diary entry/);
		assert.equal(markAllRecorded(root, cfg, "s2"), 1);
		assert.equal(listUnrecorded(root, cfg).length, 0);
		assert.equal(loadSession(root, "s1")?.recordedMutations, 6);

		const old = newSession("old", "pi");
		old.mutations = 1;
		saveSession(root, old);
		assert.equal(listUnrecorded(root, cfg, undefined, new Date(Date.now() + 20 * 86_400_000)).length, 0);
		assert.equal(loadSession(root, "old"), undefined, "expired session files are deleted");
	});
});

describe("timeline index", () => {
	const indexBody = (root: string) => readFileSync(diaryPaths(root).index, "utf8").split("\n").filter((l) => l.startsWith("- [["));

	test("incremental updates produce exactly what a full rebuild would", () => {
		const root = tmpProject();
		for (let i = 0; i < 40; i++) appendEntry(root, cfg, { title: `t${i}`, tags: [i % 2 ? "odd" : "even"] }, at(2026, 1, 1 + (i % 25), 9 + (i % 5)));
		commitDigest(root, cfg, "2026-01", { headline: "January", digest: "## Outcomes\n- x", pin: [], supersede: [] });
		for (let i = 0; i < 10; i++) appendEntry(root, cfg, { title: `feb ${i}` }, at(2026, 2, 1 + i));
		appendEntry(root, cfg, { title: "feb again" }, at(2026, 2, 3, 18));
		assert.deepEqual(indexBody(root), buildIndexLines(root));
		assert.match(indexBody(root).at(-1) ?? "", /\[\[2026-01\]\] 📦 January/);
	});

	test("the bounded timeline equals the head of the full one", () => {
		const root = tmpProject();
		for (let i = 0; i < 30; i++) appendEntry(root, cfg, { title: `d${i}` }, at(2025, 12, 1 + i));
		commitDigest(root, cfg, "2025-12", { headline: "Dec", digest: "## Outcomes\n- x", pin: [], supersede: [] });
		for (let i = 0; i < 3; i++) appendEntry(root, cfg, { title: `j${i}` }, at(2026, 1, 1 + i));
		for (const n of [1, 3, 4, 7, 50]) assert.deepEqual(buildIndexLines(root, n), buildIndexLines(root).slice(0, n), `limit ${n}`);
	});

	test("out-of-step index (deleted day, pulled day) is detected and rebuilt", () => {
		const root = tmpProject();
		for (let i = 1; i <= 5; i++) appendEntry(root, cfg, { title: `day ${i}` }, at(2026, 3, i));
		rmSync(dayPath(root, "2026-03-02"));
		appendEntry(root, cfg, { title: "day 6" }, at(2026, 3, 6));
		assert.deepEqual(indexBody(root), buildIndexLines(root), "deleted day dropped on next write");
		assert.doesNotMatch(indexBody(root).join("\n"), /2026-03-02/);

		assert.equal(refreshIndexIfStale(root), false, "fresh index is left alone");
		mkdirSync(dirname(dayPath(root, "2026-03-09")), { recursive: true });
		writeFileSync(dayPath(root, "2026-03-09"), "---\ndate: 2026-03-09\n---\n# 2026-03-09\n\n## 10:00 · pulled from a teammate\n");
		assert.equal(refreshIndexIfStale(root), true);
		assert.match(indexBody(root)[0], /\[\[2026-03-09\]\] pulled from a teammate/);
		writeFileSync(diaryPaths(root).index, "garbage");
		appendEntry(root, cfg, { title: "day 10" }, at(2026, 3, 10));
		assert.deepEqual(indexBody(root), buildIndexLines(root), "unreadable index is rebuilt");
	});
});
