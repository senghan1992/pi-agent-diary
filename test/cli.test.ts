import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendEntry, listDigests, loadSession, readTarget } from "../src/core/index.ts";
import { at, config, tmpProject } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/ad.js", import.meta.url));

function ad(cwd: string, args: string[], stdin = "", env: Record<string, string> = {}) {
	const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input: stdin, encoding: "utf8", env: { ...process.env, ...env } });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("ad CLI", () => {
	test("write / read / search / update round trip", () => {
		const root = tmpProject();
		const w = ad(root, ["write", "--json", JSON.stringify({ title: "Vite 마이그레이션", intent: "빌드 90초", decisions: ["vite — 빠름"], tags: ["build"] })]);
		assert.equal(w.code, 0, w.err);
		assert.match(w.out, /Logged to[\s\S]*PROJECT\.md is still a template/);
		const id = w.out.match(/decisions (D[0-9a-z]+)/)?.[1] ?? "";
		assert.match(ad(root, ["read", id]).out, /vite — 빠름[\s\S]*Vite 마이그레이션/);
		assert.match(ad(root, ["search", "빌드가", "느려"]).out, /Vite 마이그레이션/);
		assert.equal(ad(root, ["update", "project", "-"], "# P\n## What & why\nx").code, 0);
		const big = ad(root, ["update", "status", "-"], "가".repeat(3000));
		assert.equal(big.code, 2);
		assert.match(big.err, /rejected/);
		assert.equal(ad(root, ["write", "--json", "{bad"]).code, 1);
	});

	test("Claude Code hooks: session-start, prompt recall, post-tool counting, stop nudge once, ad write clears", () => {
		const root = tmpProject();
		const ev = (o: object) => JSON.stringify({ session_id: "c1", cwd: root, ...o });

		const start = JSON.parse(ad(root, ["hook", "session-start"], ev({})).out);
		assert.equal(start.hookSpecificOutput.hookEventName, "SessionStart");
		assert.match(start.hookSpecificOutput.additionalContext, /No agent diary exists/);

		for (let i = 0; i < 6; i++) {
			assert.equal(ad(root, ["hook", "post-tool"], ev({ tool_name: "Edit", tool_input: { file_path: join(root, `src/a${i}.ts`) } })).code, 0);
		}
		assert.ok(existsSync(join(root, ".ad/PROJECT.md")), "auto-created in git repo");
		assert.equal(loadSession(root, "c1")?.mutations, 6);

		const stop = JSON.parse(ad(root, ["hook", "stop"], ev({ stop_hook_active: false })).out);
		assert.equal(stop.decision, "block");
		assert.match(stop.reason, /6 file change[\s\S]*ad write --json[\s\S]*PROJECT\.md is not written/);
		assert.equal(ad(root, ["hook", "stop"], ev({ stop_hook_active: false })).out, "", "not twice");

		ad(root, ["hook", "post-tool"], ev({ tool_name: "Bash", tool_input: { command: `ad write --json '{"title":"t"}'` } }));
		assert.equal(loadSession(root, "c1")?.recordedMutations, 6, "seeing `ad write` marks the work recorded");

		appendEntry(root, config(), { title: "결제 환불 API 추가", intent: "부분 환불" }, at(2025, 1, 5));
		for (let i = 0; i < 8; i++) appendEntry(root, config(), { title: `other ${i}` }, at(2026, 2, 1 + i));
		const p = ad(root, ["hook", "prompt"], ev({ prompt: "결제 환불이 이상해" }));
		assert.match(JSON.parse(p.out).hookSpecificOutput.additionalContext, /결제 환불 API 추가[\s\S]*/);
		assert.doesNotMatch(p.out, /diary_read/, "CLI wording");
		assert.equal(ad(root, ["hook", "prompt"], ev({ prompt: "결제 환불이 이상해" })).out, "", "not recalled twice");
	});

	test("hooks never fail the agent: bad stdin, outside git, unknown hook", () => {
		const dir = tmpProject(false);
		assert.equal(ad(dir, ["hook", "post-tool"], "{not json").code, 0);
		assert.equal(ad(dir, ["hook", "post-tool"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, "x") } })).code, 0);
		assert.equal(existsSync(join(dir, ".ad")), false, "no auto-create outside git");
		assert.equal(ad(dir, ["hook", "nope"], "{}").code, 0);
	});

	test("compact run with a shell-command summarizer", () => {
		const root = tmpProject();
		const [id] = appendEntry(root, config(), { title: "old work", decisions: ["x — y"] }, at(2025, 3, 3)).decisionIds;
		const script = join(root, "sum.sh");
		writeFileSync(script, `#!/bin/sh\ncat >/dev/null\nprintf 'HEADLINE: March wrap-up\\nPIN: ${id}\\nSUPERSEDE: none\\nDIGEST:\\n## Outcomes\\n- done\\n'\n`, { mode: 0o755 });
		assert.equal(ad(root, ["compact", "run"]).code, 1, "no summarizer → explains how to set one");
		const r = ad(root, ["compact", "run"], "", { AGENT_DIARY_SUMMARIZER: script });
		assert.equal(r.code, 0, r.err + r.out);
		assert.match(r.out, /✓ Rolled up 2025-03/);
		assert.match(readTarget(root, "index"), /📦 March wrap-up/);
		assert.ok(readTarget(root, "decisions").includes(`[${id}] ★`));
	});

	test("doctor and stats", () => {
		const root = tmpProject();
		assert.match(ad(root, ["doctor"]).out, /auto-created on first recorded work/);
		ad(root, ["init"]);
		assert.match(ad(root, ["doctor"]).out, /! PROJECT\.md is still the template/);
		assert.match(ad(root, ["stats"]).out, /session context: ~\d+ \/ 3000/);
	});

	test("Claude Code: with no summarizer configured, roll-ups use `claude -p` from PATH without re-entering hooks", async () => {
		const root = tmpProject();
		appendEntry(root, config(), { title: "old work" }, at(2025, 3, 3));
		const bin = join(root, "fakebin");
		mkdirSync(bin);
		const log = join(root, "claude-args.txt");
		writeFileSync(
			join(bin, "claude"),
			`#!/bin/sh\ncat >/dev/null\necho "$* child=$AGENT_DIARY_CHILD" > ${JSON.stringify(log)}\nprintf 'HEADLINE: March\\nPIN: none\\nSUPERSEDE: none\\nDIGEST:\\n## Outcomes\\n- done\\n'\n`,
			{ mode: 0o755 },
		);
		const env = { PATH: `${bin}:${process.env.PATH}`, AGENT_DIARY_SUMMARIZER: "" };
		const r = ad(root, ["hook", "session-start"], JSON.stringify({ session_id: "c9" }), env);
		assert.doesNotMatch(JSON.parse(r.out).hookSpecificOutput.additionalContext, /Roll-up due/, "handled automatically, not nagged");
		for (let i = 0; i < 100 && !listDigests(root).length; i++) await new Promise((res) => setTimeout(res, 50));
		assert.deepEqual(listDigests(root), ["2025-03"]);
		assert.match(readFileSync(log, "utf8"), /^-p --model haiku child=1/);
	});

	test("recall cache persists across processes and invalidates per changed file", () => {
		const root = tmpProject();
		appendEntry(root, config(), { title: "결제 모듈 환불 API 추가", tags: ["payment"] }, at(2025, 1, 5));
		appendEntry(root, config(), { title: "결제 알림 메일", tags: ["payment"] }, at(2025, 2, 5));
		assert.match(ad(root, ["search", "결제", "환불"]).out, /결제 모듈 환불 API 추가/);
		const cacheFile = join(root, ".ad/.local/recall-cache.json");
		writeFileSync(cacheFile, readFileSync(cacheFile, "utf8").replaceAll("결제 모듈 환불 API 추가", "결제 환불 FROM-CACHE"));
		assert.match(ad(root, ["search", "결제", "환불"]).out, /FROM-CACHE/, "unchanged file served from cache");
		appendEntry(root, config(), { title: "결제 환불 재시도" }, at(2025, 1, 5, 15));
		const out = ad(root, ["search", "결제", "환불"]).out;
		assert.doesNotMatch(out, /FROM-CACHE/, "changed file re-analyzed");
		assert.match(out, /결제 모듈 환불 API 추가/);
		writeFileSync(cacheFile, "{corrupt");
		assert.match(ad(root, ["search", "결제", "환불"]).out, /결제 모듈 환불 API 추가/, "corrupt cache is rebuilt");
	});
});
