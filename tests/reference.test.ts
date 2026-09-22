import { test } from "node:test";
import assert from "node:assert/strict";
import {
	extractReferences,
	referenceToken,
	repoName,
	resolveReference,
	slugify,
} from "../extensions/pi-sessions/reference.ts";
import type { IndexedSession } from "../extensions/pi-sessions/types.ts";

function session(over: Partial<IndexedSession>): IndexedSession {
	return {
		path: `/sessions/${over.id ?? "x"}.jsonl`,
		id: "aaaaaaaa",
		cwd: "/repo/backend",
		name: undefined,
		messageCount: 10,
		firstUserMessage: "hello",
		modifiedMs: 1000,
		size: 100,
		mtimeMs: 1000,
		...over,
	};
}

const backend = session({ id: "a1b2c3d4", name: "feature-db-orm", cwd: "/repo/backend", modifiedMs: 5000 });
const backendOld = session({ id: "bbbbbbbb", name: "feature-db-orm", cwd: "/repo/backend-tests", modifiedMs: 3000 });
const frontend = session({ id: "c3d4e5f6", name: "feature-ui-orm-wire", cwd: "/repo/frontend", modifiedMs: 4000 });
const unnamed = session({ id: "dddddddd", name: undefined, cwd: "/repo/backend", modifiedMs: 2000 });
const all = [backend, backendOld, frontend, unnamed];

test("extractReferences finds tokens at start, after space, and after paren", () => {
	assert.deepEqual(extractReferences("#one"), ["one"]);
	assert.deepEqual(extractReferences("work on #two now"), ["two"]);
	assert.deepEqual(extractReferences("done (#three)"), ["three"]);
	assert.deepEqual(extractReferences("a #one, then #two. and #one again"), ["one", "two"]);
	assert.deepEqual(extractReferences("#repo/name and #a1b2c3d4"), ["repo/name", "a1b2c3d4"]);
});

test("extractReferences ignores non-references and mid-word hashes", () => {
	assert.deepEqual(extractReferences("issue #42 and #TODO"), ["42", "TODO"]);
	assert.deepEqual(extractReferences("x#y nope"), []);
	assert.deepEqual(extractReferences("no hashes here"), []);
});

test("slugify normalizes case, spaces, and slashes", () => {
	assert.equal(slugify("Feature DB ORM"), "feature-db-orm");
	assert.equal(slugify("  a/b  "), "a-b");
});

test("repoName takes the last path segment", () => {
	assert.equal(repoName("/repo/backend"), "backend");
	assert.equal(repoName("/repo/backend/"), "backend");
	assert.equal(repoName("/repo/.worktrees/agent-modes"), "agent-modes");
});

test("exact slug match wins and is case-insensitive", () => {
	assert.deepEqual(resolveReference("feature-db-orm", all), { kind: "ambiguous", candidates: [backend, backendOld] });
	const single = resolveReference("feature-ui-orm-wire", all);
	assert.equal(single.kind, "found");
	assert.equal(single.kind === "found" && single.session.id, "c3d4e5f6");
});

test("repo/name disambiguates", () => {
	const hit = resolveReference("backend/feature-db-orm", all);
	assert.equal(hit.kind, "found");
	assert.equal(hit.kind === "found" && hit.session.id, "a1b2c3d4");
	assert.equal(resolveReference("nosuchrepo/feature-db-orm", all).kind, "missing");
});

test("id prefix resolves, shortest unique prefix accepted", () => {
	const hit = resolveReference("a1b2", all);
	assert.equal(hit.kind, "found");
	assert.equal(hit.kind === "found" && hit.session.id, "a1b2c3d4");
	assert.equal(resolveReference("ffff", all).kind, "missing");
});

test("fuzzy match resolves a unique substring", () => {
	const hit = resolveReference("ui-orm", all);
	assert.equal(hit.kind, "found");
	assert.equal(hit.kind === "found" && hit.session.id, "c3d4e5f6");
});

test("ambiguous candidates are sorted newest first and capped by the caller", () => {
	const hit = resolveReference("feature", all);
	assert.equal(hit.kind, "ambiguous");
	if (hit.kind === "ambiguous") {
		assert.equal(hit.candidates.length, 3);
		assert.deepEqual(hit.candidates.map((c) => c.id), ["a1b2c3d4", "c3d4e5f6", "bbbbbbbb"]);
	}
});

test("numbers and hashtags never resolve", () => {
	assert.equal(resolveReference("42", all).kind, "missing");
	assert.equal(resolveReference("TODO", all).kind, "missing");
});

test("referenceToken uses repo prefix only when the slug collides", () => {
	assert.equal(referenceToken(frontend, all), "#feature-ui-orm-wire");
	assert.equal(referenceToken(backend, all), "#backend/feature-db-orm");
	assert.equal(referenceToken(unnamed, all), `#${unnamed.id}`);
});

test("every referenceToken resolves back to its own session", () => {
	const named = [backend, frontend];
	for (const source of named) {
		const hit = resolveReference(referenceToken(source, named).replace(/^#/, ""), named);
		assert.equal(hit.kind, "found");
		assert.equal(hit.kind === "found" && hit.session.path, source.path);
	}

	// Unnamed sessions emit the whole id, so the id branch must accept a dashed UUID.
	const unnamedA = session({ id: "abcd1111-0000-4000-8000-000000000001", name: undefined, cwd: "/repo/a" });
	const unnamedB = session({ id: "abcd2222-0000-4000-8000-000000000002", name: undefined, cwd: "/repo/b" });
	const unnamedPair = [unnamedA, unnamedB];
	for (const source of unnamedPair) {
		const token = referenceToken(source, unnamedPair);
		assert.equal(token, `#${source.id}`);
		const hit = resolveReference(token.replace(/^#/, ""), unnamedPair);
		assert.equal(hit.kind, "found");
		assert.equal(hit.kind === "found" && hit.session.path, source.path);
	}

	// Colliding names get the repo qualifier; each token must reach its own repo.
	const collision = [backend, backendOld];
	for (const source of collision) {
		const token = referenceToken(source, collision);
		assert.ok(token.includes("/"), `${token} should be repo-qualified`);
		const hit = resolveReference(token.replace(/^#/, ""), collision);
		assert.equal(hit.kind, "found");
		assert.equal(hit.kind === "found" && hit.session.path, source.path);
	}
});

test("a hex-looking name still resolves by name when no id matches it", () => {
	const hexName = session({ id: "ffffffff", name: "beef", cwd: "/repo/beef" });
	const hit = resolveReference("beef", [hexName]);
	assert.equal(hit.kind, "found");
	assert.equal(hit.kind === "found" && hit.session.path, hexName.path);
});

test("a short number resolves by name and never enters the id branch", () => {
	const numericName = session({ id: "ffffffff", name: "42", cwd: "/repo/numeric" });
	const hit = resolveReference("42", [numericName]);
	assert.equal(hit.kind, "found");
	assert.equal(hit.kind === "found" && hit.session.path, numericName.path);
});