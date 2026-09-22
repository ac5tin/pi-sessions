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

test("cache write then read returns the text, and prunes older keys", async () => {
	const dir = tempDir();
	await writeCachedSummary(dir, "a1b2c3d4-1000-2048-m1", "a1b2c3d4", "older");
	await writeCachedSummary(dir, "a1b2c3d4-2000-2048-m1", "a1b2c3d4", "newer");
	const files = readdirSync(dir);
	assert.deepEqual(files, ["a1b2c3d4-2000-2048-m1.md"]);
	assert.equal(await findCachedSummary(dir, "a1b2c3d4-2000-2048-m1"), "newer");
	assert.equal(await findCachedSummary(dir, "a1b2c3d4-9999-2048-m1"), null);
	rmSync(dir, { recursive: true, force: true });
});

test("a cache hit skips the model call entirely", async () => {
	const dir = tempDir();
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
	rmSync(dir, { recursive: true, force: true });
});

test("a cache miss calls the model once and caches the result", async () => {
	const dir = tempDir();
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
	rmSync(dir, { recursive: true, force: true });
});

test("a model error returns an error instead of throwing", async () => {
	const dir = tempDir();
	const stream = async (): Promise<string> => {
		throw new Error("provider exploded");
	};
	const result = await getSummary(session, messages, { stream, cacheDir: dir, modelId: "m" }, 1000);
	assert.deepEqual(result, { error: "provider exploded" });
	rmSync(dir, { recursive: true, force: true });
});

test("a hanging model hits the timeout and returns an error", async () => {
	const dir = tempDir();
	const stream = (_prompt: string, signal: AbortSignal): Promise<string> =>
		new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("aborted")));
		});
	const started = Date.now();
	const result = await getSummary(session, messages, { stream, cacheDir: dir, modelId: "m" }, 60);
	assert.ok("error" in result);
	assert.ok(Date.now() - started < 2000);
	rmSync(dir, { recursive: true, force: true });
});

test("a session with no readable content returns an error", async () => {
	const dir = tempDir();
	const result = await getSummary(
		session,
		[{ role: "assistant", content: [{ type: "thinking", thinking: "only thinking" }] }],
		{ stream: async () => "never", cacheDir: dir, modelId: "m" },
		1000,
	);
	assert.deepEqual(result, { error: "referenced session has no readable content" });
	rmSync(dir, { recursive: true, force: true });
});