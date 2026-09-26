import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

// Version bridge only: Compact+ resolves the locked 0.87 package in this Vitest
// process, so forward its import to the isolated *real* 0.87 helper. Neither
// the helper, Pi session manager, nor model registry behavior is substituted.
const { invokePi087Compact } = vi.hoisted(() => ({
	invokePi087Compact: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	compact: (...args: unknown[]) => invokePi087Compact(...args),
}));

import { runCustomCompaction } from "../src/compact.js";
import { resolveCompactionRuntimeCompatibility } from "../src/compatibility.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

// CI provisions an exact, isolated Pi 0.87.1 tree; local opt-in uses the
// same variable. An unset path skips locally; an invalid configured path fails.
const configuredPi = process.env.PI_COMPACT_PLUS_TEST_PI_087_ROOT;
const paths = configuredPi
	? {
			compact: join(configuredPi, "dist/core/compaction/compaction.js"),
			session: join(configuredPi, "dist/core/session-manager.js"),
			runtime: join(configuredPi, "dist/core/model-runtime.js"),
			registry: join(configuredPi, "dist/core/model-registry.js"),
			credentials: join(
				configuredPi,
				"node_modules/@earendil-works/pi-ai/dist/auth/credential-store.js",
			),
			stream: join(
				configuredPi,
				"node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
			),
		}
	: null;
const hasRuntime = paths !== null && Object.values(paths).every(existsSync);
if (configuredPi && !hasRuntime) {
	throw new Error("Configured Pi 0.87 test runtime is incomplete");
}

