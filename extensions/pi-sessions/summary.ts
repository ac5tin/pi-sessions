import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderMessage } from "./transcript.ts";
import type { IndexedSession, SessionMessage } from "./types.ts";

export const MAX_INPUT_CHARS = 80_000;
export const MAX_OUTPUT_CHARS = 4_000;

/** Provider-neutral model call. `signal` aborts the wait; providers may ignore it. */
export type StreamFn = (prompt: string, signal: AbortSignal) => Promise<string>;

export type SummaryResult = { text: string; cached: boolean } | { error: string };

export interface SummaryDeps {
	stream: StreamFn;
	cacheDir: string;
	modelId: string;
}

export function summaryCacheKey(session: IndexedSession, modelId: string): string {
	const model = modelId.replace(/[^A-Za-z0-9._-]/g, "_");
	return `${session.id}-${Math.round(session.mtimeMs)}-${session.size}-${model}`;
}

export function buildSummaryPrompt(transcript: string): string {
	return [
		"Summarize this coding session as a handoff to another engineer who must continue the work in a different repository.",
		"Cover: what was accomplished, decisions made, files changed, current state, and anything unfinished.",
		"Be specific and terse. No preamble, no markdown headings.",
		"",
		"Session transcript:",
		transcript,
	].join("\n");
}

export function transcriptOf(messages: SessionMessage[]): string {
	return messages
		.map(renderMessage)
		.filter((line): line is string => line !== null)
		.join("\n")
		.slice(-MAX_INPUT_CHARS);
}

export async function findCachedSummary(cacheDir: string, key: string): Promise<string | null> {
	const text = await readFile(join(cacheDir, `${key}.md`), "utf8").catch(() => null);
	return text && text.trim() ? text : null;
}

/** Writes the summary and removes other cached summaries for the same session. */
export async function writeCachedSummary(
	cacheDir: string,
	key: string,
	sessionId: string,
	text: string,
): Promise<void> {
	await mkdir(cacheDir, { recursive: true }).catch(() => {});
	await writeFile(join(cacheDir, `${key}.md`), text, "utf8").catch(() => {});
	const entries = await readdir(cacheDir).catch(() => []);
	await Promise.all(
		entries
			.filter((entry) => entry.startsWith(`${sessionId}-`) && entry !== `${key}.md`)
			.map((entry) => unlink(join(cacheDir, entry)).catch(() => {})),
	);
}

export async function getSummary(
	session: IndexedSession,
	messages: SessionMessage[],
	deps: SummaryDeps,
	timeoutMs: number,
): Promise<SummaryResult> {
	const key = summaryCacheKey(session, deps.modelId);
	const cached = await findCachedSummary(deps.cacheDir, key);
	if (cached) return { text: cached, cached: true };

	const transcript = transcriptOf(messages);
	if (!transcript.trim()) return { error: "referenced session has no readable content" };

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			// Reject first: a provider that rejects on its own abort listener would otherwise
			// win the race with its message, making the timeout error provider-dependent.
			reject(new Error("summary timed out"));
			controller.abort();
		}, timeoutMs);
	});

	try {
		const raw = await Promise.race([deps.stream(buildSummaryPrompt(transcript), controller.signal), deadline]);
		const text = raw.trim().slice(0, MAX_OUTPUT_CHARS);
		if (!text) return { error: "summary model returned empty text" };
		await writeCachedSummary(deps.cacheDir, key, session.id, text);
		return { text, cached: false };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}