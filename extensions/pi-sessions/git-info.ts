import type { ExecFn, GitInfo } from "./types.ts";

export const GIT_TIMEOUT_MS = 5_000;
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/** Read-only git state for a repository. Returns null when the cwd has no usable repo. */
export async function collectGitInfo(cwd: string, exec: ExecFn): Promise<GitInfo | null> {
	const options = { cwd, timeout: GIT_TIMEOUT_MS, env: GIT_ENV };
	try {
		const probe = await exec("git", ["rev-parse", "--is-inside-work-tree"], options);
		if (probe.code !== 0 || !probe.stdout.trim().startsWith("true")) return null;
	} catch {
		return null;
	}

	const run = async (args: string[]): Promise<string> => {
		try {
			const result = await exec("git", args, options);
			return result.code === 0 ? result.stdout.trim() : "";
		} catch {
			return "";
		}
	};

	const [status, diffStat, log] = await Promise.all([
		run(["--no-pager", "status", "--short"]),
		run(["--no-pager", "diff", "--stat", "HEAD"]),
		run(["--no-pager", "log", "-3", "--oneline"]),
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