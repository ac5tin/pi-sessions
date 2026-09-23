import type { IndexedSession } from "./types.ts";

/** A #token: letters, digits, dot, underscore, dash, slash. Requires start, space, or "(" before #. */
const REFERENCE_PATTERN = /(?:^|[\s(])#([A-Za-z0-9._/-]+)/g;
/**
 * An id prefix: 4+ hex characters, optionally continuing with dash-separated hex groups.
 * The dash groups matter — a real pi session id is a dashed UUID, and referenceToken emits
 * the whole id for a session with no name, so a shape that rejected dashes made every
 * unnamed-session token unresolvable while still looking correct in a note.
 */
const ID_PREFIX_PATTERN = /^[0-9a-f]{4,}(-[0-9a-f]+)*$/;

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

/** Characters `extractReferences` can read back: anything else truncates the token. */
const TOKEN_SAFE = /^[A-Za-z0-9._-]+$/;

export function resolveReference(ref: string, sessions: IndexedSession[]): Resolution {
	// Guard the primitive, not just the tool: an empty or whitespace query makes the fuzzy
	// filter below use `includes("")`, which matches every named session. A caller that
	// forgot to check would get a confident wrong answer rather than no answer.
	const query = ref.trim().toLowerCase();
	if (!query) return { kind: "missing" };

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

	// An all-digit token is an issue number, not a session: `#42` must not fuzzy-match
	// `fix-42-auth`. Exact and id resolution above stay untouched.
	if (/^\d+$/.test(query)) return { kind: "missing" };

	const fuzzy = hit(
		named.filter((s) => slugify(s.name).includes(query) || s.name.toLowerCase().includes(query)),
	);
	if (fuzzy.kind !== "missing") return fuzzy;

	return { kind: "missing" };
}

/** The token to insert for this session: short form, repo-qualified across repos, id when nothing else disambiguates. */
export function referenceToken(session: IndexedSession, sessions: IndexedSession[]): string {
	const slug = session.name ? slugify(session.name) : session.id;
	// An unnamed session has no label to shorten, and a full id always resolves.
	if (!session.name) return `#${slug}`;

	const repo = repoName(session.cwd);
	// Three ways a short token would fail to reach THIS session: the extractor cannot read a
	// character outside its pattern (a space in the repo name, a colon in the name), the id
	// branch answers first for another session whose id starts with the slug, or a same-repo
	// collision makes the repo-qualified form ambiguous. The full id always resolves.
	const idTakesSlug =
		ID_PREFIX_PATTERN.test(slug) &&
		sessions.some((s) => s.path !== session.path && s.id.toLowerCase().startsWith(slug));
	if (!TOKEN_SAFE.test(slug) || !TOKEN_SAFE.test(repo) || idTakesSlug) return `#${session.id}`;

	const sameSlug = sessions.filter((s) => s.path !== session.path && s.name && slugify(s.name) === slug);
	if (sameSlug.length === 0) return `#${slug}`;
	// A repo qualifier only disambiguates ACROSS repos. Two sessions in one repo sharing a name
	// (a clone or fork keeps the name) would both emit #repo/slug, which resolves ambiguously,
	// so fall back to the id — the id-prefix branch always resolves a unique id.
	return sameSlug.some((s) => repoName(s.cwd) === repo)
		? `#${session.id}`
		// The resolver lowercases the qualifier before comparing, so emit it lowercase.
		: `#${repo.toLowerCase()}/${slug}`;
}