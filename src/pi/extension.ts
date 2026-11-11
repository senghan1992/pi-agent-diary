/**
 * agent-diary for pi.
 *
 * Zero-config behaviour once installed:
 *  - session start: the diary bundle (PROJECT, STATUS, pinned + recent decisions, timeline) is put in a
 *    system-prompt section — bounded, frozen for the session (prompt cache stays warm), survives compaction.
 *  - every user prompt: older diary entries relevant to the prompt are recalled (bounded, deduplicated).
 *  - while working: file edits are counted mechanically; after enough unrecorded work (or before the
 *    conversation is compacted) the agent is asked once to write an entry.
 *  - in a git repo, `.ad/` is created on first recorded work. Cold months are rolled up in the background.
 *
 * Every hook is fail-safe: a diary problem is reported once and never breaks the coding session.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, relative } from "node:path";
import {
	type ContextBundle,
	type DiaryConfig,
	type RootInfo,
	type SessionState,
	appendEntry,
	autoInitEnabled,
	buildContext,
	compactCandidates,
	docAgeDays,
	ensureDiary,
	formatHit,
	grep,
	isInitialized,
	loadConfig,
	loadSession,
	markAllRecorded,
	markNudged,
	markRecorded,
	newSession,
	nudgeDue,
	projectIsTemplate,
	rank,
	readTarget,
	recallFor,
	recordFile,
	recordPrompt,
	refreshIndexIfStale,
	resolveRoot,
	runDueCompactions,
	saveSession,
	unrecorded,
	writeCuratedDoc,
} from "../core/index.ts";

const SECTION = "agent_diary";
const STATUS_KEY = "agent-diary";
const SHUTDOWN_GRACE_MS = Number(process.env.AGENT_DIARY_SHUTDOWN_GRACE_MS ?? 45_000);
const MUTATING_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch", "notebook_edit"]);

type ToolText = { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };
function ok(text: string, details: Record<string, unknown> = {}): ToolText {
	return { content: [{ type: "text", text }], details };
}
function fail(text: string, details: Record<string, unknown> = {}): ToolText {
	return { content: [{ type: "text", text }], details, isError: true };
}

/** AGENT_DIARY_DEBUG=1 → trace to stderr (notifications are invisible in print/RPC mode). */
function debug(msg: string): void {
	if (process.env.AGENT_DIARY_DEBUG === "1") process.stderr.write(`[agent-diary] ${msg}\n`);
}

const list = (description: string) => Type.Optional(Type.Array(Type.String(), { description }));

