import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSummaryPrompt,
	findCachedSummary,
	getSummary,
	summaryCacheKey,
	writeCachedSummary,
} from "../extensions/pi-sessions/summary.ts";
import type { IndexedSession, SessionMessage } from "../extensions/pi-sessions/types.ts";

const session: IndexedSession = {
	path: "/s/a.jsonl",
	id: "a1b2c3d4",
	cwd: "/repo/backend",
	name: "feature-db-orm",
	messageCount: 12,
	firstUserMessage: "build the orm",
	modifiedMs: 1_000,
	size: 2_048,
	mtimeMs: 1_000,
};

const messages: SessionMessage[] = [{ role: "user", content: "build the orm" }];

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-sessions-sum-"));
}

test("cache key changes with content, size, and model", () => {
	const base = summaryCacheKey(session, "anthropic/claude");
	assert.equal(base, "a1b2c3d4-1000-2048-anthropic_claude");
	assert.notEqual(base, summaryCacheKey({ ...session, mtimeMs: 2000 }, "anthropic/claude"));
	assert.notEqual(base, summaryCacheKey({ ...session, size: 999 }, "anthropic/claude"));
	assert.notEqual(base, summaryCacheKey(session, "openai/gpt-4o"));
});

test("prompt asks for a handoff and includes the transcript", () => {
	const prompt = buildSummaryPrompt("user: build the orm");
	assert.ok(prompt.includes("handoff"));
	assert.ok(prompt.includes("unfinished"));
	assert.ok(prompt.includes("user: build the orm"));
});

test("cache write then read returns the text, and prunes older keys", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	await writeCachedSummary(dir, "a1b2c3d4-1000-2048-m1", "a1b2c3d4", "older");
	await writeCachedSummary(dir, "a1b2c3d4-2000-2048-m1", "a1b2c3d4", "newer");
	const files = readdirSync(dir);
	assert.deepEqual(files, ["a1b2c3d4-2000-2048-m1.md"]);
	assert.equal(await findCachedSummary(dir, "a1b2c3d4-2000-2048-m1"), "newer");
	assert.equal(await findCachedSummary(dir, "a1b2c3d4-9999-2048-m1"), null);
});

test("pruning one session keeps a dash-prefixed session's cache file", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	await writeCachedSummary(dir, "abc-1000-2048-m", "abc", "abc older");
	await writeCachedSummary(dir, "abc-def-1000-2048-m", "abc-def", "other session");
	await writeCachedSummary(dir, "abc-2000-2048-m", "abc", "abc newer");
	assert.deepEqual(readdirSync(dir).sort(), ["abc-2000-2048-m.md", "abc-def-1000-2048-m.md"]);
	assert.equal(await findCachedSummary(dir, "abc-2000-2048-m"), "abc newer");
	assert.equal(await findCachedSummary(dir, "abc-def-1000-2048-m"), "other session");
});

test("a crafted session id neither escapes nor accumulates in the cache directory", async (t) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-sessions-parent-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const dir = join(parent, "cache");
	const crafted = { ...session, id: "../../evil" };
	const key = summaryCacheKey({ ...crafted, mtimeMs: 2000 }, "m");
	await writeCachedSummary(dir, summaryCacheKey(crafted, "m"), crafted.id, "crafted older");
	await writeCachedSummary(dir, key, crafted.id, "crafted newer");
	assert.deepEqual(readdirSync(dir), [".._.._evil-2000-2048-m.md"]);
	assert.deepEqual(readdirSync(parent), ["cache"]);
	assert.ok(!key.includes("/"), `key must carry no path separator: ${key}`);
});

test("an empty session id prunes its own older keys only", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	await writeCachedSummary(dir, "abc-1000-2048-m", "abc", "abc summary");
	await writeCachedSummary(dir, "-1000-2048-m", "", "empty older");
	await writeCachedSummary(dir, "-2000-2048-m", "", "empty newer");
	assert.deepEqual(readdirSync(dir).sort(), ["-2000-2048-m.md", "abc-1000-2048-m.md"]);
	assert.equal(await findCachedSummary(dir, "-2000-2048-m"), "empty newer");
	assert.equal(await findCachedSummary(dir, "abc-1000-2048-m"), "abc summary");
});

test("a negative mtime still prunes its own older keys", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const older = { ...session, mtimeMs: -5 };
	const newer = { ...session, mtimeMs: -4 };
	await writeCachedSummary(dir, summaryCacheKey(older, "m"), older.id, "past older");
	await writeCachedSummary(dir, summaryCacheKey(newer, "m"), newer.id, "past newer");
	assert.deepEqual(readdirSync(dir), [`${summaryCacheKey(newer, "m")}.md`]);
});

test("a cache hit skips the model call entirely", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	let calls = 0;
	const stream = async (): Promise<string> => {
		calls++;
		return "fresh";
	};
	const key = summaryCacheKey(session, "m");
	await writeCachedSummary(dir, key, session.id, "from cache");
	const result = await getSummary(session, messages, { stream, cacheDir: dir, modelId: "m" }, 1000);
	assert.deepEqual(result, { text: "from cache", cached: true });
	assert.equal(calls, 0);
});

test("a cache miss calls the model once and caches the result", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	let calls = 0;
	const stream = async (): Promise<string> => {
		calls++;
		return "  handoff text  ";
	};
	const first = await getSummary(session, messages, { stream, cacheDir: dir, modelId: "m" }, 1000);
	assert.deepEqual(first, { text: "handoff text", cached: false });
	assert.equal(calls, 1);
	const second = await getSummary(session, messages, { stream, cacheDir: dir, modelId: "m" }, 1000);
	assert.deepEqual(second, { text: "handoff text", cached: true });
	assert.equal(calls, 1);
});

test("a model error returns an error instead of throwing", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const stream = async (): Promise<string> => {
		throw new Error("provider exploded");
	};
	const result = await getSummary(session, messages, { stream, cacheDir: dir, modelId: "m" }, 1000);
	assert.deepEqual(result, { error: "provider exploded" });
});

test("a hanging model hits the timeout and returns an error", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const stream = (_prompt: string, signal: AbortSignal): Promise<string> =>
		new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")));
		});
	const started = Date.now();
	const result = await getSummary(session, messages, { stream, cacheDir: dir, modelId: "m" }, 60);
	assert.deepEqual(result, { error: "summary timed out" });
	assert.ok(Date.now() - started < 2000);
});

test("a stream that ignores the abort still yields the same timeout error", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const stream = (): Promise<string> => new Promise(() => {});
	const started = Date.now();
	const result = await getSummary(session, messages, { stream, cacheDir: dir, modelId: "m" }, 60);
	assert.deepEqual(result, { error: "summary timed out" });
	assert.ok(Date.now() - started < 2000);
});

test("a session with no readable content returns an error", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const result = await getSummary(
		session,
		[{ role: "assistant", content: [{ type: "thinking", thinking: "only thinking" }] }],
		{ stream: async () => "never", cacheDir: dir, modelId: "m" },
		1000,
	);
	assert.deepEqual(result, { error: "referenced session has no readable content" });
});

test("a malformed message returns an error instead of throwing", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const malformed = [{ role: "assistant", content: [{ type: "text", text: 42 }] }] as unknown as SessionMessage[];
	const result = await getSummary(
		session,
		malformed,
		{ stream: async () => "never", cacheDir: dir, modelId: "m" },
		1000,
	);
	assert.ok("error" in result);
});