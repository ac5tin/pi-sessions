import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createSessionAutocompleteProvider, formatSessionItem } from "./autocomplete.ts";
import { cacheDir, loadConfig, sessionsRoot, type Config } from "./config.ts";
import { buildDigest } from "./digest.ts";
import { collectGitInfo } from "./git-info.ts";
import { extractReferences, referenceToken, resolveReference, sortRecent } from "./reference.ts";
import { SessionStore } from "./store.ts";
import { getSummary, type StreamFn, type SummaryResult } from "./summary.ts";
import { createSessionReadTool } from "./tool.ts";
import type { IndexedSession, SessionMessage } from "./types.ts";

const MESSAGE_TYPE = "pi-sessions-reference";
const STATUS_KEY = "pi-sessions";

function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => {
			return !!block && typeof block === "object" && (block as { type?: string }).type === "text";
		})
		.map((block) => block.text)
		.join("\n");
}

/**
 * Module scope on purpose: the tool and event callbacks outlive the handler that
 * created them. `config` is one object mutated in place, so those closures always
 * read the live values after a config reload.
 */
const config: Config = loadConfig();
let currentCtx: ExtensionContext | undefined;
let store = new SessionStore({ root: sessionsRoot(), extraRoots: config.extraRoots });

async function readMessages(session: IndexedSession): Promise<SessionMessage[]> {
	const manager = SessionManager.open(session.path);
	// SAFETY: pi's AgentMessage carries the same role/content/toolName shape this module reads;
	// only the nominal block types differ, and every consumer reads those blocks structurally.
	return manager.buildSessionContext().messages as unknown as SessionMessage[];
}

async function summarizeWithModel(
	ctx: ExtensionContext | undefined,
	session: IndexedSession,
	messages: SessionMessage[],
): Promise<SummaryResult> {
	if (!ctx) return { error: "no active session context for the summary" };
	const model = config.summaryModel
		? (ctx.modelRegistry
				.getAvailable()
				.find((candidate) => `${candidate.provider}/${candidate.id}` === config.summaryModel) ?? ctx.model)
		: ctx.model;
	if (!model) return { error: "no model available for the summary" };

	const stream: StreamFn = async (prompt, signal) => {
		const completion = await ctx.modelRegistry.complete(
			model,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{ signal },
		);
		return messageText(completion);
	};

	return getSummary(
		session,
		messages,
		{ stream, cacheDir: cacheDir(), modelId: `${model.provider}/${model.id}` },
		config.summaryTimeoutMs,
	);
}

