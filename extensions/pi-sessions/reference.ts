import type { IndexedSession } from "./types.ts";

/** A #token: letters, digits, dot, underscore, dash, slash. Requires start, space, or "(" before #. */
const REFERENCE_PATTERN = /(?:^|[\s(])#([A-Za-z0-9._/-]+)/g;
const ID_PREFIX_PATTERN = /^[0-9a-f]{4,}$/;

export function slugify(name: string): string {
	return name.trim().toLowerCase().replace(/[\s/]+/g, "-");
}

export function repoName(cwd: string): string {
	const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
	return parts[parts.length - 1] ?? cwd;
}

export function extractReferences(text: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(REFERENCE_PATTERN)) {
		const ref = match[1]?.replace(/[.,;:!?]+$/, "");
		if (!ref || seen.has(ref)) continue;
		seen.add(ref);
		found.push(ref);
	}
	return found;
}

export function sortRecent(sessions: IndexedSession[]): IndexedSession[] {
	return [...sessions].sort((a, b) => b.modifiedMs - a.modifiedMs);
}

export type Resolution =
	| { kind: "found"; session: IndexedSession }
	| { kind: "ambiguous"; candidates: IndexedSession[] }
	| { kind: "missing" };

function hit(matches: IndexedSession[]): Resolution {
	if (matches.length === 1) return { kind: "found", session: matches[0]! };
	if (matches.length > 1) return { kind: "ambiguous", candidates: sortRecent(matches) };
	return { kind: "missing" };
}

export function resolveReference(ref: string, sessions: IndexedSession[]): Resolution {
	const query = ref.toLowerCase();

	if (ID_PREFIX_PATTERN.test(query)) {
		const byId = hit(sessions.filter((s) => s.id.toLowerCase().startsWith(query)));
		if (byId.kind !== "missing") return byId;
	}

	const slash = query.indexOf("/");
	if (slash > 0) {
		const repo = query.slice(0, slash);
		const slug = query.slice(slash + 1);
		const byRepo = hit(
			sessions.filter(
				(s) => repoName(s.cwd).toLowerCase() === repo && s.name !== undefined && slugify(s.name) === slug,
			),
		);
		if (byRepo.kind !== "missing") return byRepo;
	}

	const named = sessions.filter((s): s is IndexedSession & { name: string } => s.name !== undefined);
	const exact = hit(named.filter((s) => slugify(s.name) === query));
	if (exact.kind !== "missing") return exact;

	const fuzzy = hit(
		named.filter((s) => slugify(s.name).includes(query) || s.name.toLowerCase().includes(query)),
	);
	if (fuzzy.kind !== "missing") return fuzzy;

	return { kind: "missing" };
}

/** The token to insert for this session: short form, or repo-qualified on collision. */
export function referenceToken(session: IndexedSession, sessions: IndexedSession[]): string {
	const slug = session.name ? slugify(session.name) : session.id;
	if (!session.name) return `#${slug}`;
	const collides = sessions.some((s) => s.path !== session.path && s.name && slugify(s.name) === slug);
	return collides ? `#${repoName(session.cwd)}/${slug}` : `#${slug}`;
}