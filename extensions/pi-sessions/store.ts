import { constants as bufferConstants } from "node:buffer";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { IndexedSession } from "./types.ts";

/**
 * The real ceiling is V8: a JS string cannot exceed `MAX_STRING_LENGTH` (536870888 on Node
 * 24), so a bigger file cannot be read whole at all. Appends cost only the new bytes, so the
 * old 50 MB cap bought nothing; this stays as the guard against a readFile that cannot succeed.
 */
export const MAX_FILE_BYTES = bufferConstants.MAX_STRING_LENGTH;
const MAX_FIRST_MESSAGE = 400;
/** How much of the consumed prefix is remembered to prove an append did not rewrite it. */
const HEADER_WITNESS_BYTES = 1024;
const TAIL_WITNESS_BYTES = 64;
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

/**
 * Reads [start, end) into a Buffer, looping until filled or EOF. `complete` is false when the
 * file ended early: the caller must not commit the stat it measured, or the unread gap would
 * stay unparsed until the next write. Returns null when the read fails.
 */
async function readRange(
	path: string,
	start: number,
	end: number,
): Promise<{ bytes: Buffer; complete: boolean; read: number } | null> {
	const length = end - start;
	if (length <= 0) return { bytes: Buffer.alloc(0), complete: true, read: 0 };
	const handle = await open(path, "r").catch(() => null);
	if (handle === null) return null;
	try {
		const buffer = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return { bytes: buffer.subarray(0, offset), complete: offset === length, read: offset };
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => {});
	}
}

/** The parse accumulates across calls so an appended file resumes instead of re-reading. */
interface ParseState {
	header: { id?: unknown; cwd?: unknown } | null;
	name?: string;
	firstUserMessage: string;
	messageCount: number;
}

function createState(): ParseState {
	return { header: null, firstUserMessage: "", messageCount: 0 };
}

/**
 * Consumes every COMPLETE line in `text`. Returns the index just past the last complete line,
 * so a partial trailing line (a session mid-append) is left for the next call.
 */
function consume(state: ParseState, text: string, maxFirstMessage: number): number {
	let position = 0;

	while (position < text.length) {
		const end = text.indexOf("\n", position);
		if (end === -1) break; // partial trailing line: a session mid-append
		const line = text.slice(position, end);
		position = end + 1;
		if (!line) continue;

		if (state.header === null) {
			const parsed = tryParse(line);
			// A rejected file stops here: toEntry returns null and the caller drops the record.
			if (!parsed || parsed.type !== "session" || typeof parsed.cwd !== "string") return position;
			state.header = parsed as { id?: unknown; cwd?: unknown };
			continue;
		}

		if (line.includes('"type":"message"')) {
			if (line.includes('"role":"system"')) continue;
			state.messageCount++;
			if (!state.firstUserMessage && line.includes('"role":"user"')) {
				const entry = tryParse(line) as { message?: { role?: string; content?: unknown } } | null;
				if (entry?.message?.role === "user") {
					state.firstUserMessage = textOfContent(entry.message.content, maxFirstMessage);
				}
			}
		} else if (line.includes('"type":"session_info"')) {
			const entry = tryParse(line) as { name?: unknown } | null;
			if (entry && typeof entry.name === "string" && entry.name.trim()) state.name = entry.name.trim();
		}
	}

	return position;
}

function toEntry(state: ParseState, path: string, meta: { mtimeMs: number; size: number }): IndexedSession | null {
	if (state.header === null) return null;
	return {
		path,
		id: typeof state.header.id === "string" ? state.header.id : "",
		cwd: state.header.cwd as string,
		name: state.name,
		messageCount: state.messageCount,
		firstUserMessage: state.firstUserMessage,
		modifiedMs: meta.mtimeMs,
		size: meta.size,
		mtimeMs: meta.mtimeMs,
	};
}

