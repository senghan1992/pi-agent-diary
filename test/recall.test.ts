import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appendEntry, estimateTokens, rank, recallFor, terms } from "../src/core/index.ts";
import { at, config, tmpProject } from "./helpers.ts";

const cfg = config();

function seeded(): string {
	const root = tmpProject();
	const e = (d: Date, title: string, extra: Record<string, unknown> = {}) => appendEntry(root, cfg, { title, ...extra }, d);
	e(at(2026, 6, 3), "결제 모듈 환불 API 추가", { intent: "부분 환불 지원", done: ["refund endpoint"], tags: ["payment"] });
	e(at(2026, 6, 20), "인증 토큰 갱신 경쟁 조건 수정", {
		intent: "동시 요청 시 로그인이 풀리는 문제",
		decisions: ["토큰 갱신에 mutex 사용 — 단순함 (rejected: 요청 큐)"],
		tags: ["auth"],
	});
	e(at(2026, 7, 2), "Migrate build to Vite", { intent: "webpack builds took 90s", done: ["vite config", "dropped babel"], tags: ["build"] });
	e(at(2026, 7, 15), "Add rate limiting to public API", { decisions: ["token bucket per API key — fair under bursts"], tags: ["api"] });
	for (let i = 0; i < 20; i++) e(at(2026, 8, 1 + i), `UI polish round ${i}`, { done: ["spacing", "colors"], tags: ["ui"] });
	return root;
}

describe("terms", () => {
	test("Hangul bigrams make particles irrelevant; Latin words are split and stemmed", () => {
		assert.ok(terms("인증을 고쳐줘").includes("인증"));
		assert.ok(terms("인증이 풀림").includes("인증"));
		assert.deepEqual(terms("확인해줘"), [], "request phrasing is noise");
		assert.deepEqual(terms("tokenRefresh handlers"), ["token", "refresh", "handler"]);
		assert.deepEqual(terms("the and of 7"), []);
	});
});

describe("rank", () => {
	test("Korean prompt with different particles finds the old auth entry and its decision", () => {
		const root = seeded();
		const hits = rank(root, "로그인이 자꾸 풀려요. 인증 토큰 쪽 확인해줘", { now: at(2026, 11, 1) });
		assert.ok(hits.length > 0);
		assert.equal(hits[0].title, "인증 토큰 갱신 경쟁 조건 수정");
		assert.match(hits[0].snippet, /mutex/, "snippet carries the decision");
		assert.ok(!hits.some((h) => h.kind === "decision"), "decision not repeated next to its entry");
	});

	test("English prompt finds the build entry; snippet carries the intent", () => {
		const root = seeded();
		const [top] = rank(root, "why are we on vite instead of webpack?", { now: at(2026, 11, 1) });
		assert.equal(top.title, "Migrate build to Vite");
		assert.match(top.snippet, /webpack builds took 90s/);
	});

	test("exclusions remove already shown items", () => {
		const root = seeded();
		const q = "rate limiting api key bucket";
		const all = rank(root, q, { now: at(2026, 11, 1) });
		assert.equal(all[0]?.day, "2026-07-15");
		const rest = rank(root, q, { excludeIds: [all[0].id], now: at(2026, 11, 1) });
		assert.ok(!rest.some((h) => h.id === all[0].id));
		const dec = rest.find((h) => h.kind === "decision");
		assert.ok(dec && /token bucket/.test(dec.title), "once its entry is excluded, the decision can surface");
		const none = rank(root, q, { excludeDays: ["2026-07-15"], excludeDecisions: [dec.ref], now: at(2026, 11, 1) });
		assert.ok(!none.some((h) => h.day === "2026-07-15" || h.ref === dec.ref));
	});
});

describe("recallFor", () => {
	test("stays silent for unrelated prompts", () => {
		const root = seeded();
		assert.equal(recallFor(root, cfg, "README 오타 하나 고쳐줘"), undefined);
		assert.equal(recallFor(root, cfg, "hello"), undefined);
		assert.equal(recallFor(root, cfg, ""), undefined);
	});

	test("returns bounded, formatted memories for related prompts", () => {
		const root = seeded();
		const r = recallFor(root, cfg, "결제 환불 기능에 버그가 있어");
		assert.ok(r);
		assert.match(r.text, /\[2026-06-03\] 결제 모듈 환불 API 추가/);
		assert.ok(estimateTokens(r.text) <= cfg.budgets.recall);
		const tiny = recallFor(root, config({ budgets: { recall: 60 } as any }), "결제 환불 기능에 버그가 있어");
		assert.equal(tiny, undefined, "nothing fits → nothing injected");
	});

	test("disabled by config", () => {
		assert.equal(recallFor(seeded(), config({ recall: { enabled: false } as any }), "결제 환불"), undefined);
	});
});
