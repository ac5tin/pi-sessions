import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, resolveConfig } from "../extensions/pi-sessions/config.ts";
import { resolveReference } from "../extensions/pi-sessions/reference.ts";
import { expandHome, isSubagent, parseSessionFile, SessionStore, textOfContent } from "../extensions/pi-sessions/store.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/sessions", import.meta.url));

test("textOfContent handles strings and block arrays", () => {
	assert.equal(textOfContent("a  b\nc", 100), "a b c");
	assert.equal(textOfContent([{ type: "text", text: "hello" }, { type: "thinking", thinking: "x" }], 100), "hello");
	assert.equal(textOfContent("abcdef", 3), "abc");
	assert.equal(textOfContent(undefined, 10), "");
});

test("parseSessionFile reads header, name, count, and first user message", () => {
	const text = readFileSync(join(FIXTURES, "--repo-backend--", "001_named.jsonl"), "utf8");
	const parsed = parseSessionFile(text, "/p.jsonl", { mtimeMs: 5, size: text.length });
	assert.ok(parsed);
	assert.equal(parsed.id, "a1b2c3d4-0000-4000-8000-000000000001");
	assert.equal(parsed.cwd, "/repo/backend");
	assert.equal(parsed.name, "feature-db-orm");
	assert.equal(parsed.messageCount, 5);
	assert.equal(parsed.firstUserMessage, "Build the ORM layer for the orders table");
	assert.equal(parsed.modifiedMs, 5);
});

test("parseSessionFile tolerates a partial trailing line from a live session", () => {
	const text = readFileSync(join(FIXTURES, "--repo-backend--", "002_partial.jsonl"), "utf8");
	const parsed = parseSessionFile(text, "/p.jsonl", { mtimeMs: 5, size: text.length });
	assert.ok(parsed);
	assert.equal(parsed.name, "feature-orm-tests");
	assert.equal(parsed.messageCount, 3);
});

test("parseSessionFile rejects non-session files", () => {
	assert.equal(parseSessionFile("not json\n", "/p.jsonl", { mtimeMs: 1, size: 9 }), null);
	assert.equal(parseSessionFile('{"type":"other"}\n', "/p.jsonl", { mtimeMs: 1, size: 9 }), null);
});

test("isSubagent spots pi-subagents naming", () => {
	assert.equal(isSubagent("general-purpose#9b927f29"), true);
	assert.equal(isSubagent("Reviewer#087757ca"), true);
	assert.equal(isSubagent("subagent-oracle-096d400b-a61c-42d6-9266-1d281cd06b88-1"), true);
	assert.equal(isSubagent("feature-db-orm"), false);
	assert.equal(isSubagent("spam jev"), false);
	assert.equal(isSubagent(undefined), false);
});

test("refresh indexes fixtures, then re-parses nothing on a second pass", async () => {
	const store = new SessionStore({ root: FIXTURES });
	const first = await store.refresh();
	assert.equal(first, 5);
	assert.equal(store.size, 5);
	const second = await store.refresh();
	assert.equal(second, 0);
	assert.equal(store.size, 5);
});

test("refresh skips oversized files", async () => {
	const store = new SessionStore({ root: FIXTURES, maxFileBytes: 200 });
	await store.refresh();
	assert.equal(store.size, 0);
});

test("refresh picks up an appended session on the next pass", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-sessions-store-"));
	const projectDir = join(root, "--repo-x--");
	mkdirSync(projectDir, { recursive: true });
	const file = join(projectDir, "live.jsonl");
	writeFileSync(file, '{"type":"session","version":3,"id":"x1","cwd":"/repo/x"}\n');
	const store = new SessionStore({ root });
	await store.refresh();
	assert.equal(store.size, 1);
	assert.equal(store.get(file)?.messageCount, 0);
	appendFileSync(file, '{"type":"message","id":"a","parentId":null,"timestamp":"t","message":{"role":"user","content":"hi","timestamp":1}}\n');
	const reparsed = await store.refresh();
	assert.equal(reparsed, 1);
	assert.equal(store.get(file)?.messageCount, 1);
	rmSync(root, { recursive: true, force: true });
});

