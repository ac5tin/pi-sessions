import { test } from "node:test";
import assert from "node:assert/strict";
import { collectGitInfo, formatGitSection, GIT_TIMEOUT_MS } from "../extensions/pi-sessions/git-info.ts";
import type { ExecFn } from "../extensions/pi-sessions/types.ts";

const status = " M src/db/orders.rs\n M src/db/mod.rs\n?? src/db/migrations.sql";
const diffStat = " src/db/orders.rs | 42 +++++++++---\n 1 file changed, 30 insertions(+), 12 deletions(-)";
const log = "b7c1f49 docs: agent modes\n9a2c1b8 feat: orders ORM\n1122aab chore: deps";

function fakeExec(overrides: Record<string, { stdout: string; code: number }> = {}, onCall?: (args: string[]) => void): ExecFn {
	return async (_command, args) => {
		onCall?.(args);
		const key = args.join(" ");
		if (key.includes("rev-parse")) return overrides["rev-parse"] ?? { stdout: "true\n", code: 0 };
		if (key.includes("status")) return overrides["status"] ?? { stdout: status, code: 0 };
		if (key.includes("diff")) return overrides["diff"] ?? { stdout: diffStat, code: 0 };
		if (key.includes("log")) return overrides["log"] ?? { stdout: log, code: 0 };
		return { stdout: "", code: 1 };
	};
}

test("collectGitInfo returns null when the cwd is not a git repo", async () => {
	const git = await collectGitInfo("/gone", fakeExec({ "rev-parse": { stdout: "false\n", code: 128 } }));
	assert.equal(git, null);
});

test("collectGitInfo returns null when git is missing or throws", async () => {
	const throwing: ExecFn = async () => {
		throw new Error("spawn git ENOENT");
	};
	assert.equal(await collectGitInfo("/gone", throwing), null);
});

test("collectGitInfo passes cwd, timeout, and the lock-free flags on every call", async () => {
	const calls: Array<{ args: string[] }> = [];
	let seenOptions: unknown;
	const exec: ExecFn = async (_command, args, options) => {
		calls.push({ args });
		seenOptions = options;
		return fakeExec()(_command, args, options);
	};
	await collectGitInfo("/repo/backend", exec);
	assert.equal((seenOptions as { cwd: string }).cwd, "/repo/backend");
	assert.equal((seenOptions as { timeout: number }).timeout, GIT_TIMEOUT_MS);
	assert.equal(calls.length, 4);
	assert.equal(calls.every((call) => call.args.includes("--no-optional-locks")), true);
	assert.equal(calls.every((call) => call.args.includes("--no-pager")), true);
});

test("collectGitInfo keeps partial output when one command fails", async () => {
	const git = await collectGitInfo("/repo/backend", fakeExec({ diff: { stdout: "", code: 128 } }));
	assert.ok(git);
	assert.equal(git.diffStat, "");
	assert.ok(git.status.includes("src/db/orders.rs"));
});

test("formatGitSection summarizes status codes and honors the cap", () => {
	const git = { status, diffStat, log };
	const section = formatGitSection(git, 10_000);
	assert.ok(section.includes("2 M"));
	assert.ok(section.includes("1 ??"));
	assert.ok(section.includes("diff --stat HEAD"));
	assert.ok(section.includes("b7c1f49"));

	const tiny = formatGitSection(git, 20);
	assert.equal(tiny.length, 20);
	assert.ok(tiny.startsWith("Changed: 2 M, 1 ??"));
});

test("formatGitSection returns an empty string for empty input", () => {
	assert.equal(formatGitSection({ status: "", diffStat: "", log: "" }, 100), "");
});
