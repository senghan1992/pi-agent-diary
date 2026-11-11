import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	appendEntry,
	chunkMonth,
	commitDigest,
	compactCandidates,
	diaryPaths,
	grep,
	parseDigestReply,
	readDecisions,
	readTarget,
	runCompaction,
	runDueCompactions,
} from "../src/core/index.ts";
import { at, config, tmpProject } from "./helpers.ts";

const cfg = config();
const now = at(2026, 11, 6);

let CLIENT = "";
let SERVER = "";
function seeded(): string {
	const root = tmpProject();
	CLIENT = appendEntry(root, cfg, { title: "Sept A", done: ["x"], decisions: ["retry in client"] }, at(2026, 9, 3)).decisionIds[0];
	SERVER = appendEntry(root, cfg, { title: "Sept B", done: ["y"], decisions: ["retry in server — central"] }, at(2026, 9, 20)).decisionIds[0];
	appendEntry(root, cfg, { title: "Nov work", done: ["z"] }, at(2026, 11, 5));
	return root;
}

/** The model's reply; ids may come back in any case. */
const replyFor = (pin: string, supersede: string) => `HEADLINE: Sept: moved retries server-side
PIN: ${pin}
SUPERSEDE: ${supersede}, D99
DIGEST:
## Goals
- reliability
## Outcomes
- A, B shipped`;
const reply = replyFor("D2", "D1");

describe("parseDigestReply", () => {
	test("parses the structured reply, tolerating code fences and 'none'", () => {
		const d = parseDigestReply(`\`\`\`\n${reply}\n\`\`\``);
		assert.equal(d.headline, "Sept: moved retries server-side");
		assert.deepEqual(d.pin, ["D2"]);
		assert.deepEqual(d.supersede, ["D1", "D99"]);
		assert.match(d.digest, /^## Goals/);
		assert.deepEqual(parseDigestReply("HEADLINE: h\nPIN: none\nSUPERSEDE: none\nDIGEST:\nbody").pin, []);
		assert.equal(parseDigestReply("just some text").digest, "just some text", "free-form reply still usable");
	});
});

describe("commitDigest", () => {
	test("writes the digest, archives days, applies pin/supersede limited to that month", () => {
		const root = seeded();
		assert.deepEqual(compactCandidates(root, cfg, now).map((c) => c.month), ["2026-09"]);
		assert.equal(commitDigest(root, cfg, "2026-09", { headline: "h", digest: "x".repeat(10_000), pin: [], supersede: [] }).ok, false);

		const r = commitDigest(root, cfg, "2026-09", parseDigestReply(replyFor(SERVER.toUpperCase(), CLIENT)));
		assert.ok(r.ok, r.message);
		assert.ok(existsSync(join(root, ".ad/archive/2026-09/2026-09-03.md")));
		assert.ok(!existsSync(join(root, ".ad/journal/2026-09")));
		assert.match(readTarget(root, "index"), /\[\[2026-11-05\]\] Nov work[\s\S]*\[\[2026-09\]\] 📦 Sept: moved retries server-side/);
		assert.match(readTarget(root, "2026-09-03"), /Sept A/, "archived day still readable");
		assert.ok(grep(root, "Sept B").length > 0, "archived day still searchable");
		const ds = readDecisions(diaryPaths(root).decisions);
		assert.equal(ds.find((d) => d.id === CLIENT)?.supersededBy, "2026-09");
		assert.equal(ds.find((d) => d.id === SERVER)?.pinned, true);
		assert.equal(compactCandidates(root, cfg, now).length, 0);
		assert.equal(commitDigest(root, cfg, "2026-09", parseDigestReply(reply)).ok, false, "second commit refused");
	});
});

describe("runCompaction", () => {
	test("single chunk → one call", async () => {
		const root = seeded();
		const prompts: string[] = [];
		const r = await runCompaction(root, cfg, "2026-09", async (p) => {
			prompts.push(p);
			return reply;
		});
		assert.ok(r.ok, r.message);
		assert.equal(r.calls, 1);
		assert.ok(prompts[0].includes(`[${CLIENT}] 2026-09-03 · retry in client`));
		assert.match(prompts[0], /Sept A[\s\S]*Sept B/);
	});

	test("a big month is map-reduced: every entry reaches a notes call, nothing truncated", async () => {
		const root = tmpProject();
		for (let d = 1; d <= 30; d++) {
			for (let k = 0; k < 4; k++) {
				appendEntry(root, cfg, { title: `Aug ${d}.${k}`, done: [`${"detail ".repeat(40)}`] }, at(2026, 8, d, 9 + k));
			}
		}
		const chunks = chunkMonth(root, "2026-08", 9000);
		assert.ok(chunks.length > 1);
		const seen = new Set<string>();
		let notesCalls = 0;
		const r = await runCompaction(root, cfg, "2026-08", async (p) => {
			if (p.includes("<entries>") && p.startsWith("You are condensing")) {
				notesCalls++;
				for (const m of p.matchAll(/· (Aug \d+\.\d)/g)) seen.add(m[1]);
				return "- notes";
			}
			assert.match(p, /<notes>/);
			return reply;
		});
		assert.ok(r.ok, r.message);
		assert.equal(notesCalls, chunks.length);
		assert.equal(seen.size, 120);
		assert.equal(r.calls, chunks.length + 1);
	});

	test("an oversize digest is retried once, then shortened; failures leave the journal intact", async () => {
		const root = seeded();
		let calls = 0;
		const r = await runCompaction(root, cfg, "2026-09", async () => {
			calls++;
			return `HEADLINE: h\nDIGEST:\n${"- long line of words\n".repeat(400)}`;
		});
		assert.ok(r.ok, r.message);
		assert.equal(calls, 2);

		const root2 = seeded();
		const bad = await runCompaction(root2, cfg, "2026-09", async () => {
			throw new Error("rate limited");
		});
		assert.equal(bad.ok, false);
		assert.match(bad.message, /rate limited/);
		assert.ok(existsSync(join(root2, ".ad/journal/2026-09/2026-09-03.md")));
		assert.ok(!existsSync(diaryPaths(root2).compactLock), "lock released");
	});

	test("runDueCompactions processes due months oldest first", async () => {
		const root = seeded();
		appendEntry(root, cfg, { title: "Aug" }, at(2026, 8, 10));
		const runs = await runDueCompactions(root, cfg, async () => reply, undefined, now);
		assert.deepEqual(runs.map((r) => [r.month, r.ok]), [
			["2026-08", true],
			["2026-09", true],
		]);
	});
});