export default function (pi: ExtensionAPI): void {
	const git = (cwd: string) => collectGitInfo(cwd, (command, args, options) => pi.exec(command, args, options));

	pi.on("session_start", async (_event, ctx) => {
		Object.assign(config, loadConfig());
		store = new SessionStore({ root: sessionsRoot(), extraRoots: config.extraRoots });
		currentCtx = ctx;
		void store.refresh();
		ctx.ui.addAutocompleteProvider((current) =>
			createSessionAutocompleteProvider(current, {
				sessions: () =>
					store.visible(config, { cwd: ctx.cwd, sessionPath: ctx.sessionManager.getSessionFile() }),
				all: () => store.all(),
				now: () => Date.now(),
			}),
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		currentCtx = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerTool(
		createSessionReadTool({
			config,
			sessions: () => store.all(),
			readMessages,
			git,
			summary: (session, messages) => summarizeWithModel(currentCtx, session, messages),
			now: () => Date.now(),
		}),
	);

	pi.on("before_agent_start", async (event, ctx) => {
		const refs = extractReferences(event.prompt).slice(0, config.maxReferences);
		if (refs.length === 0) return;

		await store.refresh();
		// Resolve against every indexed session, never the filtered dropdown list:
		// an explicit reference must still reach a hidden or unnamed session.
		const indexed = store.all();

		const resolved: Array<{ session: IndexedSession; messages: SessionMessage[] }> = [];
		const notes: string[] = [];
		for (const ref of refs) {
			const resolution = resolveReference(ref, indexed);
			if (resolution.kind === "found") {
				resolved.push({ session: resolution.session, messages: await readMessages(resolution.session) });
			} else if (resolution.kind === "ambiguous") {
				const choices = sortRecent(resolution.candidates)
					.slice(0, 5)
					.map((candidate) => `${referenceToken(candidate, resolution.candidates)} (${candidate.cwd})`)
					.join("; ");
				notes.push(`#${ref} is ambiguous. Candidates: ${choices}`);
			} else {
				notes.push(`#${ref} matched no session.`);
			}
		}

		// A prompt whose tokens all miss is ordinary text (`#42` for an issue): leave it
		// byte-identical. Notes for unknown or ambiguous tokens only ride along with a
		// digest that did resolve.
		if (resolved.length === 0) return;

		const summaries = await Promise.all(
			resolved.map(async (entry) => {
				if (config.summaryMode === "off") {
					return { session: entry.session, messages: entry.messages, result: null };
				}
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `summarizing ${entry.session.name ?? entry.session.id}…`);
				const result = await summarizeWithModel(ctx, entry.session, entry.messages);
				return { session: entry.session, messages: entry.messages, result };
			}),
		);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);

		const blocks: string[] = [];
		for (const entry of summaries) {
			const gitInfo = await git(entry.session.cwd);
			const result = entry.result;
			const summaryText = result && "text" in result ? result.text : null;
			const summaryNote =
				result && "error" in result
					? result.error
					: config.summaryMode === "off"
						? "summaries are disabled in pi-sessions config"
						: null;
			blocks.push(
				buildDigest(entry.session, entry.messages, { git: gitInfo, summary: summaryText, summaryNote }, config, Date.now()),
			);
		}
		if (notes.length > 0) blocks.push(notes.join("\n"));

		return {
			message: {
				customType: MESSAGE_TYPE,
				content: blocks.join("\n\n"),
				display: true,
			},
		};
	});

	pi.registerCommand("sessions", {
		description: "Browse pi sessions from every repository and insert a #reference",
		handler: async (_args, ctx) => {
			await store.refresh();
			const sessions = store.visible(config, {
				cwd: ctx.cwd,
				sessionPath: ctx.sessionManager.getSessionFile(),
			});
			if (sessions.length === 0) {
				ctx.ui.notify("pi-sessions: no sessions found", "warning");
				return;
			}
			const now = Date.now();
			const universe = store.all();
			const items = sessions.map((session) => {
				const item = formatSessionItem(session, universe, now);
				return { label: `${item.label} — ${item.description}`, session };
			});
			const picked = await ctx.ui.select("Insert a session reference", items.map((item) => item.label));
			if (!picked) return;
			const chosen = items.find((item) => item.label === picked);
			if (!chosen) return;
			const token = referenceToken(chosen.session, universe);
			ctx.ui.setEditorText(`${ctx.ui.getEditorText()} ${token}`.trim());
			ctx.ui.notify(`pi-sessions: inserted ${token}`, "info");
		},
	});

	pi.registerCommand("pi-sessions", {
		description: "Show pi-sessions index statistics and reload config",
		handler: async (_args, ctx) => {
			Object.assign(config, loadConfig());
			const parsed = await store.refresh();
			const visible = store.visible(config, {
				cwd: ctx.cwd,
				sessionPath: ctx.sessionManager.getSessionFile(),
			});
			ctx.ui.notify(
				`pi-sessions: ${store.size} indexed, ${visible.length} visible across ${new Set(visible.map((s) => s.cwd)).size} repos (${parsed} re-parsed)`,
				"info",
			);
		},
	});

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const names = [...content.matchAll(/<referenced-session name="([^"]+)"/g)].map((match) => match[1]);
		const header = theme.fg("accent", `↩ referenced sessions: ${names.join(", ") || "(none)"}`);
		if (!options.expanded) return new Text(header, options.outputPad, 0);
		return new Text(`${header}\n${theme.fg("dim", content)}`, options.outputPad, 0);
	});
}