import { fuzzyFilter, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { referenceToken, repoName } from "./reference.ts";
import type { IndexedSession } from "./types.ts";

const MAX_ITEMS = 20;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const LABEL_CHARS = 60;
const TOKEN_PATTERN = /(?:^|[\s(])#([A-Za-z0-9._/-]*)$/;

export interface AutocompleteDeps {
	/** Sessions offered in the dropdown — already filtered to human sessions. */
	sessions: () => IndexedSession[];
	/**
	 * Every indexed session, used only to decide whether a token needs a repo qualifier.
	 * This must NOT be the filtered list: a hidden session with the same slug would make the
	 * short token ambiguous, so the dropdown would hand the user a reference that cannot resolve.
	 */
	all: () => IndexedSession[];
	/**
	 * Refreshes the index before a list is served. Another agent can name a session after this
	 * one started, and the index built at session_start would not know about it.
	 */
	refresh?: () => Promise<unknown>;
	now: () => number;
}

export function relativeLabel(modifiedMs: number, nowMs: number): string {
	const seconds = Math.max(0, Math.round((nowMs - modifiedMs) / 1000));
	if (seconds < 45) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.round(hours / 24)} d ago`;
}

/**
 * A session the developer never named would otherwise render as one more identical
 * "(unnamed)" row — useless in a list that holds forty of them. The first request is the
 * best label available, and the store already parses it. The name wins when it exists.
 */
function labelFor(session: IndexedSession): string {
	if (session.name) return session.name;
	const first = session.firstUserMessage.replace(/\s+/g, " ").trim();
	if (!first) return "(unnamed)";
	return first.length > LABEL_CHARS ? `${first.slice(0, LABEL_CHARS - 1)}…` : first;
}

export function formatSessionItem(session: IndexedSession, all: IndexedSession[], nowMs: number): AutocompleteItem {
	const state = nowMs - session.modifiedMs < ACTIVE_WINDOW_MS ? "active" : "finished";
	const parts = [
		repoName(session.cwd),
		relativeLabel(session.modifiedMs, nowMs),
		`${session.messageCount} msgs`,
		state,
	];
	return {
		value: referenceToken(session, all),
		label: labelFor(session),
		description: parts.join(" · "),
	};
}

export function createSessionAutocompleteProvider(
	current: AutocompleteProvider,
	deps: AutocompleteDeps,
): AutocompleteProvider {
	return {
		triggerCharacters: ["#"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const line = lines[cursorLine] ?? "";
			const match = line.slice(0, cursorCol).match(TOKEN_PATTERN);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal.aborted) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			// A rename or a new session in another agent must show up here. The store throttles the
			// walk, so a warm refresh is a readdir plus stat, not a re-parse of every session.
			await deps.refresh?.();

			const pool = deps.sessions();
			if (pool.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const universe = deps.all();

			const query = (match[1] ?? "").trim();
			const now = deps.now();

			// The store already orders current-repo-first, newest-first; re-sorting here would
			// destroy that partition when process.cwd() differs from the session's cwd.
			const filtered = query
				? fuzzyFilter(pool, query, (session) => `${session.name ?? ""} ${session.cwd}`)
				: pool;
			const items = filtered.slice(0, MAX_ITEMS).map((session) => formatSessionItem(session, universe, now));

			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { prefix: `#${query}`, items };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			// Only tokens we own are handled here. Every other prefix was suggested by the wrapped
			// provider, and its applyCompletion does work ours does not — notably adding the
			// leading "/" to a slash command, whose item value has no slash.
			if (!prefix.startsWith("#")) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol - prefix.length);
			// Drop the remainder of the token the user was typing: selecting from the middle of
			// `#ba|xyz` would otherwise glue `xyz` onto the value and produce a dead reference.
			const after = (line.slice(cursorCol) ?? "").replace(/^[A-Za-z0-9._/-]*/, "");
			// Keep a separator when the token ends the line, so the next keystroke cannot join it.
			const inserted = after === "" ? `${item.value} ` : item.value;
			const next = `${before}${inserted}${after}`;
			return {
				lines: [...lines.slice(0, cursorLine), next, ...lines.slice(cursorLine + 1)],
				cursorLine,
				cursorCol: before.length + inserted.length,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}