test("visible filters by minMessages, subagents, self, and hidePatterns", async () => {
	const store = new SessionStore({ root: FIXTURES });
	await store.refresh();
	const config = resolveConfig({ minMessages: 3 });
	const names = store.visible(config, { cwd: "/repo/backend" }).map((s) => s.name);
	assert.equal(names.includes("throwaway"), false);
	assert.equal(names.includes("general-purpose#9b927f29"), false);
	assert.equal(names.includes("feature-db-orm"), true);
	assert.equal(names.includes("feature-orm-tests"), true);
	assert.equal(names.includes(undefined), true);

	const withSubagents = resolveConfig({ showSubagents: true });
	assert.equal(store.visible(withSubagents, { cwd: "/repo/backend" }).length, 4);

	const selfPath = join(FIXTURES, "--repo-backend--", "001_named.jsonl");
	const withoutSelf = store.visible(withSubagents, { cwd: "/repo/backend", sessionPath: selfPath });
	assert.equal(withoutSelf.some((s) => s.path === selfPath), false);

	const hidden = resolveConfig({ showSubagents: true, hidePatterns: ["orm-tests"] });
	assert.equal(store.visible(hidden, { cwd: "/repo/backend" }).some((s) => s.name === "feature-orm-tests"), false);
});

test("visible puts the current repo first, then newest first", async () => {
	const store = new SessionStore({ root: FIXTURES });
	await store.refresh();
	const ordered = store.visible(DEFAULT_CONFIG, { cwd: "/repo/frontend" }).map((s) => s.cwd);
	assert.equal(ordered[0], "/repo/frontend");
	assert.ok(ordered.slice(1).every((cwd) => cwd === "/repo/backend"));
});

test("visible orders newest first inside the current-repo partition", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-sessions-order-"));
	const mine = join(root, "--repo-mine--");
	const other = join(root, "--repo-other--");
	mkdirSync(mine, { recursive: true });
	mkdirSync(other, { recursive: true });
	const write = (dir: string, id: string, cwd: string, seconds: number) => {
		const file = join(dir, `${id}.jsonl`);
		const messages = [1, 2, 3].map((n) =>
			JSON.stringify({ type: "message", id: `m${n}`, parentId: n === 1 ? null : `m${n - 1}`, message: { role: "user", content: `turn ${n}` } }),
		);
		writeFileSync(file, [`{"type":"session","version":3,"id":"${id}","cwd":"${cwd}"}`, ...messages].join("\n") + "\n");
		utimesSync(file, seconds, seconds);
	};
	write(mine, "aaaa0001", "/repo/mine", 1_000);
	write(mine, "aaaa0002", "/repo/mine", 2_000);
	// The newest session overall sits in another repo; the current-repo partition must still lead.
	write(other, "bbbb0001", "/repo/other", 9_000);

	const store = new SessionStore({ root });
	await store.refresh();
	const ordered = store.visible(DEFAULT_CONFIG, { cwd: "/repo/mine" }).map((s) => s.id);
	assert.deepEqual(ordered, ["aaaa0002", "aaaa0001", "bbbb0001"]);
	rmSync(root, { recursive: true, force: true });
});

test("refreshIfStale picks up a name another agent wrote", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-sessions-rename-"));
	const projectDir = join(root, "--repo-x--");
	mkdirSync(projectDir, { recursive: true });
	const file = join(projectDir, "live.jsonl");
	writeFileSync(file, '{"type":"session","version":3,"id":"x1","cwd":"/repo/x"}\n');

	const store = new SessionStore({ root });
	await store.refresh();
	assert.equal(store.get(file)?.name, undefined);

	// Exactly what `/name` in another pi agent appends to the session file.
	appendFileSync(file, '{"type":"session_info","name":"named elsewhere"}\n');

	// Inside the window the index stands, which keeps the dropdown off the filesystem.
	assert.equal(await store.refreshIfStale(60_000), 0);
	assert.equal(store.get(file)?.name, undefined);

	// Past the window the rename must arrive, or the dropdown in the other agent is useless.
	assert.equal(await store.refreshIfStale(0), 1);
	assert.equal(store.get(file)?.name, "named elsewhere");
	rmSync(root, { recursive: true, force: true });
});

test("refreshIfStale joins a walk already in flight instead of calling the index fresh", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-sessions-inflight-"));
	const projectDir = join(root, "--repo-x--");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "one.jsonl"), '{"type":"session","version":3,"id":"x1","cwd":"/repo/x"}\n');

	const store = new SessionStore({ root });
	await store.refresh();

	// A new session appears; a walk starts; a second caller arrives while it runs.
	writeFileSync(join(projectDir, "two.jsonl"), '{"type":"session","version":3,"id":"x2","cwd":"/repo/x"}\n');
	const inflight = store.refresh();
	assert.equal(await store.refreshIfStale(60_000), 1, "must join the walk, not report a stale index as fresh");
	assert.equal(await inflight, 1);
	rmSync(root, { recursive: true, force: true });
});

