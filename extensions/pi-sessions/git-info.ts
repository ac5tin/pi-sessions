import type { ExecFn, GitInfo } from "./types.ts";

export const GIT_TIMEOUT_MS = 5_000;

// Lock avoidance rides in ARGS, never in env: pi.exec forwards its options to
// execCommand, which spawns with { cwd, shell, stdio } only and ignores
// options.env entirely. An env-based guarantee would be inert in production
// while unit tests against a fake exec would still pass. `--no-optional-locks`
// (git >= 2.15) is the flag form, and it keeps this module from taking the
// index lock that the other pi session may be committing against.
const GIT_FLAGS = ["--no-pager", "--no-optional-locks"];

/** Read-only git state for a repository. Returns null when the cwd has no usable repo. */
export async function collectGitInfo(cwd: string, exec: ExecFn): Promise<GitInfo | null> {
	const options = { cwd, timeout: GIT_TIMEOUT_MS };
	try {
		const probe = await exec("git", [...GIT_FLAGS, "rev-parse", "--is-inside-work-tree"], options);
		if (probe.code !== 0 || !probe.stdout.trim().startsWith("true")) return null;
	} catch {
		return null;
	}

	const run = async (args: string[]): Promise<string> => {
		try {
			const result = await exec("git", [...GIT_FLAGS, ...args], options);
			return result.code === 0 ? result.stdout.trim() : "";
		} catch {
			return "";
		}
	};

	const [status, diffStat, log] = await Promise.all([
		run(["status", "--short"]),
		run(["diff", "--stat", "HEAD"]),
		run(["log", "-3", "--oneline"]),
	]);

	return { status, diffStat, log };
}

export function formatGitSection(git: GitInfo, maxChars: number): string {
	const counts = new Map<string, number>();
	for (const line of git.status.split("\n")) {
		const code = line.slice(0, 2).trim();
		if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
	}
	const summary = [...counts.entries()].map(([code, count]) => `${count} ${code}`).join(", ");
	const parts = [
		summary ? `Changed: ${summary}` : "",
		git.diffStat ? `diff --stat HEAD:\n${git.diffStat}` : "",
		git.log ? `log:\n${git.log}` : "",
	].filter(Boolean);
	return parts.join("\n").slice(0, maxChars);
}
