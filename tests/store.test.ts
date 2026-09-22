import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, resolveConfig } from "../extensions/pi-sessions/config.ts";
import { isSubagent, parseSessionFile, SessionStore, textOfContent } from "../extensions/pi-sessions/store.ts";

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