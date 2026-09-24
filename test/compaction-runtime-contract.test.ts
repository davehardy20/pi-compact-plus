import {
	compact,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { runCustomCompaction } from "../src/compact.js";
import { resolveCompactionRuntimeCompatibility } from "../src/compatibility.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

it("routes a real Pi compaction helper through the registry without a network call", async () => {
	const model = {
		provider: "custom-route",
		id: "route-test",
		api: "openai-completions",
		baseUrl: "https://original.example.test/v1",
		maxTokens: 4096,
	};
	const abort = new AbortController();
	const streamSimple = vi.fn(() => ({
		result: async () => ({
			role: "assistant",
			content: [{ type: "text", text: VALID_STRUCTURED_SUMMARY }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				totalTokens: 2,
			},
		}),
	}));
	const registry = {
		getApiKeyAndHeaders: vi.fn(async () => ({
			ok: true,
			apiKey: ["sentinel", "secret"].join("-"),
			headers: { "x-route": "sentinel-header", "x-deleted": null },
			baseUrl: "https://routed.example.test/v1",
			env: { ROUTE_REGION: "test-region" },
		})),
		streamSimple,
	};
	const ctx = {
		model,
		modelRegistry: registry,
		signal: abort.signal,
	} as unknown as ExtensionContext;
	const compatibility = resolveCompactionRuntimeCompatibility({
		event: {},
		modelRegistry: registry,
	});
	const attempt = await runCustomCompaction(
		{
			firstKeptEntryId: "entry-2",
			messagesToSummarize: [
				{
					role: "user",
					content: [{ type: "text", text: "Investigate request routing" }],
					timestamp: Date.now(),
				},
			],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 42,
			fileOps: { read: new Set(), edited: new Set(), written: new Set() },
			settings: { reserveTokens: 1024 },
		} as never,
		"standard",
		ctx,
		compatibility,
	);
	// No provider, fetch, or network implementation is registered in this test.
	expect(compact.length).toBeGreaterThanOrEqual(8);
	expect(compatibility.executionPath).toBe("custom");
	expect(attempt.fallbackReason).toBeNull();
	expect(attempt.result?.summary).toContain("## Current Objective");
	expect(streamSimple).toHaveBeenCalledTimes(1);
	const [requestModel, , options] = streamSimple.mock.calls[0] as unknown as [
		Record<string, unknown>,
		unknown,
		Record<string, unknown>,
	];
	expect(requestModel).toBe(model);
	expect(requestModel.baseUrl).toBe("https://original.example.test/v1");
	expect(options.apiKey).toBeUndefined();
	expect(options.headers).toBeUndefined();
	expect(options.env).toBeUndefined();
	expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	expect(options.signal).toBe(abort.signal);
	expect(options.cacheRetention).toBe("none");
	expect(options.sessionId).toEqual(expect.any(String));
});