export function parseSessionFile(
	text: string,
	path: string,
	meta: { mtimeMs: number; size: number },
): IndexedSession | null {
	const state = createState();
	consume(state, text, MAX_FIRST_MESSAGE);
	return toEntry(state, path, meta);
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

/** A file the last walk could not read and had no previous entry to keep. */
export interface SkippedFile {
	path: string;
	bytes: number;
	reason: string;
}

/** One indexed file: the last entry plus what is needed to resume an append. */
interface CachedSession {
	mtimeMs: number;
	size: number;
	/** Byte offset just past the last complete line consumed from the file. */
	parsedBytes: number;
	/** First bytes of the consumed prefix, to prove the header did not change. */
	headerWitness: Buffer;
	/** Last bytes of the consumed prefix, ending on the line boundary consume stopped at. */
	tailWitness: Buffer;
	state: ParseState;
	entry: IndexedSession;
}

/**
 * The two small witnesses stored with a cache entry: the first 1 KB and the last 64 bytes of
 * the consumed prefix. On growth they are re-read from the file; a difference means the file
 * was rewritten in place and the new bytes cannot be appended to the old parse state.
 */
function witnessesFor(text: string, consumed: number): { header: Buffer; tail: Buffer } {
	const prefix = text.slice(0, consumed);
	const header = Buffer.from(prefix.slice(0, HEADER_WITNESS_BYTES), "utf8").subarray(0, HEADER_WITNESS_BYTES);
	// 256 characters encode to at least 64 bytes (UTF-8 is at most 4 bytes per character), so
	// the last 64 bytes are always inside this slice without encoding the whole prefix.
	const tailChars = prefix.slice(Math.max(0, prefix.length - 256));
	const tailBytes = Buffer.from(tailChars, "utf8");
	return { header, tail: tailBytes.subarray(Math.max(0, tailBytes.length - TAIL_WITNESS_BYTES)) };
}

/**
 * Turns the consumed text into a byte offset. The decoded string and the raw bytes agree for
 * valid UTF-8, which is what pi writes: JSON.stringify escapes lone surrogates.
 */
function consumedBytes(text: string, consumed: number): number {
	return Buffer.byteLength(text.slice(0, consumed), "utf8");
}

export class SessionStore {
	readonly #root: string;
	readonly #extraRoots: string[];
	readonly #maxFileBytes: number;
	#cache = new Map<string, CachedSession>();
	#rootReport: RootReport = { walked: 0, failed: [] };
	#skipped: SkippedFile[] = [];
	#bytesRead = 0;
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

	/** Files the last walk skipped because they could not be read and had no previous entry. */
	get skipped(): SkippedFile[] {
		return this.#skipped.map((file) => ({ ...file }));
	}

	/**
	 * Total bytes read from disk since construction. Monotonic and cheap: tests pin that an
	 * append reads only the delta, and `/pi-sessions` reports it next to the re-parsed count.
	 */
	get bytesRead(): number {
		return this.#bytesRead;
	}

	/**
	 * True when the file still starts with the same header and ends the consumed prefix
	 * identically. The tail's last byte is the line boundary `consume` stopped at, so a
	 * rewrite that does not preserve it cannot be resumed either.
	 */
	async #prefixUnchanged(file: string, previous: CachedSession): Promise<boolean> {
		const header = await readRange(file, 0, previous.headerWitness.length);
		if (header === null || !header.complete) return false;
		this.#bytesRead += header.read;
		if (!header.bytes.equals(previous.headerWitness)) return false;
		const tailStart = previous.parsedBytes - previous.tailWitness.length;
		const tail = await readRange(file, tailStart, previous.parsedBytes);
		if (tail === null || !tail.complete) return false;
		this.#bytesRead += tail.read;
		return tail.bytes.equals(previous.tailWitness) && tail.bytes[tail.bytes.length - 1] === 0x0a;
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
		this.#skipped = [];

		let parsed = 0;
		for (const file of files) {
			const meta = await stat(file).catch(() => null);
			// A file that vanished or turned into a directory is not a session any more. A file
			// that was indexed before keeps its last good entry rather than disappearing.
			if (!meta || !meta.isFile()) continue;
			const previous = this.#cache.get(file);
			if (previous && previous.mtimeMs === meta.mtimeMs && previous.size === meta.size) continue;

			const overCap = meta.size > this.#maxFileBytes;
			const delta = previous ? meta.size - previous.parsedBytes : 0;
			// An appended file resumes from the last complete line: a live 20 MB session must not
			// be re-read whole on every throttled dropdown refresh. Only the DELTA must fit the
			// read limit, so a file that outgrew the cap keeps being indexed. A new file, a
			// shrunken file, or an in-place rewrite (same size, new mtime) takes the full parse.
			// A larger rewrite must also prove its prefix unchanged, or its new bytes would be
			// consumed into the old parse state and leave a sticky wrong id, name and count.
			if (
				previous &&
				meta.size > previous.size &&
				delta <= this.#maxFileBytes &&
				(await this.#prefixUnchanged(file, previous))
			) {
				const appended = await readRange(file, previous.parsedBytes, meta.size);
				// A short read means the file is still being written: do not commit the stat, or a
				// later file that happens to match it would keep the unread gap forever.
				if (appended === null || !appended.complete) continue;
				this.#bytesRead += appended.read;
				const text = appended.bytes.toString("utf8");
				const consumed = consume(previous.state, text, MAX_FIRST_MESSAGE);
				previous.parsedBytes += consumedBytes(text, consumed);
				// Update the cached meta even when the new bytes end in a partial line, so that
				// line is not re-read until more bytes arrive.
				previous.mtimeMs = meta.mtimeMs;
				previous.size = meta.size;
				const entry = toEntry(previous.state, file, { mtimeMs: meta.mtimeMs, size: meta.size });
				if (entry) {
					previous.entry = entry;
					parsed++;
				}
				continue;
			}

			// The whole file must be read as one string; a file over the cap cannot be. It is
			// skipped and reported, but only when there is no previous entry to keep.
			if (overCap) {
				if (!previous) {
					this.#skipped.push({
						path: file,
						bytes: meta.size,
						reason: `over the ${this.#maxFileBytes}-byte read limit`,
					});
				}
				continue;
			}

			let readError: unknown;
			const text = await readFile(file, "utf8").catch((error: unknown) => {
				readError = error;
				return null;
			});
			if (text === null) {
				if (!previous) this.#skipped.push({ path: file, bytes: meta.size, reason: errorMessage(readError) });
				continue;
			}
			this.#bytesRead += meta.size;
			const state = createState();
			const consumed = consume(state, text, MAX_FIRST_MESSAGE);
			const entry = toEntry(state, file, { mtimeMs: meta.mtimeMs, size: meta.size });
			if (entry) {
				const witnesses = witnessesFor(text, consumed);
				this.#cache.set(file, {
					mtimeMs: meta.mtimeMs,
					size: meta.size,
					parsedBytes: consumedBytes(text, consumed),
					headerWitness: witnesses.header,
					tailWitness: witnesses.tail,
					state,
					entry,
				});
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