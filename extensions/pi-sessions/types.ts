/** One session file discovered on disk. Cheap to build: no message bodies. */
export interface IndexedSession {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	messageCount: number;
	firstUserMessage: string;
	modifiedMs: number;
	size: number;
	mtimeMs: number;
}

/** Structural subset of pi's content blocks. Real pi messages match this. */
export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

/** Structural subset of pi's AgentMessage. Real pi messages match this. */
export interface SessionMessage {
	role: string;
	content?: string | ContentBlock[];
	toolName?: string;
}

export interface GitInfo {
	status: string;
	diffStat: string;
	log: string;
}

export interface ExecResult {
	stdout: string;
	code: number;
}

export interface ExecOptions {
	cwd?: string;
	timeout?: number;
}

export type ExecFn = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;
