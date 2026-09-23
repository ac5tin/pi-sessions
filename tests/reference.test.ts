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
	// The whole pipeline, not just the resolver: a token is inserted into a prompt, so the
	// extractor must read it back whole before resolution can even see it.
	const roundTrip = (source: IndexedSession, universe: IndexedSession[], expect?: string): string => {
		const token = referenceToken(source, universe);
		const extracted = extractReferences(token)[0];
		assert.equal(extracted, token.slice(1), `the extractor read #${extracted} from ${token}`);
		if (expect !== undefined) assert.equal(token, expect);
		const hit = resolveReference(extracted!, universe);
		assert.equal(hit.kind, "found", `${token} must resolve`);
		assert.equal(hit.kind === "found" && hit.session.path, source.path, `${token} must reach ${source.path}`);
		return token;
	};

	const named = [backend, frontend];
	for (const source of named) roundTrip(source, named);

	// Unnamed sessions emit the whole id, so the id branch must accept a dashed UUID.
	const unnamedA = session({ id: "abcd1111-0000-4000-8000-000000000001", name: undefined, cwd: "/repo/a" });
	const unnamedB = session({ id: "abcd2222-0000-4000-8000-000000000002", name: undefined, cwd: "/repo/b" });
	const unnamedPair = [unnamedA, unnamedB];
	for (const source of unnamedPair) roundTrip(source, unnamedPair, `#${source.id}`);

	// Colliding names get the repo qualifier; each token must reach its own repo.
	const collision = [backend, backendOld];
	for (const source of collision) {
		assert.ok(roundTrip(source, collision).includes("/"), "a cross-repo collision should be repo-qualified");
	}

	// A repo basename with a space would emit `#My Projects/fix-auth`, which the extractor cuts to `My`.
	const spaced = [
		session({ id: "aaaa1111", name: "fix-auth", cwd: "/repo/My Projects", modifiedMs: 5000 }),
		session({ id: "bbbb2222", name: "fix-auth", cwd: "/repo/other", modifiedMs: 4000 }),
	];
	for (const source of spaced) roundTrip(source, spaced);

	// An uppercase repo basename must keep its readable qualifier: the token is emitted
	// lowercase, which the case-insensitive resolver reads back, instead of a full id.
	const upperRepo = [
		session({ id: "aaaa1111", name: "fix-auth", cwd: "/repo/Backend", modifiedMs: 5000 }),
		session({ id: "bbbb2222", name: "fix-auth", cwd: "/repo/frontend", modifiedMs: 4000 }),
	];
	for (const source of upperRepo) roundTrip(source, upperRepo);
	const upperToken = referenceToken(upperRepo[0]!, upperRepo);
	assert.ok(upperToken.startsWith("#backend/"), `uppercase repo should keep its qualifier: ${upperToken}`);

	// Two repos whose basenames differ only in case are one repo for collision purposes: the
	// lowercased qualifier reads back as the same repo, so both sides must fall back to the id.
	const caseTwin = [
		session({ id: "aaaa1111", name: "fix-auth", cwd: "/repo/Backend", modifiedMs: 5000 }),
		session({ id: "bbbb2222", name: "fix-auth", cwd: "/repo/backend", modifiedMs: 4000 }),
	];
	for (const source of caseTwin) roundTrip(source, caseTwin, `#${source.id}`);

	// A name with a colon would emit `#feat:-auth`, which the extractor cuts to `feat`.
	const colons = [
		session({ id: "cccc3333", name: "feat: auth", cwd: "/repo/a", modifiedMs: 5000 }),
		session({ id: "dddd4444", name: "feature notes", cwd: "/repo/b", modifiedMs: 4000 }),
	];
	for (const source of colons) roundTrip(source, colons);

	// A hex-like name whose slug is another session's id prefix would hit the id branch first.
	const hexLike = [
		session({ id: "ffffffff-0000-4000-8000-000000000009", name: "cafe", cwd: "/repo/cafe", modifiedMs: 5000 }),
		session({ id: "cafe2222-0000-4000-8000-000000000002", name: undefined, cwd: "/repo/other", modifiedMs: 4000 }),
	];
	for (const source of hexLike) roundTrip(source, hexLike);

	// A plain name still gets the short token; the id fallback must not swallow the common case.
	const plain = session({ id: "eeee5555", name: "plain-name", cwd: "/repo/plain", modifiedMs: 5000 });
	roundTrip(plain, [plain], "#plain-name");

	// A name that ends with a dot: the extractor strips trailing punctuation, so `#fix-auth.`
	// is read back as `fix-auth` and would silently resolve to the OTHER session here.
	const dotted = session({ id: "aaaa1111", name: "fix-auth.", cwd: "/repo/a", modifiedMs: 5000 });
	const undotted = session({ id: "bbbb2222", name: "fix-auth", cwd: "/repo/b", modifiedMs: 4000 });
	roundTrip(dotted, [dotted, undotted], `#${dotted.id}`);
	roundTrip(undotted, [dotted, undotted], "#fix-auth");

	// A dots-only name emits `#...`, which extracts to nothing at all.
	const dotsOnly = session({ id: "cccc3333", name: "...", cwd: "/repo/c", modifiedMs: 5000 });
	roundTrip(dotsOnly, [dotsOnly], `#${dotsOnly.id}`);

	// The same defect behind a cross-repo qualifier: `#backend/fix-auth.` reads back as
	// `backend/fix-auth`, which resolves to nobody.
	const dottedBackend = session({ id: "dddd4444", name: "fix-auth.", cwd: "/repo/backend", modifiedMs: 5000 });
	const dottedFrontend = session({ id: "eeee5555", name: "fix-auth", cwd: "/repo/frontend", modifiedMs: 4000 });
	roundTrip(dottedBackend, [dottedBackend, dottedFrontend], `#${dottedBackend.id}`);

	// A repo basename that ends with a dot follows the same rule.
	const dottedRepo = session({ id: "ffff6666", name: "fix-auth", cwd: "/repo/team.", modifiedMs: 5000 });
	const otherRepo = session({ id: "aaaa7777", name: "fix-auth", cwd: "/repo/other", modifiedMs: 4000 });
	roundTrip(dottedRepo, [dottedRepo, otherRepo], `#${dottedRepo.id}`);
});

