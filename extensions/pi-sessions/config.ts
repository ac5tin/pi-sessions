import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Config {
	showSubagents: boolean;
	minMessages: number;
	maxReferences: number;
	digestTokens: number;
	maxDigestTokens: number;
	summaryMode: "blocking" | "off";
	summaryTimeoutMs: number;
	summaryModel: string | null;
	extraRoots: string[];
	hidePatterns: string[];
}

export const DEFAULT_CONFIG: Config = {
	showSubagents: false,
	minMessages: 3,
	maxReferences: 3,
	digestTokens: 6000,
	maxDigestTokens: 12000,
	summaryMode: "blocking",
	summaryTimeoutMs: 120_000,
	summaryModel: null,
	extraRoots: [],
	hidePatterns: [],
};

export const CACHE_DIR_NAME = "pi-sessions-cache";

function isPositiveInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_SESSIONS_CONFIG ?? join(getAgentDir(), "pi-sessions.json");
}

export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_SESSIONS_ROOT ?? join(getAgentDir(), "sessions");
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(), CACHE_DIR_NAME);
}

export function resolveConfig(raw: unknown): Config {
	const cfg: Config = { ...DEFAULT_CONFIG };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return cfg;
	const input = raw as Record<string, unknown>;

	if (typeof input.showSubagents === "boolean") cfg.showSubagents = input.showSubagents;
	if (isPositiveInt(input.minMessages)) cfg.minMessages = input.minMessages;
	if (isPositiveInt(input.maxReferences)) cfg.maxReferences = input.maxReferences;
	if (isPositiveInt(input.digestTokens)) cfg.digestTokens = input.digestTokens;
	if (isPositiveInt(input.maxDigestTokens)) cfg.maxDigestTokens = input.maxDigestTokens;
	if (input.summaryMode === "blocking" || input.summaryMode === "off") cfg.summaryMode = input.summaryMode;
	if (isPositiveInt(input.summaryTimeoutMs)) cfg.summaryTimeoutMs = input.summaryTimeoutMs;
	if (isNonEmptyString(input.summaryModel)) cfg.summaryModel = input.summaryModel;
	if (Array.isArray(input.extraRoots)) cfg.extraRoots = input.extraRoots.filter(isNonEmptyString);
	if (Array.isArray(input.hidePatterns)) cfg.hidePatterns = input.hidePatterns.filter(isNonEmptyString);

	if (cfg.digestTokens > cfg.maxDigestTokens) cfg.digestTokens = cfg.maxDigestTokens;
	return cfg;
}

export function loadConfig(path: string = configPath()): Config {
	try {
		return resolveConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
