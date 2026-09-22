import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, resolveConfig } from "../extensions/pi-sessions/config.ts";

test("garbage input returns defaults", () => {
	assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG);
	assert.deepEqual(resolveConfig("nope"), DEFAULT_CONFIG);
	assert.deepEqual(resolveConfig(42), DEFAULT_CONFIG);
});

test("valid keys override defaults", () => {
	const cfg = resolveConfig({ showSubagents: true, minMessages: 5, summaryMode: "off" });
	assert.equal(cfg.showSubagents, true);
	assert.equal(cfg.minMessages, 5);
	assert.equal(cfg.summaryMode, "off");
});

test("wrong types fall back to defaults and unknown keys are ignored", () => {
	const cfg = resolveConfig({ minMessages: "many", summaryMode: "maybe", nope: 1 });
	assert.equal(cfg.minMessages, DEFAULT_CONFIG.minMessages);
	assert.equal(cfg.summaryMode, DEFAULT_CONFIG.summaryMode);
	assert.equal("nope" in cfg, false);
});

test("array keys keep only non-empty strings", () => {
	const cfg = resolveConfig({ extraRoots: ["/a", "", 7, "/b"], hidePatterns: ["oracle"] });
	assert.deepEqual(cfg.extraRoots, ["/a", "/b"]);
	assert.deepEqual(cfg.hidePatterns, ["oracle"]);
});

test("digestTokens is clamped to maxDigestTokens", () => {
	const cfg = resolveConfig({ digestTokens: 99_999, maxDigestTokens: 1000 });
	assert.equal(cfg.digestTokens, 1000);
});

test("missing config file returns defaults", () => {
	assert.deepEqual(loadConfig(join(tmpdir(), "definitely-missing-pi-sessions.json")), DEFAULT_CONFIG);
});

test("partial config file merges over defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sessions-cfg-"));
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({ minMessages: 1, extraRoots: [dir] }));
	const cfg = loadConfig(path);
	assert.equal(cfg.minMessages, 1);
	assert.deepEqual(cfg.extraRoots, [dir]);
	assert.equal(cfg.summaryTimeoutMs, DEFAULT_CONFIG.summaryTimeoutMs);
});

test("returned configs do not share DEFAULT_CONFIG arrays", () => {
	assert.notEqual(resolveConfig({}).extraRoots, DEFAULT_CONFIG.extraRoots);
	assert.notEqual(resolveConfig({}).hidePatterns, DEFAULT_CONFIG.hidePatterns);
	const mutated = resolveConfig({});
	mutated.extraRoots.push("/leak");
	assert.deepEqual(DEFAULT_CONFIG.extraRoots, []);
	assert.notEqual(
		loadConfig(join(tmpdir(), "definitely-missing-pi-sessions.json")).hidePatterns,
		DEFAULT_CONFIG.hidePatterns,
	);
});
