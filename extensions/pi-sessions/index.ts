import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createSessionAutocompleteProvider, formatSessionItem, pickerRows } from "./autocomplete.ts";
import { cacheDir, loadConfig, sessionsRoot, type Config } from "./config.ts";
import { buildDigest, neutralizeAttribute } from "./digest.ts";
import { collectGitInfo } from "./git-info.ts";
import { extractReferences, referenceToken, resolveReference, sortRecent } from "./reference.ts";
import { SessionStore } from "./store.ts";
import { getSummary, type StreamFn, type SummaryResult } from "./summary.ts";
import { createSessionReadTool } from "./tool.ts";
import type { IndexedSession, SessionMessage } from "./types.ts";

const MESSAGE_TYPE = "pi-sessions-reference";
const STATUS_KEY = "pi-sessions";

/** Braille spinner frames, same style as the Working indicator. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;

function stopSpinner(): void {
	if (spinnerTimer !== undefined) {
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}
}

/**
 * Footer status alone is a small third footer line, easy to miss while the
 * blocking summary runs. Mirror the same text as an animated widget above the
 * editor so the load is visible in the main view from the first await onward.
 * Every clear path funnels through here, so the timer cannot leak.
 */
function showLoading(ctx: ExtensionContext, text: string | undefined): void {
	if (!ctx.hasUI) return;
	stopSpinner();
	ctx.ui.setStatus(STATUS_KEY, text);
	if (text === undefined) {
		ctx.ui.setWidget(STATUS_KEY, undefined, { placement: "aboveEditor" });
		return;
	}
	let frame = 0;
	const paint = (index: number): void => {
		ctx.ui.setWidget(STATUS_KEY, [`${SPINNER_FRAMES[index]} ${text}`], { placement: "aboveEditor" });
	};
	paint(0);
	spinnerTimer = setInterval(() => {
		frame = (frame + 1) % SPINNER_FRAMES.length;
		paint(frame);
	}, SPINNER_MS);
	if (typeof spinnerTimer.unref === "function") spinnerTimer.unref();
}
/**
 * How stale the session index may be before the dropdown or the tool refreshes it. Another
 * agent can rename or create a session at any moment, so a store built at session_start is
 * not good enough to answer "which sessions exist" — that is how a `/name` in one agent
 * stayed invisible to the `#` dropdown in another.
 */
const AUTO_REFRESH_MS = 2_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Compact byte count for the diagnostic line. */
function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/** A token that looks like a session reference rather than an issue number or a bare word. */
function isSessionShaped(ref: string): boolean {
	return ref.includes("-") || ref.includes("/");
}

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

/** True when the file's last byte is a newline. One byte, not the whole file. */
async function endsWithNewline(path: string): Promise<boolean> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		if (size === 0) return false;
		const last = Buffer.alloc(1);
		await handle.read(last, 0, 1, size - 1);
		return last[0] === 0x0a;
	} finally {
		await handle.close();
	}
}

function openMessages(path: string): SessionMessage[] {
	const manager = SessionManager.open(path);
	// SAFETY: pi's AgentMessage carries the same role/content/toolName shape this module reads;
	// only the nominal block types differ, and every consumer reads those blocks structurally.
	return manager.buildSessionContext().messages as unknown as SessionMessage[];
}

