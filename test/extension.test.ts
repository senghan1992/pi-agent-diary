import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import agentDiary from "../src/pi/extension.ts";
import { appendEntry, ensureDiary, listDigests, loadSession, readTarget, writeCuratedDoc } from "../src/core/index.ts";
import { at, config, tmpProject } from "./helpers.ts";

/** Minimal stand-in for pi's ExtensionAPI: records handlers/tools and lets tests fire events. */
interface HarnessOptions {
	hasUI?: boolean;
	/** Fake model call for background roll-ups. */
	complete?: (prompt: string, signal?: AbortSignal) => Promise<string>;
}

function harness(cwd: string, sessionId = "sess-1", opts: HarnessOptions = {}) {
	const handlers = new Map<string, ((e: any, ctx: any) => any)[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sent: string[] = [];
	const notes: string[] = [];
	const status = new Map<string, string | undefined>();
	const pi: any = {
		on: (name: string, h: any) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, c: any) => commands.set(n, c),
		sendUserMessage: (m: string) => sent.push(m),
	};
	const ctx: any = {
		cwd,
		hasUI: opts.hasUI ?? true,
		ui: { notify: (m: string) => notes.push(m), setStatus: (k: string, v?: string) => status.set(k, v) },
		sessionManager: { getSessionId: () => sessionId },
		model: opts.complete ? { provider: "fake", id: "m" } : undefined,
		modelRegistry: {
			find: () => undefined,
			hasConfiguredAuth: () => !!opts.complete,
			complete: async (_m: unknown, c: any, o: any) => ({
				stopReason: "stop",
				content: [{ type: "text", text: await opts.complete!(c.messages[0].content[0].text, o?.signal) }],
			}),
		},
	};
	agentDiary(pi);
	const fire = async (name: string, event: any = {}) => {
		let last: any;
		for (const h of handlers.get(name) ?? []) last = await h({ type: name, ...event }, ctx);
		return last;
	};
	const call = (name: string, params: any) => tools.get(name).execute("id", params, undefined, undefined, ctx);
	let n = 0;
	const edit = async (path: string, isError = false) => {
		const id = `t${++n}`;
		await fire("tool_execution_start", { toolCallId: id, toolName: "edit", args: { path } });
		await fire("tool_execution_end", { toolCallId: id, toolName: "edit", isError, result: {} });
	};
	const prompt = async (text: string) => {
		const options = { sections: {} as Record<string, string> };
		const r = await fire("before_agent_start", { messageType: "user", prompt: text, systemPrompt: "", systemPromptOptions: options });
		return { section: options.sections.agent_diary, result: r };
	};
	const settle = () => fire("agent_before_settle", { entries: [], continue: false, outcome: "completed", context: {} });
	return { fire, call, edit, prompt, settle, tools, commands, sent, notes, status, ctx };
}

