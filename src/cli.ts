/**
 * `ad` — agent-diary CLI. Same `.ad/` format and behaviour as the pi extension, for agents that
 * offer hooks + a shell instead of custom tools (Claude Code, Codex, …), and for humans.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import {
	type DiaryConfig,
	type DiaryEntry,
	type Summarize,
	appendEntry,
	autoInitEnabled,
	buildContext,
	chunkMonth,
	commitDigest,
	compactCandidates,
	docAgeDays,
	ensureDiary,
	estimateTokens,
	formatHit,
	grep,
	isInitialized,
	listUnrecorded,
	loadConfig,
	loadSession,
	markAllRecorded,
	markNudged,
	markRecorded,
	newSession,
	nudgeDue,
	parseDigestReply,
	projectIsTemplate,
	rank,
	readCuratedDoc,
	readTarget,
	rebuildIndex,
	recallFor,
	recordFile,
	recordPrompt,
	refreshIndexIfStale,
	resolveRoot,
	runCompaction,
	runDueCompactions,
	saveSession,
	unrecorded,
	writeCuratedDoc,
} from "./core/index.ts";

const VERSION = "0.3.0";

const USAGE = `ad ${VERSION} — agent diary: coding agents keep project memory in .ad/

Usage
  ad init                               create .ad/ in the project root
  ad context [--hook]                   print the session-start bundle
  ad write --json '<entry>'|-  [--backfill]
        entry: {title, intent?, done?, decisions?, issues?, next?, files?, tags?, supersedes?, pin?, status?}
  ad update project|status <file|->     replace PROJECT.md / STATUS.md (budget-checked)
  ad read <YYYY-MM-DD|YYYY-MM|D#|index|decisions|project|status>
  ad search <words…> [--regex] [--limit N]
  ad compact run [YYYY-MM] [--summarizer "<cmd>"]   roll up due months via a summarizer command
  ad compact plan [YYYY-MM]             print a month in chunks for manual summarizing
  ad compact commit <YYYY-MM> <reply-file|->        commit a HEADLINE/PIN/SUPERSEDE/DIGEST reply
  ad stats | ad doctor | ad reindex
  ad hook <session-start|prompt|post-tool|stop>     Claude Code hook handlers (event JSON on stdin)

Global: --cwd <dir>   Env: AGENT_DIARY_AUTO_INIT=0, AGENT_DIARY_SUMMARIZER="<cmd>"`;

// ───────────────────────────── helpers ─────────────────────────────

function takeFlag(args: string[], name: string): boolean {
	const i = args.indexOf(name);
	if (i < 0) return false;
	args.splice(i, 1);
	return true;
}

function takeOpt(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
}

function stdin(): string {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function input(src: string): string {
	return src === "-" ? stdin() : readFileSync(src, "utf8");
}

function die(msg: string, code = 1): never {
	process.stderr.write(`ad: ${msg}\n`);
	process.exit(code);
}

/** Default roll-up summarizer inside Claude Code: its own CLI with a small model, if it is on PATH. */
export const CLAUDE_CODE_SUMMARIZER = "claude -p --model haiku";

function onPath(bin: string): boolean {
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
	return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && exts.some((e) => existsSync(join(dir, bin + e))));
}

/** Summarizer for hooks: explicit config first, else Claude Code's own CLI (AGENT_DIARY_SUMMARIZER=none disables). */
function hookSummarizer(cfg: DiaryConfig): string | undefined {
	const explicit = summarizerCommand(cfg);
	if (explicit) return explicit === "none" ? undefined : explicit;
	return onPath("claude") ? CLAUDE_CODE_SUMMARIZER : undefined;
}

function summarizerCommand(cfg: DiaryConfig, flag?: string): string | undefined {
	return flag ?? process.env.AGENT_DIARY_SUMMARIZER ?? cfg.summarizer;
}

/** A summarizer backed by a shell command: prompt on stdin, answer on stdout. */
function commandSummarizer(cmd: string, cwd: string): Summarize {
	return (prompt, signal) =>
		new Promise((resolve, reject) => {
			const child = spawn(cmd, {
				shell: true,
				cwd,
				signal,
				env: { ...process.env, AGENT_DIARY_CHILD: "1" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let out = "";
			let err = "";
			const timer = setTimeout(() => child.kill("SIGTERM"), 5 * 60_000);
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (err += d));
			child.on("error", reject);
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0 && out.trim()) resolve(out);
				else reject(new Error(`summarizer "${cmd}" exited ${code}: ${err.trim().slice(0, 300)}`));
			});
			child.stdin.end(prompt);
		});
}