test("an mtime-only change and a size-only change each force a re-parse", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-sessions-touch-"));
	const projectDir = join(root, "--repo-x--");
	mkdirSync(projectDir, { recursive: true });
	const file = join(projectDir, "live.jsonl");
	writeFileSync(file, '{"type":"session","version":3,"id":"x1","cwd":"/repo/x"}\n');
	// Whole-second times: a later utimesSync restores mtimeMs exactly, so a size-only change
	// cannot ride in on a sub-millisecond mtime drift and pass a single-term gate.
	utimesSync(file, 1_000, 1_000);

	const store = new SessionStore({ root });
	assert.equal(await store.refresh(), 1);

	const before = statSync(file);
	utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000 + 5);
	assert.equal(statSync(file).size, before.size, "the mtime-only change must keep the size");
	assert.equal(await store.refresh(), 1, "an mtime-only change must re-parse");

	const changed = statSync(file);
	appendFileSync(file, '{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"hi"}}\n');
	utimesSync(file, changed.atimeMs / 1000, changed.mtimeMs / 1000);
	const after = statSync(file);
	assert.equal(after.mtimeMs, changed.mtimeMs, "the restored mtime must be exact");
	assert.notEqual(after.size, changed.size, "the size-only change must grow the file");
	assert.equal(await store.refresh(), 1, "a size-only change must re-parse");
	rmSync(root, { recursive: true, force: true });
});

test("overlapping roots are deduped by real path so every file is indexed once", async () => {
	const relativeRoot = relative(process.cwd(), FIXTURES);
	const store = new SessionStore({ root: FIXTURES, extraRoots: [relativeRoot] });
	const parsed = await store.refresh();
	assert.equal(parsed, 5, "the same directory reached through two spellings must not be walked twice");
	assert.equal(store.size, 5);
	const hit = resolveReference("feature-db-orm", store.all());
	assert.equal(hit.kind, "found");
	assert.equal(hit.kind === "found" && hit.session.path, join(FIXTURES, "--repo-backend--", "001_named.jsonl"));
});

test("a symlinked root that reaches an indexed root is deduped", async () => {
	const linkRoot = mkdtempSync(join(tmpdir(), "pi-sessions-link-"));
	const link = join(linkRoot, "sessions-link");
	symlinkSync(FIXTURES, link, "dir");
	try {
		const store = new SessionStore({ root: FIXTURES, extraRoots: [link] });
		await store.refresh();
		assert.equal(store.size, 5);
		// The surviving root keeps the first spelling, so the self-hide check still compares
		// against pi's own spelling of the current session file.
		assert.ok(store.get(join(FIXTURES, "--repo-backend--", "001_named.jsonl")));
	} finally {
		rmSync(linkRoot, { recursive: true, force: true });
	}

	// Reached through the symlink, session.path must stay the symlink spelling: a real path
	// would not match pi's spelling and the current session would offer itself.
	const linked = mkdtempSync(join(tmpdir(), "pi-sessions-link-root-"));
	const root = join(linked, "sessions");
	symlinkSync(FIXTURES, root, "dir");
	try {
		const store = new SessionStore({ root });
		await store.refresh();
		const self = join(root, "--repo-backend--", "001_named.jsonl");
		assert.ok(store.get(self), "the walk must keep the root's spelling");
		const visible = store.visible(DEFAULT_CONFIG, { cwd: "/repo/backend", sessionPath: self });
		assert.ok(!visible.some((session) => session.path === self), visible.map((session) => session.path).join(","));
	} finally {
		rmSync(linked, { recursive: true, force: true });
	}
});

test("expandHome expands a leading tilde and leaves other paths alone", () => {
	assert.equal(expandHome("~"), homedir());
	assert.equal(expandHome("~/sessions"), join(homedir(), "sessions"));
	assert.equal(expandHome("/abs/path"), "/abs/path");
	assert.equal(expandHome("relative"), "relative");
	assert.equal(expandHome("~weird"), "~weird");
});

test("the walk records a root that cannot be resolved instead of skipping it", async () => {
	const dead = join(tmpdir(), `pi-sessions-dead-${process.pid}-${Date.now()}`);
	const store = new SessionStore({ root: FIXTURES, extraRoots: [dead] });
	await store.refresh();
	assert.equal(store.size, 5);
	assert.equal(store.rootReport.walked, 1);
	assert.deepEqual(store.rootReport.failed, [{ root: dead, reason: "path does not resolve" }]);
});