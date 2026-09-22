import { test } from "node:test";
import assert from "node:assert/strict";
import {
	estimateTokens,
	extractHandoff,
	extractRelevant,
	extractTranscript,
	fitToTokens,
	renderMessage,
	TOOL_INPUT_CHARS,
	TOOL_OUTPUT_CHARS,
	touchedPaths,
} from "../extensions/pi-sessions/transcript.ts";
import type { SessionMessage } from "../extensions/pi-sessions/types.ts";

const user = (text: string): SessionMessage => ({ role: "user", content: text });
const assistant = (...blocks: unknown[]): SessionMessage => ({ role: "assistant", content: blocks as never });
const toolResult = (text: string): SessionMessage => ({ role: "toolResult", content: [{ type: "text", text }], toolName: "write" });

test("estimateTokens is chars over four, rounded up", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("abcde"), 2);
});

test("renderMessage drops thinking, keeps text, summarizes tool calls", () => {
	const message = assistant(
		{ type: "thinking", thinking: "secret reasoning" },
		{ type: "text", text: "  Writing the ORM.  " },
		{ type: "toolCall", name: "write", arguments: { path: "/repo/backend/src/db.rs" } },
	);
	const rendered = renderMessage(message);
	assert.ok(rendered);
	assert.equal(rendered.includes("secret reasoning"), false);
	assert.ok(rendered.includes("Writing the ORM."));
	assert.ok(rendered.includes("[tool write"));
	assert.ok(rendered.includes("/repo/backend/src/db.rs"));
});

test("renderMessage caps tool input and tool output", () => {
	const bigArgs = assistant({ type: "toolCall", name: "write", arguments: { path: "/x", blob: "z".repeat(5000) } });
	const renderedCall = renderMessage(bigArgs) ?? "";
	assert.ok(renderedCall.length < TOOL_INPUT_CHARS + 100);

	const renderedResult = renderMessage(toolResult("y".repeat(5000))) ?? "";
	assert.ok(renderedResult.length <= TOOL_OUTPUT_CHARS + "toolResult: ".length);

	assert.equal(renderMessage(assistant({ type: "thinking", thinking: "only thinking" })), null);
});

test("fitToTokens keeps the head or the tail and reports truncation", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
	const head = fitToTokens(lines, 20, false);
	assert.ok(head.text.startsWith("line-0"));
	assert.equal(head.truncated, true);
	const tail = fitToTokens(lines, 20, true);
	assert.ok(tail.text.trimEnd().endsWith("line-99"));
	assert.equal(tail.truncated, true);
	assert.equal(fitToTokens(["a", "b"], 1000, false).truncated, false);
});

test("fitToTokens slices an oversized line instead of returning nothing", () => {
	const huge = `HEAD${"M".repeat(392)}TAIL`; // 400 chars, larger than the 40-char budget
	const head = fitToTokens([huge], 10, false);
	assert.equal(head.text, `HEAD${"M".repeat(36)}`);
	assert.equal(head.truncated, true);

	const tail = fitToTokens([huge], 10, true);
	assert.equal(tail.text, `${"M".repeat(36)}TAIL`);
	assert.equal(tail.truncated, true);

	assert.deepEqual(fitToTokens([huge], 0, false), { text: "", truncated: true });

	const handoff = extractHandoff([user("old request"), user(huge)], 10);
	assert.equal(handoff.text, `${"M".repeat(36)}TAIL`);
	assert.equal(handoff.truncated, true);

	const veryHuge = `HEAD${"M".repeat(4888)}TAIL`; // 4896 chars, larger than the 1600-char budget
	const relevant = extractRelevant(
		[user(`postgres ${veryHuge}`), assistant({ type: "text", text: "postgres indexes" })],
		"postgres",
		400,
	);
	assert.equal(relevant.text.length, 400 * 4);
	assert.ok(relevant.text.startsWith("user: postgres HEAD"));
	assert.equal(relevant.truncated, true);
});

test("extractHandoff keeps the tail, extractTranscript keeps the head", () => {
	const messages = [
		user("first request"),
		assistant({ type: "text", text: "middle work" }),
		user("last request"),
		assistant({ type: "text", text: "final report" }),
	];

	const handoff = extractHandoff(messages, 12);
	assert.ok(handoff.text.includes("final report"));
	assert.equal(handoff.text.includes("first request"), false);

	const full = extractTranscript(messages, 12);
	assert.ok(full.text.includes("first request"));
	assert.equal(full.text.includes("final report"), false);
});

test("extractRelevant prefers matching messages and falls back to the tail", () => {
	const messages = [
		user("added the orders table"),
		assistant({ type: "text", text: "wrote migrations for postgres" }),
		user("unrelated chatter about css"),
		assistant({ type: "text", text: "done" }),
	];
	const relevant = extractRelevant(messages, "migrations postgres", 200);
	assert.ok(relevant.text.includes("migrations for postgres"));

	const noMatch = extractRelevant(messages, "zeppelin", 200);
	assert.ok(noMatch.text.includes("done"));
});

test("touchedPaths collects unique write and edit paths", () => {
	const messages = [
		assistant({ type: "toolCall", name: "write", arguments: { path: "/a.rs" } }),
		assistant({ type: "toolCall", name: "edit", arguments: { path: "/b.rs" } }),
		assistant({ type: "toolCall", name: "edit", arguments: { path: "/a.rs" } }),
		assistant({ type: "toolCall", name: "read", arguments: { path: "/c.rs" } }),
	];
	assert.deepEqual(touchedPaths(messages), ["/a.rs", "/b.rs"]);
	assert.deepEqual(touchedPaths([user("hi")]), []);
});