it.skipIf(!hasRuntime)(
	"routes real Pi 0.87 session preparation and compaction through the custom provider without network I/O",
	async () => {
		const root = configuredPi as string;
		const installed = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as { version?: string };
		expect(installed.version).toBe("0.87.1");
		for (const pkg of ["pi-agent-core", "pi-ai"]) {
			const nested = JSON.parse(
				readFileSync(
					join(root, "node_modules/@earendil-works", pkg, "package.json"),
					"utf8",
				),
			) as { version?: string };
			expect(nested.version, pkg).toBe("0.87.1");
		}
		const [
			{ compact: compact087, prepareCompaction },
			{ SessionManager },
			{ ModelRuntime },
			{ ModelRegistry },
			{ InMemoryCredentialStore },
			{ createAssistantMessageEventStream },
		] = await Promise.all(
			Object.values(paths as NonNullable<typeof paths>).map(
				(path) => import(/* @vite-ignore */ pathToFileURL(path).href),
			),
		);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const registry = new ModelRegistry(runtime);
		const model = {
			provider: "test-custom-route",
			id: "route-test",
			api: "openai-completions",
			baseUrl: "https://original.example.test/v1",
			maxTokens: 4096,
		};
		const credential = ["sentinel", "secret"].join("-");
		let summaryText = VALID_STRUCTURED_SUMMARY;
		const providerStream = vi.fn((requestModel, _context, options) => {
			expect(requestModel.baseUrl).toBe("https://routed.example.test/v1");
			expect(options.apiKey).toBe(credential);
			expect(options.headers).toEqual({ "x-route": "sentinel-header" });
			expect(options.env).toEqual({ ROUTE_REGION: "test-region" });
			const stream = createAssistantMessageEventStream();
			stream.end({
				role: "assistant",
				content: [{ type: "text", text: summaryText }],
				stopReason: "stop",
				usage: { input: 1, output: 1, totalTokens: 2 },
			});
			return stream;
		});
		registry.registerProvider({
			id: model.provider,
			name: "Test custom route",
			auth: {
				apiKey: {
					name: "Fixture",
					resolve: async () => ({
						auth: {
							apiKey: credential,
							headers: { "x-route": "sentinel-header" },
							baseUrl: "https://routed.example.test/v1",
						},
						env: { ROUTE_REGION: "test-region" },
					}),
				},
			},
			getModels: () => [model],
			streamSimple: providerStream,
			stream: () => {
				throw new Error("unexpected provider stream route");
			},
		});
		expect(compact087.length).toBeGreaterThanOrEqual(8);
		invokePi087Compact.mockImplementation((...args: unknown[]) =>
			compact087(...args),
		);
		const registryStream = vi.spyOn(registry, "streamSimple");
		const compatibility = resolveCompactionRuntimeCompatibility({
			event: {},
			modelRegistry: registry,
			compactHelperArity: compact087.length,
		});
		expect(compatibility.streamRoute).toBe("registry");
		const session = SessionManager.inMemory();
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Investigate request routing" }],
			timestamp: Date.now(),
		});
		session.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-087",
					name: "read",
					arguments: { path: "src/compact.ts" },
				},
			],
			api: "openai-completions",
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			timestamp: Date.now(),
			usage: { input: 1, output: 1, totalTokens: 2 },
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-087",
			toolName: "read",
			content: [{ type: "text", text: "Historical output ".repeat(90) }],
			isError: false,
			timestamp: Date.now(),
		});
		const redirect = "Stop investigating; finish the approved repair instead.";
		const keptId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: redirect }],
			timestamp: Date.now(),
		});
		const preparation = prepareCompaction(session.getBranch(), {
			enabled: true,
			reserveTokens: 1024,
			keepRecentTokens: 16,
		});
		expect(preparation?.firstKeptEntryId).toBe(keptId);
		expect(
			preparation?.messagesToSummarize.some(
				(m: { role: string }) => m.role === "toolResult",
			),
		).toBe(true);
		const abort = new AbortController();
		const attempt = await runCustomCompaction(
			preparation,
			"standard",
			{
				model,
				modelRegistry: registry,
				signal: abort.signal,
			} as unknown as ExtensionContext,
			compatibility,
		);
		expect(attempt.fallbackReason).toBeNull();
		expect(attempt.result?.summary).toContain("## Current Objective");
		if (!attempt.result) throw new Error("Expected a validated custom summary");
		session.appendCompaction(
			attempt.result.summary,
			attempt.result.firstKeptEntryId,
			attempt.result.tokensBefore,
			attempt.result.details,
			true,
			attempt.result.usage,
		);
		const projected = session.buildSessionContext().messages;
		expect(projected[0]?.role).toBe("compactionSummary");
		expect(
			projected.some(
				(m: { role: string; content: unknown }) =>
					m.role === "user" && JSON.stringify(m.content).includes(redirect),
			),
		).toBe(true);
		expect(invokePi087Compact).toHaveBeenCalledTimes(1);
		expect(registryStream).toHaveBeenCalledTimes(1);
		const [requestModel, , rawOptions] = registryStream.mock.calls[0] ?? [];
		const requestOptions = rawOptions as Record<string, unknown>;
		expect(requestModel).toBe(model);
		expect(requestOptions).toMatchObject({
			signal: abort.signal,
			cacheRetention: "none",
		});
		expect(requestOptions.apiKey).toBeUndefined();
		expect(requestOptions.headers).toBeUndefined();
		expect(requestOptions.env).toBeUndefined();
		expect(providerStream).toHaveBeenCalledTimes(1);
		// Same real helper and registry: an invalid response must not create a
		// compaction entry. Pi may then use its native fallback outside this test.
		summaryText = "A plausible-looking but unstructured summary";
		const entriesBefore = session.getEntries().length;
		const invalid = await runCustomCompaction(
			preparation,
			"standard",
			{
				model,
				modelRegistry: registry,
				signal: abort.signal,
			} as unknown as ExtensionContext,
			compatibility,
		);
		expect(invalid.result).toBeUndefined();
		expect(invalid.fallbackReason).toMatch(/^compaction summary invalid:/);
		expect(session.getEntries()).toHaveLength(entriesBefore);
		expect(providerStream).toHaveBeenCalledTimes(2);
	},
);