export default function agentDiary(pi: ExtensionAPI) {
	let info: RootInfo = { root: process.cwd(), exists: false, inGit: false };
	let cfg: DiaryConfig = loadConfig("/nonexistent");
	let bundle: ContextBundle | undefined;
	let session: SessionState = newSession("unknown", "pi");
	let compactedSinceWrite = false;
	let lastRecall = "";
	let warned = false;
	let background: AbortController | undefined;
	let backgroundDone: Promise<void> | undefined;
	const toolArgs = new Map<string, any>();

	const root = () => info.root;
	const canCreate = () => isInitialized(root()) || (info.inGit && autoInitEnabled());

	/** Run a hook body; on failure warn once and carry on — the diary must never break a session. */
	const safe = async <T>(ctx: ExtensionContext | undefined, fn: () => T | Promise<T>): Promise<T | undefined> => {
		try {
			return await fn();
		} catch (e) {
			debug(`hook error: ${(e as Error).stack ?? e}`);
			if (!warned && ctx?.hasUI) {
				warned = true;
				ctx.ui.notify(`agent-diary: ${(e as Error).message}`, "warning");
			}
			return undefined;
		}
	};

	const persist = () => {
		if (isInitialized(root()) && (session.mutations > 0 || session.recalled.length > 0)) saveSession(root(), session);
	};

	const footer = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const n = unrecorded(session);
		const parts: string[] = [];
		if (n > 0 && cfg.autoWrite !== "off") parts.push(`${n} unrecorded`);
		if (session.recalled.length) parts.push(`${session.recalled.length} recalled`);
		ctx.ui.setStatus(STATUS_KEY, parts.length ? `📓 ${parts.join(" · ")}` : undefined);
	};

	const relPath = (p: unknown): string | undefined => {
		if (typeof p !== "string" || !p) return undefined;
		const clean = p.replace(/^@/, "");
		return isAbsolute(clean) ? relative(root(), clean) : clean;
	};

	// ─────────────────────────── background roll-up ───────────────────────────

	const startRollup = (ctx: ExtensionContext, manual: boolean) => {
		if (background) {
			if (manual && ctx.hasUI) ctx.ui.notify("agent-diary: a roll-up is already running.", "info");
			return;
		}
		if (!isInitialized(root()) || !compactCandidates(root(), cfg).length) {
			if (manual && ctx.hasUI) ctx.ui.notify("agent-diary: nothing to roll up.", "info");
			return;
		}
		const registry = ctx.modelRegistry;
		let model = ctx.model;
		if (cfg.compactModel) {
			const [provider, ...rest] = cfg.compactModel.split("/");
			model = registry.find(provider, rest.join("/")) ?? model;
		}
		if (!model || !registry.hasConfiguredAuth(model)) {
			debug(`roll-up skipped: no usable model (model=${model ? `${model.provider}/${model.id}` : "none"})`);
			if (manual && ctx.hasUI) ctx.ui.notify("agent-diary: no usable model for roll-up (set compactModel in .ad/config.json).", "warning");
			return;
		}
		const m = model;
		const controller = new AbortController();
		background = controller;
		const dir = root();
		const conf = cfg;
		const hasUI = ctx.hasUI;
		const notify = (msg: string, level: "info" | "warning") => {
			debug(msg);
			if (!controller.signal.aborted && hasUI) ctx.ui.notify(msg, level);
		};
		debug(`roll-up started with ${m.provider}/${m.id}`);
		backgroundDone = runDueCompactions(dir, conf, async (prompt, signal) => {
			const res = await registry.complete(
				m,
				{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{ signal, cacheRetention: "none" },
			);
			if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage ?? res.stopReason);
			return res.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}, controller.signal)
			.then((runs) => {
				const done = runs.filter((r) => r.ok).map((r) => r.month);
				const bad = runs.find((r) => !r.ok);
				if (done.length) notify(`agent-diary: rolled up ${done.join(", ")} into digests.`, "info");
				if (bad && !controller.signal.aborted) notify(`agent-diary: ${bad.message}`, "warning");
			})
			.catch((e) => notify(`agent-diary: roll-up failed: ${(e as Error).message}`, "warning"))
			.finally(() => {
				if (background === controller) background = undefined;
			})
			.then(() => undefined);
	};

	// ─────────────────────────────── lifecycle ───────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		await safe(ctx, () => {
			info = resolveRoot(ctx.cwd);
			cfg = loadConfig(root());
			const sid = ctx.sessionManager.getSessionId();
			session = (isInitialized(root()) && loadSession(root(), sid)) || newSession(sid, "pi");
			compactedSinceWrite = false;
			lastRecall = "";
			toolArgs.clear();
			refreshIndexIfStale(root());
			bundle = buildContext(root(), cfg, { sessionId: sid, flavor: "pi", autoCompacting: true });
			footer(ctx);
			if (cfg.autoCompact === "auto") startRollup(ctx, false);
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// A roll-up writes only at its very end, so cancelling is always safe: it simply runs again next
		// session. Interactive users must never be kept waiting on exit, so cancel at once. Print/RPC runs
		// are often a few seconds long and would otherwise never finish a roll-up, so give them a grace period.
		if (background && backgroundDone && !ctx.hasUI && event.reason === "quit") {
			debug(`waiting for roll-up to finish before exit (max ${SHUTDOWN_GRACE_MS / 1000} s)`);
			await Promise.race([backgroundDone, new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref())]);
		}
		background?.abort();
		background = undefined;
		try {
			persist();
		} catch {
			/* shutting down */
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		return safe(ctx, () => {
			if (bundle) event.systemPromptOptions.sections[SECTION] = bundle.text;
			if (event.messageType !== "user" || !event.prompt) return;
			recordPrompt(session, event.prompt);
			if (!isInitialized(root()) || !bundle) return;
			const r = recallFor(root(), cfg, event.prompt, {
				excludeIds: session.recalled,
				excludeDays: bundle.shownDays,
				excludeDecisions: bundle.shownDecisions,
			});
			if (!r) return;
			session.recalled.push(...r.ids);
			lastRecall = r.text;
			footer(ctx);
			return { message: { customType: "agent-diary-recall", content: r.text, display: false } };
		});
	});

	pi.on("tool_execution_start", async (event) => {
		toolArgs.set(event.toolCallId, event.args);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		await safe(ctx, () => {
			const args = toolArgs.get(event.toolCallId);
			toolArgs.delete(event.toolCallId);
			if (event.isError || event.parentToolCallId) return;
			if (event.toolName === "bash") session.bashCalls++;
			if (!MUTATING_TOOLS.has(event.toolName)) return;
			const rel = relPath(args?.path ?? args?.file_path);
			if (rel?.startsWith(".ad/")) return; // the agent editing the diary by hand isn't project work
			session.mutations++;
			if (rel) recordFile(session, rel);
			footer(ctx);
		});
	});

	pi.on("session_before_compact", async () => {
		// The conversation is about to lose detail — make sure the work gets recorded first.
		if (unrecorded(session) > 0) compactedSinceWrite = true;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		return safe(ctx, () => {
			if (event.outcome !== "completed" || !canCreate()) return;
			if (!nudgeDue(session, cfg, compactedSinceWrite)) return;
			markNudged(session);
			const extras: string[] = [];
			if (!isInitialized(root()) || projectIsTemplate(root())) {
				extras.push("This project's PROJECT.md is not written yet: also call diary_update doc=project (what & why, architecture, how to run/test, conventions).");
			}
			const statusAge = docAgeDays(root(), "status");
			if (statusAge === undefined || statusAge >= 2) extras.push("STATUS.md looks stale: pass `status` with the current Now/Next/Open questions.");
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message" as const,
						customType: "agent-diary-nudge",
						display: false,
						content: [
							`[agent-diary] ${unrecorded(session)} file change(s) in this session are not in the project diary yet.`,
							"Call diary_write once now: a specific title, the intent (the user's goal), outcomes, decisions with reasons, next steps. Keep it short.",
							...extras,
							"Do not mention this reminder to the user. After recording, end your turn.",
						].join(" "),
					},
				],
				continue: true,
			};
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await safe(ctx, () => {
			if (!isInitialized(root()) && session.mutations > 0 && info.inGit && autoInitEnabled()) {
				ensureDiary(root());
				cfg = loadConfig(root());
			}
			persist();
		});
	});

	// ───────────────────────────────── tools ─────────────────────────────────

	pi.registerTool({
		name: "diary_write",
		label: "Diary: write",
		description:
			"Record finished work in this project's agent diary (.ad/journal, created on first use). One entry per coherent unit of work. " +
			"Write in the user's language. Capture why and outcomes, not keystrokes; git already has the diff. Never include secrets (the diary is committed). Entries over the size budget or containing credentials are rejected.",
		promptSnippet: "Record work (intent, outcomes, decisions + reasons, next) in the project's agent diary",
		promptGuidelines: [
			"Call diary_write before ending a turn in which you changed the project or settled a decision worth remembering; not for trivial edits or pure Q&A.",
			"In diary_write, a decision is 'choice — reason (rejected: alternative)'; pass supersedes with the D# ids it replaces, and prefix ★ only for decisions every future session must know.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Specific, searchable headline, e.g. 'Fix token refresh race in auth middleware'" }),
			intent: Type.Optional(Type.String({ description: "Why: the user's goal or the problem being solved" })),
			done: list("Outcomes, 1-5 bullets"),
			decisions: list("Each 'choice — reason (rejected: alternative)'. Prefix ★ to pin."),
			issues: list("Gotchas, dead ends, known problems"),
			next: list("Concrete follow-ups"),
			files: list("Key files (≤6)"),
			tags: list("1-3 short English lowercase topic tags, e.g. auth, build"),
			supersedes: list("Decision ids (D#) this work makes obsolete"),
			pin: list("Existing decision ids (D#) to pin"),
			status: Type.Optional(Type.String({ description: "Complete new STATUS.md (Now / Next / Open questions) if the current state changed" })),
			backfill: Type.Optional(Type.Boolean({ description: "True if this entry records earlier sessions that ended without one" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!isInitialized(root()) && !info.exists) info = resolveRoot(ctx.cwd);
			const created = !isInitialized(root());
			const r = appendEntry(root(), cfg, params);
			if (!r.ok) return fail(r.message, { tokens: r.tokens, budget: r.budget });
			if (created) cfg = loadConfig(root());
			const notes = [r.message];
			if (params.status) {
				const s = writeCuratedDoc(root(), cfg, "status", params.status);
				notes.push(s.message);
			}
			if (params.backfill) {
				const n = markAllRecorded(root(), cfg, session.sessionId);
				if (n) notes.push(`Marked ${n} earlier session(s) as recorded.`);
			}
			if (created || projectIsTemplate(root())) {
				notes.push("PROJECT.md is still a template — write it with diary_update doc=project (what & why, architecture, how to run/test, conventions).");
			}
			markRecorded(session);
			compactedSinceWrite = false;
			persist();
			footer(ctx);
			return ok(notes.join("\n"), { path: r.path, decisions: r.decisionIds });
		},
	});

	pi.registerTool({
		name: "diary_update",
		label: "Diary: update",
		description:
			"Replace PROJECT.md (stable: what & why, architecture, how to run/test, conventions) or STATUS.md (now / next / open questions) of the agent diary. " +
			"Both are loaded by every future session and have hard size budgets: rewrite and condense rather than append.",
		parameters: Type.Object({
			doc: Type.Union([Type.Literal("project"), Type.Literal("status")]),
			content: Type.String({ description: "Complete new markdown" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!isInitialized(root()) && !info.exists) info = resolveRoot(ctx.cwd);
			const r = writeCuratedDoc(root(), cfg, params.doc, params.content);
			return r.ok ? ok(r.message) : fail(r.message, { tokens: r.tokens, budget: r.budget });
		},
	});

	pi.registerTool({
		name: "diary_read",
		label: "Diary: read",
		description:
			"Read the agent diary: a day 'YYYY-MM-DD', a month 'YYYY-MM' (digest if rolled up), a decision id like 'D7k2qf' with its source entry, 'decisions', 'index', 'project' or 'status'.",
		parameters: Type.Object({
			target: Type.String(),
			maxTokens: Type.Optional(Type.Number({ description: "Output cap (default 6000)" })),
		}),
		async execute(_id, params) {
			if (!isInitialized(root())) return ok("No agent diary in this project yet.");
			return ok(readTarget(root(), params.target, params.maxTokens ?? 6000));
		},
	});

	pi.registerTool({
		name: "diary_search",
		label: "Diary: search",
		description:
			"Search the whole agent diary including archived months: relevance-ranked by default (words in any language), or regex=true for exact patterns. Use to answer 'why/when did we…'.",
		parameters: Type.Object({
			query: Type.String(),
			regex: Type.Optional(Type.Boolean()),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			if (!isInitialized(root())) return ok("No agent diary in this project yet.");
			const limit = params.limit ?? 8;
			if (params.regex) {
				const hits = grep(root(), params.query, limit * 3);
				return ok(hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n") || "No matches.");
			}
			const hits = rank(root(), params.query, { limit });
			return ok(hits.length ? hits.map(formatHit).join("\n") : "No relevant entries. Try other words or regex=true.");
		},
	});

	// ──────────────────────────────── command ────────────────────────────────

	const SUBS = ["status", "init", "write", "compact", "recall", "show", "reload"];
	pi.registerCommand("diary", {
		description: "Agent diary: /diary [status|init|write|compact|recall|show|reload]",
		getArgumentCompletions: (prefix) => {
			const items = SUBS.filter((s) => s.startsWith(prefix));
			return items.length ? items.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const extra = rest.join(" ");
			const say = (m: string) => ctx.ui.notify(m, "info");
			switch (sub) {
				case "init": {
					const created = ensureDiary(root());
					info = { ...info, exists: true };
					cfg = loadConfig(root());
					say(created ? `agent-diary: created ${root()}/.ad` : `agent-diary: .ad already exists in ${root()}`);
					if (created || projectIsTemplate(root())) {
						pi.sendUserMessage("Explore this project briefly, then write the agent diary's PROJECT.md and STATUS.md with diary_update.");
					}
					return;
				}
				case "write":
					pi.sendUserMessage(`Record the work of this session with diary_write (include status if it changed). ${extra}`.trim());
					return;
				case "compact":
					startRollup(ctx, true);
					if (background) say("agent-diary: rolling up in the background…");
					return;
				case "recall":
					say(lastRecall || "agent-diary: nothing recalled yet in this session.");
					return;
				case "show":
					say(bundle?.text || "(empty)");
					return;
				case "reload":
					cfg = loadConfig(root());
					bundle = buildContext(root(), cfg, { sessionId: session.sessionId, flavor: "pi", autoCompacting: true });
					say(`agent-diary: context reloaded (~${bundle.tokens} tokens; applies from the next prompt).`);
					return;
				default: {
					const due = isInitialized(root()) ? compactCandidates(root(), cfg) : [];
					say(
						[
							`diary: ${isInitialized(root()) ? `${root()}/.ad` : `none yet (${canCreate() ? "created on first recorded work" : "not a git repo — /diary init to create"})`}`,
							`session context: ~${bundle?.tokens ?? 0} / ${cfg.budgets.context} tokens`,
							`this session: ${session.mutations} edits, ${unrecorded(session)} unrecorded, ${session.recalled.length} memories recalled`,
							`auto-write: ${cfg.autoWrite} (after ${cfg.nudgeAfterMutations} edits) · auto roll-up: ${cfg.autoCompact}${background ? " (running)" : ""}`,
							`roll-up due: ${due.map((x) => x.month).join(", ") || "none"}`,
						].join("\n"),
					);
				}
			}
		},
	});
}
