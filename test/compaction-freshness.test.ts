import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	captureModelSnapshot,
	modelMatchesSnapshot,
} from "../src/compaction-freshness.js";

function fixture() {
	return {
		id: "fixture",
		provider: "offline",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		name: "Display name",
		contextWindow: 65_536,
		maxTokens: 4096,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		headers: { "X-Fixture": "original" },
		compat: { supportsDeveloperRole: true },
	} as NonNullable<ExtensionContext["model"]>;
}

describe("attempt-local model snapshot", () => {
	it("accepts deep equivalent replacements and ignores labels/prices", () => {
		const model = fixture();
		const snapshot = captureModelSnapshot(model);
		const replacement = structuredClone(model);
		replacement.name = "Refreshed display label";
		replacement.cost.input = 10;
		expect(modelMatchesSnapshot(snapshot, replacement)).toBe(true);
	});

	it.each([
		["id", "other"],
		["provider", "other"],
		["api", "anthropic-messages"],
		["baseUrl", "https://other.invalid"],
		["contextWindow", 32_768],
		["maxTokens", 8192],
		["input", ["text", "image"]],
		["reasoning", true],
		["headers", { "X-Fixture": "changed" }],
		["compat", { supportsDeveloperRole: false }],
		["inputLimits", { maxImageDimension: 1024 }],
		["thinkingLevelMap", { high: "disabled" }],
		["samplingParams", { temperature: 0.5 }],
		["futureRoutingField", { route: "changed" }],
	])("rejects in-place and replacement %s changes", (field, value) => {
		const model = fixture();
		const snapshot = captureModelSnapshot(model);
		const replacement = { ...structuredClone(model), [field as string]: value };
		expect(modelMatchesSnapshot(snapshot, replacement)).toBe(false);
		Object.assign(model, { [field as string]: value });
		expect(modelMatchesSnapshot(snapshot, model)).toBe(false);
	});

	it("captures nested values rather than retaining their references", () => {
		const model = fixture();
		const snapshot = captureModelSnapshot(model);
		Object.assign(model.headers ?? {}, { "X-Fixture": "changed" });
		expect(modelMatchesSnapshot(snapshot, model)).toBe(false);
	});

	it("fails closed on missing, unreadable or uncloneable models", () => {
		const model = fixture();
		expect(captureModelSnapshot(undefined)).toBeNull();
		expect(modelMatchesSnapshot(captureModelSnapshot(model), undefined)).toBe(
			false,
		);
		Object.defineProperty(model, "baseUrl", {
			get: () => {
				throw new Error("Private fixture value");
			},
			enumerable: true,
		});
		expect(captureModelSnapshot(model)).toBeNull();
		expect(modelMatchesSnapshot(captureModelSnapshot(fixture()), model)).toBe(
			false,
		);
		const uncloneable = Object.assign(fixture(), { extensionHook: () => {} });
		expect(captureModelSnapshot(uncloneable)).toBeNull();
		expect(modelMatchesSnapshot(null, fixture())).toBe(false);
	});
});