describe("pi extension", () => {
	test("registers the tools and the /diary command", () => {
		const h = harness(tmpProject());
		assert.deepEqual([...h.tools.keys()].sort(), ["diary_read", "diary_search", "diary_update", "diary_write"]);
		assert.ok(h.commands.has("diary"));
	});

	test("fresh git repo: injects bootstrap text, nudges after edits, auto-creates .ad, write records and clears", async () => {
		const root = tmpProject();
		const h = harness(root);
		await h.fire("session_start", { reason: "startup" });
		const { section } = await h.prompt("로그인 버그 고쳐줘");
		assert.match(section, /No agent diary exists/);

		for (let i = 0; i < 5; i++) await h.edit(join(root, "src/f0.ts"));
		assert.equal(await h.settle(), undefined, "5 edits to one file → no nudge yet");
		await h.edit(join(root, "src/f5.ts"));
		await h.edit(join(root, "src/f6.ts"), true);
		const nudge = await h.settle();
		assert.equal(nudge.continue, true);
		assert.match(nudge.entries[0].content, /6 file change\(s\)[\s\S]*PROJECT\.md is not written/);
		assert.equal(await h.settle(), undefined, "only once for the same work");

		await h.fire("agent_settled", { aborted: false });
		assert.ok(existsSync(join(root, ".ad/PROJECT.md")), "auto-created after real work");
		const s = loadSession(root, "sess-1");
		assert.equal(s?.mutations, 6);
		assert.deepEqual(s?.filesChanged, ["src/f0.ts", "src/f5.ts"]);
		assert.deepEqual(s?.prompts, ["로그인 버그 고쳐줘"]);

		const r = await h.call("diary_write", { title: "로그인 버그 수정", intent: "세션 만료", decisions: ["mutex — 단순함"], status: "# Status\n## Now\n- fixed" });
		assert.ok(!r.isError, r.content[0].text);
		assert.match(r.content[0].text, /Logged to \.ad\/journal[\s\S]*STATUS\.md updated[\s\S]*PROJECT\.md is still a template/);
		assert.equal(loadSession(root, "sess-1")?.recordedMutations, 6);
		assert.equal(h.status.get("agent-diary"), undefined, "footer cleared");
	});

	test("outside git nothing is auto-created and no nudge fires", async () => {
		const dir = tmpProject(false);
		const h = harness(dir);
		await h.fire("session_start", { reason: "startup" });
		await h.prompt("hi");
		for (let i = 0; i < 10; i++) await h.edit(join(dir, `f${i}`));
		assert.equal(await h.settle(), undefined);
		await h.fire("agent_settled", { aborted: false });
		assert.equal(existsSync(join(dir, ".ad")), false);
	});

	test("edits to .ad/ itself don't count as project work", async () => {
		const root = tmpProject();
		ensureDiary(root);
		const h = harness(root);
		await h.fire("session_start", { reason: "startup" });
		await h.prompt("x");
		for (let i = 0; i < 10; i++) await h.edit(join(root, ".ad/STATUS.md"));
		assert.equal(await h.settle(), undefined);
	});

	test("forced nudge before conversation compaction", async () => {
		const root = tmpProject();
		ensureDiary(root);
		const h = harness(root);
		await h.fire("session_start", { reason: "startup" });
		await h.prompt("x");
		await h.edit(join(root, "a.ts"));
		await h.fire("session_before_compact", { reason: "threshold" });
		assert.equal((await h.settle())?.continue, true);
	});

	test("existing diary: bundle is frozen for the session; relevant old memories are recalled once", async () => {
		const root = tmpProject();
		const cfg = config();
		writeCuratedDoc(root, cfg, "project", "# Shop\n## What & why\nAn online shop.");
		appendEntry(root, cfg, { title: "결제 모듈 환불 API 추가", intent: "부분 환불 지원", tags: ["payment"] }, at(2025, 3, 3));
		for (let i = 0; i < 10; i++) appendEntry(root, cfg, { title: `UI polish ${i}`, tags: ["ui"] }, at(2026, 1, 1 + i));

		const h = harness(root);
		await h.fire("session_start", { reason: "startup" });
		const first = await h.prompt("결제 환불이 두 번 처리되는 버그가 있어");
		assert.match(first.section, /# Shop[\s\S]*An online shop/);
		assert.match(first.result.message.content, /결제 모듈 환불 API 추가/);
		assert.equal(first.result.message.display, false);

		appendEntry(root, cfg, { title: "written meanwhile" });
		const second = await h.prompt("결제 환불 다시 봐줘");
		assert.equal(second.section, first.section, "frozen → prompt cache stays warm");
		assert.equal(second.result, undefined, "same memory not recalled twice");
		assert.equal((await h.prompt("README 오타")).result, undefined);
	});

	test("tool errors are reported as isError, not thrown", async () => {
		const root = tmpProject();
		const h = harness(root);
		await h.fire("session_start", { reason: "startup" });
		const r = await h.call("diary_write", { title: "x", done: ["가".repeat(2000)] });
		assert.equal(r.isError, true);
		assert.match(r.content[0].text, /per-entry budget/);
		const u = await h.call("diary_update", { doc: "status", content: "가".repeat(2000) });
		assert.equal(u.isError, true);
	});

	test("a broken diary never breaks the session", async () => {
		const root = tmpProject();
		ensureDiary(root);
		writeFileSync(join(root, ".ad/config.json"), "{ not json");
		const h = harness(root);
		await h.fire("session_start", { reason: "startup" });
		const { section } = await h.prompt("x");
		assert.ok(section, "falls back to defaults");
		assert.equal(readTarget(root, "nope").startsWith("Unknown target"), true);
	});

	test("/diary write and /diary init send prompts", async () => {
		const root = tmpProject();
		const h = harness(root);
		await h.fire("session_start", { reason: "startup" });
		await h.commands.get("diary").handler("init", h.ctx);
		assert.ok(existsSync(join(root, ".ad/PROJECT.md")));
		assert.match(h.sent[0], /PROJECT\.md and STATUS\.md/);
		await h.commands.get("diary").handler("write 결제 위주로", h.ctx);
		assert.match(h.sent[1], /diary_write.*결제 위주로/);
		await h.commands.get("diary").handler("", h.ctx);
		assert.match(h.notes.at(-1) ?? "", /session context: ~\d+ \/ 3000 tokens/);
	});

	describe("background roll-up", () => {
		const due = () => {
			const root = tmpProject();
			appendEntry(root, config(), { title: "old" }, at(2025, 1, 5));
			return root;
		};
		const REPLY = "HEADLINE: Jan\nPIN: none\nSUPERSEDE: none\nDIGEST:\n## Outcomes\n- x";

		test("runs at session start and writes a digest", async () => {
			const root = due();
			const h = harness(root, "s", { complete: async () => REPLY });
			await h.fire("session_start", { reason: "startup" });
			await new Promise((r) => setTimeout(r, 100));
			assert.deepEqual(listDigests(root), ["2025-01"]);
		});

		test("interactive exit never waits for it; print mode gets a grace period", async () => {
			const hang = (_p: string, signal?: AbortSignal) =>
				new Promise<string>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
			const root = due();
			const ui = harness(root, "s1", { hasUI: true, complete: hang });
			await ui.fire("session_start", { reason: "startup" });
			let t = Date.now();
			await ui.fire("session_shutdown", { reason: "quit" });
			assert.ok(Date.now() - t < 500, "interactive quit is immediate");
			assert.deepEqual(listDigests(root), [], "cancelled roll-up wrote nothing");
			await new Promise((r) => setTimeout(r, 20)); // let the cancelled run release its lock

			let finish!: () => void;
			const slow = () => new Promise<string>((resolve) => (finish = () => resolve(REPLY)));
			const print = harness(root, "s2", { hasUI: false, complete: slow });
			await print.fire("session_start", { reason: "startup" });
			t = Date.now();
			setTimeout(() => finish(), 300);
			await print.fire("session_shutdown", { reason: "quit" });
			assert.ok(Date.now() - t >= 250, "print mode waited for the roll-up");
			assert.deepEqual(listDigests(root), ["2025-01"]);
		});
	});
});