function hookOut(event: string, additionalContext: string): void {
	process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } })}\n`);
}

const AD_WRITE = /(^|[\s;&|(])(\S*\/)?ad\s+write\b/;
const MUTATING = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// ───────────────────────────── main ─────────────────────────────

async function main(argv: string[]): Promise<void> {
	const args = [...argv];
	const cwd = takeOpt(args, "--cwd") ?? process.cwd();
	const info = resolveRoot(cwd);
	const root = info.root;
	const cfg = loadConfig(root);
	const [cmd, ...rest] = args;

	switch (cmd) {
		case "init":
			console.log(ensureDiary(root) ? `created ${root}/.ad` : `${root}/.ad already exists`);
			return;

		case "context": {
			const hook = takeFlag(rest, "--hook");
			const b = buildContext(root, cfg, { flavor: "cli" });
			const text = `<agent_diary>\n${b.text}\n</agent_diary>`;
			if (hook) hookOut("SessionStart", text);
			else console.log(text);
			return;
		}

		case "write": {
			const backfill = takeFlag(rest, "--backfill");
			const json = takeOpt(rest, "--json");
			if (!json) die("usage: ad write --json '<entry>' (or --json - to read stdin)");
			let entry: DiaryEntry & { status?: string };
			try {
				entry = JSON.parse(json === "-" ? stdin() : json);
			} catch (e) {
				die(`invalid JSON: ${(e as Error).message}`);
			}
			const created = !isInitialized(root);
			const r = appendEntry(root, cfg, entry);
			if (!r.ok) die(r.message, 2);
			console.log(r.message);
			const c = loadConfig(root);
			if (entry.status) console.log(writeCuratedDoc(root, c, "status", entry.status).message);
			if (backfill) console.log(`marked ${markAllRecorded(root, c)} earlier session(s) as recorded`);
			if (created || projectIsTemplate(root)) console.log("PROJECT.md is still a template — write it: ad update project -");
			return;
		}

		case "update": {
			const [doc, src] = rest;
			if ((doc !== "project" && doc !== "status") || !src) die("usage: ad update project|status <file|->");
			const r = writeCuratedDoc(root, cfg, doc, input(src));
			if (!r.ok) die(r.message, 2);
			console.log(r.message);
			return;
		}

		case "read":
			if (!isInitialized(root)) die("no .ad/ here (ad init)");
			console.log(readTarget(root, rest[0] ?? "index"));
			return;

		case "search": {
			const regex = takeFlag(rest, "--regex");
			const limit = Number(takeOpt(rest, "--limit") ?? 8);
			const q = rest.join(" ");
			if (!q) die("usage: ad search <words…> [--regex]");
			if (!isInitialized(root)) die("no .ad/ here (ad init)");
			if (regex) console.log(grep(root, q, limit * 3).map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n") || "no matches");
			else console.log(rank(root, q, { limit }).map(formatHit).join("\n") || "no relevant entries");
			return;
		}

		case "compact": {
			const sub = rest.shift();
			const summarizer = summarizerCommand(cfg, takeOpt(rest, "--summarizer"));
			if (sub === "run") {
				const month = rest[0];
				if (!summarizer) die('no summarizer: pass --summarizer "<cmd>", set AGENT_DIARY_SUMMARIZER, or "summarizer" in .ad/config.json (e.g. "claude -p --model haiku")');
				const fn = commandSummarizer(summarizer, root);
				const runs = month ? [await runCompaction(root, cfg, month, fn)] : await runDueCompactions(root, cfg, fn);
				if (!runs.length) console.log(`nothing to roll up (hotDays=${cfg.hotDays})`);
				for (const r of runs) console.log(`${r.ok ? "✓" : "✗"} ${r.message} (${r.calls} call(s))`);
				if (runs.some((r) => !r.ok)) process.exitCode = 2;
				return;
			}
			if (sub === "plan") {
				const due = compactCandidates(root, cfg);
				const month = rest[0] ?? due[0]?.month;
				if (!month) {
					console.log(`nothing to roll up (hotDays=${cfg.hotDays})`);
					return;
				}
				const chunks = chunkMonth(root, month);
				console.log(`due: ${due.map((c) => `${c.month} (${c.days}d, ~${c.tokens}tok)`).join(", ") || "none"}`);
				console.log(`Summarize ${month} (${chunks.length} chunk(s)). Reply with:\nHEADLINE: …\nPIN: D#,… | none\nSUPERSEDE: D#,… | none\nDIGEST:\n## Goals / ## Outcomes / ## Key decisions / ## Lessons / ## Unresolved  (≤ ${cfg.budgets.digest} tokens)\nthen: ad compact commit ${month} <reply-file|->`);
				chunks.forEach((c, i) => console.log(`\n=== chunk ${i + 1}/${chunks.length} ===\n${c}`));
				return;
			}
			if (sub === "commit") {
				const [month, src] = rest;
				if (!month || !src) die("usage: ad compact commit <YYYY-MM> <reply-file|->");
				const r = commitDigest(root, cfg, month, parseDigestReply(input(src)));
				if (!r.ok) die(r.message, 2);
				console.log(r.message);
				return;
			}
			die("usage: ad compact run|plan|commit");
		}

		case "reindex":
			rebuildIndex(root);
			console.log("index rebuilt");
			return;

		case "stats": {
			if (!isInitialized(root)) {
				console.log(`no diary (would be ${root}/.ad)`);
				return;
			}
			const b = buildContext(root, cfg, { flavor: "cli" });
			console.log(
				[
					`diary: ${root}/.ad`,
					`session context: ~${b.tokens} / ${cfg.budgets.context} tokens`,
					`PROJECT ~${estimateTokens(readCuratedDoc(root, "project"))}/${cfg.budgets.project} · STATUS ~${estimateTokens(readCuratedDoc(root, "status"))}/${cfg.budgets.status} tokens`,
					`roll-up due: ${compactCandidates(root, cfg).map((x) => x.month).join(", ") || "none"}`,
					`unrecorded sessions: ${listUnrecorded(root, cfg).length}`,
				].join("\n"),
			);
			return;
		}

		case "doctor": {
			const lines: string[] = [];
			const check = (good: boolean, msg: string) => lines.push(`${good ? "✓" : "!"} ${msg}`);
			const [maj, min] = process.versions.node.split(".").map(Number);
			check(maj > 22 || (maj === 22 && min >= 18), `node ${process.versions.node} (need ≥ 22.18 to run from source)`);
			check(isInitialized(root), isInitialized(root) ? `diary at ${root}/.ad` : `no diary yet at ${root}/.ad (${info.inGit && autoInitEnabled() ? "auto-created on first recorded work" : "run: ad init"})`);
			if (isInitialized(root)) {
				check(!projectIsTemplate(root), projectIsTemplate(root) ? "PROJECT.md is still the template" : "PROJECT.md written");
				const age = docAgeDays(root, "status");
				check(age !== undefined && age < 14, `STATUS.md last updated ${age ?? "?"} day(s) ago`);
				const b = buildContext(root, cfg, { flavor: "cli" });
				check(b.tokens <= cfg.budgets.context, `session context ~${b.tokens}/${cfg.budgets.context} tokens`);
				const due = compactCandidates(root, cfg);
				const sum = summarizerCommand(cfg) ?? (onPath("claude") ? `${CLAUDE_CODE_SUMMARIZER} (default inside Claude Code)` : undefined);
				check(!due.length || !!sum, due.length ? `roll-up due: ${due.map((d) => d.month).join(", ")}${sum ? ` (summarizer: ${sum})` : " — no summarizer configured for the CLI"}` : "no roll-up due");
				const un = listUnrecorded(root, cfg);
				check(!un.length, `${un.length} session(s) with unrecorded work`);
				const tracked = spawnSync("git", ["ls-files", "--error-unmatch", ".ad/index.md"], { cwd: root, stdio: "ignore" }).status === 0;
				check(!tracked, tracked ? "index.md is committed (it is generated and will conflict) — run: git rm --cached .ad/index.md" : "generated files are not committed");
			}
			console.log(lines.join("\n"));
			return;
		}

		case "hook":
			await hook(rest[0], root, info.inGit, cfg);
			return;

		case "-v":
		case "--version":
			console.log(VERSION);
			return;

		default:
			console.log(USAGE);
			if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
	}
}

