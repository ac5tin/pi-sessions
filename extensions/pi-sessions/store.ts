import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { IndexedSession } from "./types.ts";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FIRST_MESSAGE = 400;
const SUBAGENT_NAME = /^subagent-/i;
const SUBAGENT_TAGGED = /^[A-Za-z][\w-]*#[0-9a-f]{8}$/;

export function textOfContent(content: unknown, max: number): string {
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.filter(
				(block): block is { type: string; text: string } =>
					!!block &&
					typeof block === "object" &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text)
			.join(" ");
	}
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function isSubagent(name: string | undefined): boolean {
	if (!name) return false;
	return SUBAGENT_NAME.test(name) || SUBAGENT_TAGGED.test(name);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A leading `~` is a hand-written path, not a literal directory name. */
export function expandHome(root: string): string {
	if (root === "~") return homedir();
	if (root.startsWith("~/")) return join(homedir(), root.slice(2));
	return root;
}

function tryParse(line: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function parseSessionFile(
	text: string,
	path: string,
	meta: { mtimeMs: number; size: number },
): IndexedSession | null {
	let header: { id?: unknown; cwd?: unknown } | null = null;
	let name: string | undefined;
	let firstUserMessage = "";
	let messageCount = 0;
	let position = 0;

	while (position < text.length) {
		const end = text.indexOf("\n", position);
		if (end === -1) break; // partial trailing line: a session mid-append
		const line = text.slice(position, end);
		position = end + 1;
		if (!line) continue;

		if (header === null) {
			const parsed = tryParse(line);
			if (!parsed || parsed.type !== "session" || typeof parsed.cwd !== "string") return null;
			header = parsed as { id?: unknown; cwd?: unknown };
			continue;
		}

		if (line.includes('"type":"message"')) {
			if (line.includes('"role":"system"')) continue;
			messageCount++;
			if (!firstUserMessage && line.includes('"role":"user"')) {
				const entry = tryParse(line) as { message?: { role?: string; content?: unknown } } | null;
				if (entry?.message?.role === "user") {
					firstUserMessage = textOfContent(entry.message.content, MAX_FIRST_MESSAGE);
				}
			}
		} else if (line.includes('"type":"session_info"')) {
			const entry = tryParse(line) as { name?: unknown } | null;
			if (entry && typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
		}
	}

	if (header === null) return null;
	return {
		path,
		id: typeof header.id === "string" ? header.id : "",
		cwd: header.cwd as string,
		name,
		messageCount,
		firstUserMessage,
		modifiedMs: meta.mtimeMs,
		size: meta.size,
		mtimeMs: meta.mtimeMs,
	};
}

export interface RootFailure {
	root: string;
	reason: string;
}

export interface RootReport {
	/** Distinct roots that were actually read on the last walk. */
	walked: number;
	failed: RootFailure[];
}

export interface StoreOptions {
	root: string;
	extraRoots?: string[];
	maxFileBytes?: number;
}

export class SessionStore {
	readonly #root: string;
	readonly #extraRoots: string[];
	readonly #maxFileBytes: number;
	#cache = new Map<string, { mtimeMs: number; size: number; entry: IndexedSession }>();
	#rootReport: RootReport = { walked: 0, failed: [] };
	#inflight: Promise<number> | null = null;
	#refreshedAt = 0;

	constructor(options: StoreOptions) {
		this.#root = options.root;
		this.#extraRoots = options.extraRoots ?? [];
		this.#maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
	}

	get size(): number {
		return this.#cache.size;
	}

	/** What the last walk saw: how many distinct roots it read, and which roots failed. */
	get rootReport(): RootReport {
		return { walked: this.#rootReport.walked, failed: this.#rootReport.failed.map((failure) => ({ ...failure })) };
	}

	async #walk(): Promise<string[]> {
		const files: string[] = [];
		const failed: RootFailure[] = [];
		const seen = new Set<string>();
		let walked = 0;
		for (const root of [this.#root, ...this.#extraRoots]) {
			const expanded = expandHome(root);
			// One realpath per root: the same directory reached through two spellings (absolute vs
			// relative, symlink vs target) must not index every file twice. The first spelling is
			// the one that survives the walk, so session.path still matches pi's own spelling of
			// the current session file and the self-hide check keeps working.
			const real = await realpath(expanded).catch(() => null);
			if (real === null) {
				failed.push({ root, reason: "path does not resolve" });
				continue;
			}
			if (seen.has(real)) continue;
			seen.add(real);

			let projectDirs;
			try {
				projectDirs = await readdir(expanded, { withFileTypes: true });
			} catch (error) {
				failed.push({ root, reason: errorMessage(error) });
				continue;
			}
			walked++;
			for (const projectDir of projectDirs) {
				if (!projectDir.isDirectory()) continue;
				const projectPath = join(expanded, projectDir.name);
				const entries = await readdir(projectPath, { withFileTypes: true }).catch(() => []);
				for (const entry of entries) {
					if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(projectPath, entry.name));
				}
			}
		}
		this.#rootReport = { walked, failed };
		return files;
	}

	/**
	 * Refreshes only when the index is older than maxAgeMs. Another agent can name, extend or
	 * create a session at any moment, so a caller about to SHOW or RESOLVE sessions must not
	 * serve an index built at session_start — that is exactly how a `/name` run in one agent
	 * stayed invisible to the `#` dropdown in another.
	 */
	async refreshIfStale(maxAgeMs: number, nowMs = Date.now()): Promise<number> {
		if (!this.#inflight && nowMs - this.#refreshedAt < maxAgeMs) return 0;
		return this.refresh();
	}

	/** Re-reads only files whose mtime or size changed. Returns how many were parsed. */
	async refresh(): Promise<number> {
		// Reuse a walk already in flight: session_start warms the index in the background, and a
		// dropdown that appears a moment later must not walk the tree a second time.
		if (this.#inflight) return this.#inflight;
		const run = this.#doRefresh();
		this.#inflight = run;
		try {
			return await run;
		} finally {
			this.#inflight = null;
			this.#refreshedAt = Date.now();
		}
	}

	async #doRefresh(): Promise<number> {
		const files = await this.#walk();
		const present = new Set(files);
		for (const key of [...this.#cache.keys()]) {
			if (!present.has(key)) this.#cache.delete(key);
		}

		let parsed = 0;
		for (const file of files) {
			const meta = await stat(file).catch(() => null);
			if (!meta || !meta.isFile() || meta.size > this.#maxFileBytes) {
				this.#cache.delete(file);
				continue;
			}
			const previous = this.#cache.get(file);
			if (previous && previous.mtimeMs === meta.mtimeMs && previous.size === meta.size) continue;
			const text = await readFile(file, "utf8").catch(() => null);
			if (text === null) continue;
			const entry = parseSessionFile(text, file, { mtimeMs: meta.mtimeMs, size: meta.size });
			if (entry) {
				this.#cache.set(file, { mtimeMs: meta.mtimeMs, size: meta.size, entry });
				parsed++;
			} else {
				this.#cache.delete(file);
			}
		}
		return parsed;
	}

	all(): IndexedSession[] {
		return [...this.#cache.values()].map((cached) => cached.entry);
	}

	get(path: string): IndexedSession | undefined {
		return this.#cache.get(path)?.entry;
	}

	visible(config: Config, options: { cwd: string; sessionPath?: string }): IndexedSession[] {
		const hiddenPatterns = config.hidePatterns.map((pattern) => pattern.toLowerCase());
		const kept = this.all().filter((session) => {
			if (options.sessionPath && session.path === options.sessionPath) return false;
			if (session.messageCount < config.minMessages) return false;
			if (!config.showSubagents && isSubagent(session.name)) return false;
			if (session.name && hiddenPatterns.some((pattern) => session.name!.toLowerCase().includes(pattern))) {
				return false;
			}
			return true;
		});
		return kept.sort((a, b) => {
			const aCurrent = a.cwd === options.cwd ? 1 : 0;
			const bCurrent = b.cwd === options.cwd ? 1 : 0;
			if (aCurrent !== bCurrent) return bCurrent - aCurrent;
			return b.modifiedMs - a.modifiedMs;
		});
	}
}