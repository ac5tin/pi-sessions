import type { ContentBlock, SessionMessage } from "./types.ts";

export const TOOL_INPUT_CHARS = 900;
export const TOOL_OUTPUT_CHARS = 1600;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function blocks(message: SessionMessage): ContentBlock[] {
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return Array.isArray(message.content) ? message.content : [];
}

/** One line for the LLM. Thinking is dropped; tool calls and results are previewed. */
export function renderMessage(message: SessionMessage): string | null {
	const parts: string[] = [];
	for (const block of blocks(message)) {
		if (block.type === "thinking") continue;
		if (block.type === "text" && block.text) {
			// toolResult text is rendered below, capped at TOOL_OUTPUT_CHARS
			if (message.role === "toolResult") continue;
			const text = block.text.trim();
			if (text) parts.push(text);
		} else if (block.type === "toolCall") {
			const args = JSON.stringify(block.arguments ?? {}).slice(0, TOOL_INPUT_CHARS);
			parts.push(`[tool ${block.name ?? "unknown"} ${args}]`);
		}
	}
	if (message.role === "toolResult") {
		const output = blocks(message)
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join(" ")
			.trim()
			.slice(0, TOOL_OUTPUT_CHARS);
		if (output) parts.push(output);
	}
	const body = parts.filter(Boolean).join("\n").trim();
	return body ? `${message.role}: ${body}` : null;
}

export interface Extracted {
	text: string;
	truncated: boolean;
}

/**
 * Cut the lines down to a token budget. One oversized line is sliced, not dropped, so a
 * single message larger than the whole budget still yields bounded text instead of "".
 */
export function fitToTokens(lines: string[], maxTokens: number, fromEnd: boolean): Extracted {
	const budget = Math.max(0, maxTokens) * CHARS_PER_TOKEN;
	const source = fromEnd ? [...lines].reverse() : lines;
	const kept: string[] = [];
	let used = 0;
	let sliced = false;
	for (const line of source) {
		if (used + line.length > budget) {
			if (kept.length === 0 && budget > 0) {
				kept.push(fromEnd ? line.slice(-budget) : line.slice(0, budget));
				sliced = true;
			}
			break;
		}
		kept.push(line);
		used += line.length + 1;
	}
	return {
		text: (fromEnd ? kept.reverse() : kept).join("\n"),
		truncated: sliced || kept.length < lines.length,
	};
}

function linesOf(messages: SessionMessage[]): string[] {
	return messages.map(renderMessage).filter((line): line is string => line !== null);
}

export function extractHandoff(messages: SessionMessage[], maxTokens: number): Extracted {
	return fitToTokens(linesOf(messages), maxTokens, true);
}

export function extractTranscript(messages: SessionMessage[], maxTokens: number): Extracted {
	return fitToTokens(linesOf(messages), maxTokens, false);
}

/**
 * Lexical scoring only: term overlap. No embeddings; upgrade if recall proves poor.
 * Matching messages are returned in session order, bounded to maxTokens. `truncated`
 * reports only that matching lines were dropped: non-matching messages are omitted by
 * design, so `truncated: false` does not mean the view is complete.
 */
export function extractRelevant(messages: SessionMessage[], query: string, maxTokens: number): Extracted {
	const terms = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 2);
	if (terms.length === 0) return extractHandoff(messages, maxTokens);

	const scored = messages
		.map((message) => ({ line: renderMessage(message) }))
		.filter((entry): entry is { line: string } => entry.line !== null)
		.map((entry) => {
			const lower = entry.line.toLowerCase();
			const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
			return { ...entry, score };
		})
		.filter((entry) => entry.score > 0);

	if (scored.length === 0) return extractHandoff(messages, maxTokens);
	return fitToTokens(
		scored.map((entry) => entry.line),
		maxTokens,
		false,
	);
}

export function touchedPaths(messages: SessionMessage[]): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		for (const block of blocks(message)) {
			if (block.type !== "toolCall") continue;
			if (block.name !== "write" && block.name !== "edit") continue;
			const path = block.arguments?.path;
			if (typeof path === "string" && !seen.has(path)) {
				seen.add(path);
				paths.push(path);
			}
		}
	}
	return paths;
}