async function readMessages(session: IndexedSession): Promise<SessionMessage[]> {
	// pi repairs a file whose last line is partial by appending a newline when it opens it
	// (session-manager.js loadEntriesFromFile). Referencing a session that another agent is
	// still writing would then split its in-flight line, so open a copy instead. The index
	// caps files at MAX_FILE_BYTES, so the copy is bounded.
	if (await endsWithNewline(session.path)) return openMessages(session.path);
	const dir = await mkdtemp(join(tmpdir(), "pi-sessions-open-"));
	try {
		const copy = join(dir, "session.jsonl");
		await writeFile(copy, await readFile(session.path));
		return openMessages(copy);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
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
			// sessionId is not decoration: pi-ai's opencode provider turns it into the
			// x-opencode-session routing header and the API rejects a request without it.
			// pi's own turn loop passes it; a bare { signal } returned an empty message.
			{ signal, sessionId: ctx.sessionManager.getSessionId() },
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
				refresh: () => store.refreshIfStale(AUTO_REFRESH_MS),
				now: () => Date.now(),
			}),
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		currentCtx = undefined;
		showLoading(ctx, undefined);
	});

	pi.registerTool(
		createSessionReadTool({
			config,
			sessions: () => store.all(),
			refresh: () => store.refreshIfStale(AUTO_REFRESH_MS),
			readMessages,
			git,
			summary: (session, messages) => summarizeWithModel(currentCtx, session, messages),
			now: () => Date.now(),
		}),
	);

	pi.on("before_agent_start", async (event, ctx) => {
		const all = extractReferences(event.prompt);
		const refs = all.slice(0, config.maxReferences);
		if (refs.length === 0) return;

		{
			const labels = refs.map((ref) => `#${neutralizeAttribute(ref)}`).join(", ");
			showLoading(ctx, `pi-sessions: loading ${labels}…`);
		}
		try {
			await store.refresh();
		} catch (error) {
			showLoading(ctx, undefined);
			throw error;
		}
		// Resolve against every indexed session, never the filtered dropdown list:
		// an explicit reference must still reach a hidden or unnamed session.
		const indexed = store.all();

		const resolved: Array<{ session: IndexedSession; messages: SessionMessage[] }> = [];
		const notes: string[] = [];
		// A session-shaped token that reaches no session is otherwise silent: nothing is injected
		// and the model gets no note. Tell the user, once per prompt, so a dead root or a
		// double-indexed root is visible on the day it breaks.
		const missed: string[] = [];
		// A token that resolved and then failed to read is the other silent class: it is never
		// `missed`, so without its own record the note below is built and then discarded.
		const readFailures: string[] = [];
		for (const ref of refs) {
			const label = `#${neutralizeAttribute(ref)}`;
			const resolution = resolveReference(ref, indexed);
			if (resolution.kind === "found") {
				// One unreadable file must not discard the messages already read for the other
				// references: turn the failure into a note for this reference only.
				try {
					resolved.push({ session: resolution.session, messages: await readMessages(resolution.session) });
				} catch (error) {
					notes.push(`${label} could not be read: ${neutralizeAttribute(errorMessage(error))}`);
					readFailures.push(`${label} could not be read`);
				}
				continue;
			}
			if (resolution.kind === "ambiguous") {
				// `indexed` is the full index; `resolution.candidates` is a subset, so a token built
				// from it can be ambiguous against a session outside the subset and lead nowhere.
				const choices = sortRecent(resolution.candidates)
					.slice(0, 5)
					.map(
						(candidate) =>
							`${neutralizeAttribute(referenceToken(candidate, indexed))} (${neutralizeAttribute(candidate.cwd)})`,
					)
					.join("; ");
				notes.push(`${label} is ambiguous. Candidates: ${choices}`);
				if (isSessionShaped(ref)) missed.push(`${label} is ambiguous (${resolution.candidates.length} candidates)`);
			} else {
				notes.push(`${label} matched no session.`);
				if (isSessionShaped(ref)) missed.push(`${label} matched no session`);
			}
		}
		// The cap must be visible: a user who writes four references must not believe all four
		// were injected.
		for (const ref of all.slice(config.maxReferences)) {
			notes.push(`#${neutralizeAttribute(ref)} was not included (max ${config.maxReferences} per prompt)`);
		}
		if (missed.length > 0 || readFailures.length > 0) {
			ctx.ui.notify(`pi-sessions: ${[...missed, ...readFailures].join("; ")}`, "warning");
		}

		// A prompt whose tokens all miss is ordinary text (`#42` for an issue): leave it
		// byte-identical. Notes for unknown or ambiguous tokens only ride along with a
		// digest that did resolve. A read failure does not: the user asked for a real session,
		// so the note explaining what happened must reach them even on its own.
		if (resolved.length === 0 && readFailures.length === 0) {
			showLoading(ctx, undefined);
			return;
		}

		if (config.summaryMode !== "off" && resolved.length > 0) {
			const names = resolved.map((entry) => entry.session.name ?? entry.session.id).join(", ");
			showLoading(ctx, `summarising ${names}…`);
		}

		let blocks: string[] = [];
		try {
			const summaries = await Promise.all(
				resolved.map(async (entry) => {
					// Git runs beside the summary, not after it: the critical path is
					// max(git, summary), never their sum. Both already never throw.
					const gitInfo = git(entry.session.cwd);
					if (config.summaryMode === "off") {
						return { session: entry.session, messages: entry.messages, result: null, git: await gitInfo };
					}
					const [result, section] = await Promise.all([
						summarizeWithModel(ctx, entry.session, entry.messages),
						gitInfo,
					]);
					return { session: entry.session, messages: entry.messages, result, git: section };
				}),
			);
			blocks = summaries.map((entry) => {
				const result = entry.result;
				const summaryText = result && "text" in result ? result.text : null;
				const summaryNote =
					result && "error" in result
						? result.error
						: config.summaryMode === "off"
							? "summaries are disabled in pi-sessions config"
							: null;
				return buildDigest(
					entry.session,
					entry.messages,
					{ git: entry.git, summary: summaryText, summaryNote },
					config,
					Date.now(),
				);
			});
		} finally {
			// Clear even if a digest builder throws: a stranded `summarising …` is worse than a lost turn.
			showLoading(ctx, undefined);
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
			const seen = new Set<string>();
			const items = sessions.map((session) => {
				const item = formatSessionItem(session, universe, now);
				let label = `${item.label} — ${item.description}`;
				// Two sessions can compose an identical label, and the picker returns the label
				// string — so the user would get the other session's digest. Add the id prefix only
				// when it actually collides, to keep the common case readable.
				if (seen.has(label)) label = `${label} — ${session.id.slice(0, 8)}`;
				seen.add(label);
				return { label, session };
			});
			const limit = pickerRows(process.stdout.rows);
			const shown = items.slice(0, limit);
			// The notice goes in the title: `notify` appends to the chat ABOVE the picker, so in
			// regular render mode the user never sees it. The title is the first visible line.
			const title =
				items.length > shown.length
					? `Insert a session reference (showing ${shown.length} of ${items.length} — type # to filter)`
					: "Insert a session reference";
			const picked = await ctx.ui.select(title, shown.map((item) => item.label));
			if (!picked) return;
			const chosen = shown.find((item) => item.label === picked);
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
			// Rebuild the store, like session_start does: it captures extraRoots at construction,
			// so re-reading the config alone would leave a changed roots list unapplied.
			store = new SessionStore({ root: sessionsRoot(), extraRoots: config.extraRoots });
			const parsed = await store.refresh();
			const visible = store.visible(config, {
				cwd: ctx.cwd,
				sessionPath: ctx.sessionManager.getSessionFile(),
			});
			// A root that fails to resolve or read is invisible in the counts, so name it here.
			const roots = store.rootReport;
			const failed =
				roots.failed.length > 0
					? `; roots failed: ${roots.failed.map((failure) => `${failure.root} (${failure.reason})`).join(", ")}`
					: "";
			// A file that was skipped instead of indexed must be visible here: a silent skip is
			// exactly what hid the oversized-session bug from the user for hours.
			const skippedFiles = store.skipped;
			const skipped =
				skippedFiles.length > 0
					? `; skipped ${skippedFiles.length}: ${skippedFiles
							.slice(0, 3)
							.map((file) => `${file.path} (${formatBytes(file.bytes)}, ${file.reason})`)
							.join(", ")}${skippedFiles.length > 3 ? ` and ${skippedFiles.length - 3} more` : ""}`
					: "";
			ctx.ui.notify(
				`pi-sessions: ${store.size} indexed, ${visible.length} visible across ${new Set(visible.map((s) => s.cwd)).size} repos (${parsed} re-parsed, ${formatBytes(store.bytesRead)} read); roots walked: ${roots.walked}${failed}${skipped}`,
				failed || skipped ? "warning" : "info",
			);
		},
	});

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		// The digest header is the first line, and session text can forge a later line, so read that line only.
		const headerLine = content.split("\n", 1)[0] ?? "";
		const name = headerLine.match(/^<referenced-session name="([^"]+)"/)?.[1];
		const header = theme.fg("accent", `↩ referenced sessions: ${name ?? "(none)"}`);
		if (!options.expanded) return new Text(header, options.outputPad, 0);
		return new Text(`${header}\n${theme.fg("dim", content)}`, options.outputPad, 0);
	});
}