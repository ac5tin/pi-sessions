import { test } from "node:test";
import assert from "node:assert/strict";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createSessionAutocompleteProvider, formatSessionItem, relativeLabel } from "../extensions/pi-sessions/autocomplete.ts";
import type { IndexedSession } from "../extensions/pi-sessions/types.ts";

function session(over: Partial<IndexedSession>): IndexedSession {
	return {
		path: `/sessions/${over.id ?? "x"}.jsonl`,
		id: "a1b2c3d4",
		cwd: "/repo/backend",
		name: undefined,
		messageCount: 12,
		firstUserMessage: "first",
		modifiedMs: 1000,
		size: 10,
		mtimeMs: 1000,
		...over,
	};
}

const backend = session({ id: "a1b2c3d4", name: "feature-db-orm", cwd: "/repo/backend", modifiedMs: 1_000_000 });
const frontend = session({ id: "c3d4e5f6", name: "feature-ui-orm-wire", cwd: "/repo/frontend", modifiedMs: 2_000_000 });
const all = [backend, frontend];

const passthrough: AutocompleteProvider = {
	async getSuggestions() {
		return null;
	},
	applyCompletion(lines, line, col) {
		return { lines, cursorLine: line, cursorCol: col };
	},
};

function provider(sessions = all, nowMs = 2_000_000) {
	return createSessionAutocompleteProvider(passthrough, { sessions: () => sessions, now: () => nowMs });
}

test("relativeLabel is compact and human readable", () => {
	assert.equal(relativeLabel(2_000_000, 2_000_000), "now");
	assert.equal(relativeLabel(2_000_000 - 12 * 60_000, 2_000_000), "12 min ago");
	assert.equal(relativeLabel(2_000_000 - 5 * 3_600_000, 2_000_000), "5 h ago");
	assert.equal(relativeLabel(2_000_000 - 3 * 86_400_000, 2_000_000), "3 d ago");
});

test("formatSessionItem shows the name as label and repo, age, size, state as description", () => {
	const item = formatSessionItem(backend, all, 2_000_000);
	assert.equal(item.value, "#feature-db-orm");
	assert.equal(item.label, "feature-db-orm");
	assert.ok(item.description?.includes("backend"));
	assert.ok(item.description?.includes("12 msgs"));
	assert.ok(item.description?.includes("finished"));
});

test("formatSessionItem marks active sessions and names unnamed ones by id", () => {
	const item = formatSessionItem(backend, all, 1_000_000 + 30_000);
	assert.ok(item.description?.includes("active"));
	const unnamed = formatSessionItem(session({ id: "dddddddd", modifiedMs: 2_000_000 }), all, 2_000_000);
	assert.equal(unnamed.label, "(unnamed)");
	assert.equal(unnamed.value, "#dddddddd");
});

test("a bare # lists every session, current repo first", async () => {
	const suggestions = await provider().getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	assert.ok(suggestions);
	assert.equal(suggestions.prefix, "#");
	assert.equal(suggestions.items.length, 2);
	assert.equal(suggestions.items[0]?.label, "feature-ui-orm-wire");
});

test("typing filters with fuzzy matching and sets the prefix", async () => {
	const suggestions = await provider().getSuggestions(["#db"], 0, 3, { signal: new AbortController().signal });
	assert.ok(suggestions);
	assert.equal(suggestions.prefix, "#db");
	assert.equal(suggestions.items.length, 1);
	assert.equal(suggestions.items[0]?.value, "#feature-db-orm");
});

test("no match returns no items so the built-in provider can answer", async () => {
	const suggestions = await provider().getSuggestions(["#zzzz"], 0, 5, { signal: new AbortController().signal });
	assert.equal(suggestions?.items.length ?? 0, 0);
});

test("a # that is not at a token boundary defers to the built-in provider", async () => {
	const suggestions = await provider().getSuggestions(["x#y"], 0, 3, { signal: new AbortController().signal });
	assert.equal(suggestions, null);
});

test("an aborted signal defers to the built-in provider", async () => {
	const controller = new AbortController();
	controller.abort();
	const suggestions = await provider().getSuggestions(["#"], 0, 1, { signal: controller.signal });
	assert.equal(suggestions, null);
});

test("items are capped at twenty", async () => {
	const many = Array.from({ length: 50 }, (_, index) =>
		session({ id: `id${index}`, name: `session-${index}`, modifiedMs: index }),
	);
	const suggestions = await provider(many).getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	assert.equal(suggestions?.items.length, 20);
});