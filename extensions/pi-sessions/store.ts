import { readdir, readFile, stat } from "node:fs/promises";
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

	constructor(options: StoreOptions) {
		this.#root = options.root;
		this.#extraRoots = options.extraRoots ?? [];
		this.#maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
	}

	get size(): number {
		return this.#cache.size;
	}

	async #walk(): Promise<string[]> {
		const files: string[] = [];
		for (const root of [this.#root, ...this.#extraRoots]) {
			const projectDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
			for (const projectDir of projectDirs) {
				if (!projectDir.isDirectory()) continue;
				const projectPath = join(root, projectDir.name);
				const entries = await readdir(projectPath, { withFileTypes: true }).catch(() => []);
				for (const entry of entries) {
					if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(projectPath, entry.name));
				}
			}
		}
		return files;
	}

	/** Re-reads only files whose mtime or size changed. Returns how many were parsed. */
	async refresh(): Promise<number> {
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