test("a same-repo slug collision falls back to the id instead of an ambiguous repo token", () => {
	const clone = session({ id: "aaaa1111", name: "fix-auth", cwd: "/repo/backend", modifiedMs: 5000 });
	const fork = session({ id: "bbbb2222", name: "fix-auth", cwd: "/repo/backend", modifiedMs: 4000 });
	const sameRepo = [clone, fork];

	for (const source of sameRepo) {
		const token = referenceToken(source, sameRepo);
		assert.equal(token, `#${source.id}`, "a repo qualifier cannot disambiguate inside one repo");
		const hit = resolveReference(token.replace(/^#/, ""), sameRepo);
		assert.equal(hit.kind, "found");
		assert.equal(hit.kind === "found" && hit.session.path, source.path);
	}

	// The same collision across two repos still gets the repo qualifier.
	const crossRepo = [clone, session({ id: "cccc3333", name: "fix-auth", cwd: "/repo/frontend" })];
	assert.equal(referenceToken(clone, crossRepo), "#backend/fix-auth");
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

test("an all-digit token never falls through to the fuzzy name branch", () => {
	const named = session({ id: "ffffffff", name: "fix-42-auth", cwd: "/repo/numeric" });
	assert.deepEqual(resolveReference("42", [named]), { kind: "missing" });
	assert.equal(resolveReference("4242", [named]).kind, "missing");
});

test("an empty or whitespace query returns missing instead of matching every name", () => {
	for (const ref of ["", "   ", "\t"]) {
		assert.deepEqual(resolveReference(ref, all), { kind: "missing" });
	}
	const hit = resolveReference("feature-ui-orm-wire", all);
	assert.equal(hit.kind, "found");
});