import { test } from "node:test";
import assert from "node:assert/strict";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { createSessionAutocompleteProvider, formatSessionItem, relativeLabel } from "../extensions/pi-sessions/autocomplete.ts";
import { resolveReference } from "../extensions/pi-sessions/reference.ts";
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

function provider(sessions = all, nowMs = 2_000_000, universe = sessions) {
	return createSessionAutocompleteProvider(passthrough, {
		sessions: () => sessions,
		all: () => universe,
		now: () => nowMs,
	});
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

test("formatSessionItem marks active sessions and references unnamed ones by id", () => {
	const item = formatSessionItem(backend, all, 1_000_000 + 30_000);
	assert.ok(item.description?.includes("active"));
	// No first request either, so the label has nothing to fall back to.
	const unnamed = formatSessionItem(
		session({ id: "dddddddd", modifiedMs: 2_000_000, firstUserMessage: "" }),
		all,
		2_000_000,
	);
	assert.equal(unnamed.label, "(unnamed)");
	assert.equal(unnamed.value, "#dddddddd");
});

test("an unnamed session is labelled by its first request", () => {
	const unnamed = formatSessionItem(
		session({ id: "dddddddd", modifiedMs: 2_000_000, firstUserMessage: "add session grouping to the sidebar" }),
		all,
		2_000_000,
	);
	assert.equal(unnamed.label, "add session grouping to the sidebar");
	// The label is display only: the token still has to resolve, so an unnamed session is
	// still referenced by its id.
	assert.equal(unnamed.value, "#dddddddd");
});

test("a long or multi-line first request is collapsed and truncated", () => {
	const item = formatSessionItem(
		session({ id: "ffffffff", firstUserMessage: `first line\nsecond line ${"x".repeat(200)}` }),
		all,
		2_000_000,
	);
	assert.equal(item.label.length, 60);
	assert.ok(item.label.endsWith("…"), item.label);
	assert.ok(!item.label.includes("\n"), item.label);
	assert.ok(item.label.startsWith("first line second line"), item.label);
});

test("the dropdown refreshes the index before it serves a list", async () => {
	let refreshed = 0;
	const p = createSessionAutocompleteProvider(passthrough, {
		sessions: () => all,
		all: () => all,
		refresh: async () => {
			refreshed++;
		},
		now: () => 2_000_000,
	});

	await p.getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	assert.equal(refreshed, 1, "a rename in another agent must reach the dropdown");

	// A line that is not ours is delegated, so it must not touch the filesystem.
	await p.getSuggestions(["hello"], 0, 5, { signal: new AbortController().signal });
	assert.equal(refreshed, 1, "delegation must not refresh");
});

test("a bare # lists every session in the order the store gives them", async () => {
	const suggestions = await provider().getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	assert.ok(suggestions);
	assert.equal(suggestions.prefix, "#");
	assert.deepEqual(
		suggestions.items.map((item: AutocompleteItem) => item.label),
		["feature-db-orm", "feature-ui-orm-wire"],
		"the provider must not re-sort the store's current-repo-first, newest-first order",
	);
});

test("typing filters with fuzzy matching and sets the prefix", async () => {
	const suggestions = await provider().getSuggestions(["#db"], 0, 3, { signal: new AbortController().signal });
	assert.ok(suggestions);
	assert.equal(suggestions.prefix, "#db");
	assert.equal(suggestions.items.length, 1);
	assert.equal(suggestions.items[0]?.value, "#feature-db-orm");
});

test("no match returns null so the built-in provider can answer", async () => {
	const suggestions = await provider().getSuggestions(["#zzzz"], 0, 5, { signal: new AbortController().signal });
	assert.equal(suggestions, null);
});

test("an empty session pool defers to the built-in provider", async () => {
	let delegated = 0;
	const spy: AutocompleteProvider = {
		async getSuggestions() {
			delegated++;
			return null;
		},
		applyCompletion(lines, line, col) {
			return { lines, cursorLine: line, cursorCol: col };
		},
	};
	const emptyProvider = createSessionAutocompleteProvider(spy, {
		sessions: () => [],
		all: () => [],
		now: () => 2_000_000,
	});
	const suggestions = await emptyProvider.getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	assert.equal(suggestions, null, "an empty pool must not open an empty popup");
	assert.equal(delegated, 1, "file completion must stay alive for a user with no visible sessions");
});

test("the prefix is the token only, never the leading space or parenthesis", async () => {
	const spaced = await provider().getSuggestions(["see #db"], 0, 7, { signal: new AbortController().signal });
	assert.equal(spaced?.prefix, "#db");
	const parenthesized = await provider().getSuggestions(["see (#db"], 0, 8, { signal: new AbortController().signal });
	assert.equal(parenthesized?.prefix, "#db");
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

test("applyCompletion consumes the rest of the token and keeps a separator", () => {
	const sessionProvider = provider();
	const item = { value: "#feature-db-orm", label: "feature-db-orm" };

	const atEnd = sessionProvider.applyCompletion(["#bac"], 0, 4, item, "#bac");
	assert.equal(atEnd.lines[0], "#feature-db-orm ");
	assert.equal(atEnd.cursorCol, "#feature-db-orm ".length);

	const midToken = sessionProvider.applyCompletion(["#baxyz"], 0, 3, item, "#ba");
	assert.equal(midToken.lines[0], "#feature-db-orm ");

	const beforeParen = sessionProvider.applyCompletion(["see (#bac)"], 0, 9, item, "#bac");
	assert.equal(beforeParen.lines[0], "see (#feature-db-orm)");

	const secondToken = sessionProvider.applyCompletion(["see #a and #b"], 0, 13, item, "#b");
	assert.equal(secondToken.lines[0], "see #a and #feature-db-orm ");
});

test("applyCompletion delegates every non-# prefix to the wrapped provider", () => {
	const sentinel = { lines: ["SENTINEL"], cursorLine: 7, cursorCol: 8 };
	let delegated = 0;
	const spy: AutocompleteProvider = {
		async getSuggestions() {
			return null;
		},
		applyCompletion() {
			delegated++;
			return sentinel;
		},
	};
	const sessionProvider = createSessionAutocompleteProvider(spy, {
		sessions: () => all,
		all: () => all,
		now: () => 2_000_000,
	});

	// A slash-command item's value has no leading "/" — only the built-in provider adds it.
	const slash = sessionProvider.applyCompletion(["/se"], 0, 3, { value: "sessions", label: "sessions" }, "/se");
	assert.equal(slash, sentinel);
	assert.equal(delegated, 1);

	const directory = sessionProvider.applyCompletion(["@src"], 0, 4, { value: "src/", label: "src/" }, "@src");
	assert.equal(directory, sentinel);
	assert.equal(delegated, 2);

	const hash = sessionProvider.applyCompletion(["#bac"], 0, 4, { value: "#feature-db-orm", label: "feature-db-orm" }, "#bac");
	assert.equal(delegated, 2, "a # prefix is ours and must not round-trip through the wrapped provider");
	assert.equal(hash.lines[0], "#feature-db-orm ");
});

test("a hidden same-slug session forces a repo-qualified token that resolves", async () => {
	const visible = session({ id: "aaaa1111", name: "fix-auth", cwd: "/repo/backend", messageCount: 12 });
	const hidden = session({ id: "bbbb2222", name: "fix-auth", cwd: "/repo/frontend", messageCount: 1 });
	const universe = [visible, hidden];

	const suggestions = await provider([visible], 2_000_000, universe).getSuggestions(["#fix-auth"], 0, 9, {
		signal: new AbortController().signal,
	});
	assert.ok(suggestions);
	assert.equal(suggestions.items.length, 1, "the hidden session must not reach the dropdown");
	const item = suggestions.items[0];
	assert.ok(item);
	assert.equal(item.value, "#backend/fix-auth", "a bare #fix-auth would resolve ambiguously against the whole index");

	const resolution = resolveReference(item.value.slice(1), universe);
	assert.equal(resolution.kind, "found");
	assert.ok(resolution.kind === "found" && resolution.session.path === visible.path);
});

test("a collision between two visible sessions still forces repo-qualified tokens", async () => {
	const first = session({ id: "aaaa1111", name: "fix-auth", cwd: "/repo/backend" });
	const second = session({ id: "bbbb2222", name: "fix-auth", cwd: "/repo/frontend" });
	const universe = [first, second];

	const suggestions = await provider(universe, 2_000_000, universe).getSuggestions(["#fix-auth"], 0, 9, {
		signal: new AbortController().signal,
	});
	assert.ok(suggestions);
	assert.deepEqual(
		suggestions.items.map((item: AutocompleteItem) => item.value).sort(),
		["#backend/fix-auth", "#frontend/fix-auth"],
	);
});