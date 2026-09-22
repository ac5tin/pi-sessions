import { fuzzyFilter, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { referenceToken, repoName } from "./reference.ts";
import type { IndexedSession } from "./types.ts";

const MAX_ITEMS = 20;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const TOKEN_PATTERN = /(?:^|[\s(])#([A-Za-z0-9._/-]*)$/;

export interface AutocompleteDeps {
	sessions: () => IndexedSession[];
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
		label: session.name ?? "(unnamed)",
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

			const all = deps.sessions();
			if (all.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const query = (match[1] ?? "").trim();
			const now = deps.now();
			const currentCwd = process.cwd();
			const ordered = [...all].sort((a, b) => {
				const aCurrent = a.cwd === currentCwd ? 1 : 0;
				const bCurrent = b.cwd === currentCwd ? 1 : 0;
				if (aCurrent !== bCurrent) return bCurrent - aCurrent;
				return b.modifiedMs - a.modifiedMs;
			});

			const pool = query ? fuzzyFilter(ordered, query, (session) => `${session.name ?? ""} ${session.cwd}`) : ordered;
			const items = pool.slice(0, MAX_ITEMS).map((session) => formatSessionItem(session, all, now));

			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { prefix: `#${query}`, items };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}