/**
 * Claude Code hooks. Each reads the event JSON on stdin. They must be fast and must never fail the
 * agent's turn, so every error is swallowed (exit 0, no output).
 */
async function hook(kind: string | undefined, root: string, inGit: boolean, cfg: DiaryConfig): Promise<void> {
	if (process.env.AGENT_DIARY_CHILD === "1") return; // summarizer subprocesses: stay out of the way
	let ev: any = {};
	try {
		ev = JSON.parse(stdin() || "{}");
	} catch {
		return;
	}
	const sid = String(ev.session_id ?? "unknown");
	const state = () => loadSession(root, sid) ?? newSession(sid, "claude-code");

	switch (kind) {
		case "session-start": {
			const sum = hookSummarizer(cfg);
			refreshIndexIfStale(root);
			const b = buildContext(root, cfg, { sessionId: sid, flavor: "cli", autoCompacting: !!sum });
			hookOut("SessionStart", `<agent_diary>\n${b.text}\n</agent_diary>`);
			if (cfg.autoCompact === "auto" && sum && isInitialized(root) && compactCandidates(root, cfg).length) {
				// Detached so the session starts immediately; AGENT_DIARY_CHILD keeps the summarizer's own
				// Claude Code session from re-entering these hooks.
				const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "compact", "run", "--cwd", root, "--summarizer", sum], {
					detached: true,
					stdio: "ignore",
					env: { ...process.env, AGENT_DIARY_CHILD: "1" },
				});
				child.unref();
			}
			return;
		}
		case "prompt": {
			if (!isInitialized(root)) return;
			const s = state();
			const prompt = String(ev.prompt ?? "");
			recordPrompt(s, prompt);
			const b = buildContext(root, cfg, { sessionId: sid, flavor: "cli" });
			const r = recallFor(root, cfg, prompt, { excludeIds: s.recalled, excludeDays: b.shownDays, excludeDecisions: b.shownDecisions });
			if (r) {
				s.recalled.push(...r.ids);
				hookOut("UserPromptSubmit", `<agent_diary_recall>\n${r.text.replace("diary_read", "ad read")}\n</agent_diary_recall>`);
			}
			saveSession(root, s);
			return;
		}
		case "post-tool": {
			const tool = String(ev.tool_name ?? "");
			if (tool === "Bash") {
				if (!isInitialized(root)) return;
				const s = state();
				s.bashCalls++;
				if (AD_WRITE.test(String(ev.tool_input?.command ?? ""))) markRecorded(s);
				saveSession(root, s);
				return;
			}
			if (!MUTATING.has(tool)) return;
			const f = ev.tool_input?.file_path ?? ev.tool_input?.notebook_path;
			const rel = typeof f === "string" ? relative(root, f) : "";
			if (rel.startsWith(".ad")) return;
			if (!isInitialized(root)) {
				if (!inGit || !autoInitEnabled()) return;
				ensureDiary(root);
			}
			const s = state();
			s.mutations++;
			recordFile(s, rel);
			saveSession(root, s);
			return;
		}
		case "stop": {
			if (ev.stop_hook_active || !isInitialized(root)) return;
			const c = loadConfig(root);
			const s = loadSession(root, sid);
			if (!s || !nudgeDue(s, c)) return;
			markNudged(s);
			saveSession(root, s);
			const extras: string[] = [];
			if (projectIsTemplate(root)) extras.push("PROJECT.md is not written yet: also run `ad update project -` with what & why, architecture, how to run/test, conventions.");
			const age = docAgeDays(root, "status");
			if (age === undefined || age >= 2) extras.push('STATUS.md looks stale: include "status" (Now / Next / Open questions).');
			process.stdout.write(
				`${JSON.stringify({
					decision: "block",
					reason: [
						`[agent-diary] ${unrecorded(s)} file change(s) are not in the project diary yet.`,
						`Record one concise entry: ad write --json '{"title":"…","intent":"…","done":["…"],"decisions":["choice — reason"],"next":["…"],"tags":["…"]}' (see the agent-diary skill).`,
						...extras,
						"Do not mention this reminder. Then stop.",
					].join(" "),
				})}\n`,
			);
			return;
		}
	}
}

const argv = process.argv.slice(2);
if (argv[0] === "hook") {
	main(argv).catch(() => process.exit(0));
} else {
	main(argv).catch((e) => die((e as Error).message));
}
