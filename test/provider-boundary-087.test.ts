import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

const { invokePi087Compact } = vi.hoisted(() => ({
	invokePi087Compact: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	compact: (...args: unknown[]) => invokePi087Compact(...args),
}));

import { runCustomCompaction } from "../src/compact.js";
import { resolveCompactionRuntimeCompatibility } from "../src/compatibility.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

// CI installs an isolated, exact Pi 0.87.1 runtime; locally use the host install
// if present. A configured CI path must fail rather than silently skip.
const configuredPi = process.env.PI_COMPACT_PLUS_TEST_PI_087_ROOT;
const defaultHostPi =
	"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const hostPi = configuredPi ?? defaultHostPi;
const compactPath = join(hostPi, "dist/core/compaction/compaction.js");
const runtimePath = join(hostPi, "dist/core/model-runtime.js");
const registryPath = join(hostPi, "dist/core/model-registry.js");
const credentialsPath = join(
	hostPi,
	"node_modules/@earendil-works/pi-ai/dist/auth/credential-store.js",
);
const streamPath = join(
	hostPi,
	"node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
);
const hasHostRuntime = [
	compactPath,
	runtimePath,
	registryPath,
	credentialsPath,
	streamPath,
].every(existsSync);
if (configuredPi && !hasHostRuntime) {
	throw new Error("Configured Pi 0.87 test runtime is incomplete");
}

it.skipIf(!hasHostRuntime)(
	"routes a real Pi 0.87 compaction helper to a custom provider without network I/O",
	async () => {
		const installed = JSON.parse(
			readFileSync(join(hostPi, "package.json"), "utf8"),
		) as { version?: string };
		expect(installed.version).toBe("0.87.1");
		const [
			{ compact: compact087 },
			{ ModelRuntime },
			{ ModelRegistry },
			{ InMemoryCredentialStore },
			{ createAssistantMessageEventStream },
		] = await Promise.all(
			[compactPath, runtimePath, registryPath, credentialsPath, streamPath].map(
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
		const providerStream = vi.fn((requestModel, _context, options) => {
			expect(requestModel.baseUrl).toBe("https://routed.example.test/v1");
			expect(options.apiKey).toBe(credential);
			expect(options.headers).toEqual({ "x-route": "sentinel-header" });
			expect(options.env).toEqual({ ROUTE_REGION: "test-region" });
			const stream = createAssistantMessageEventStream();
			stream.end({
				role: "assistant",
				content: [{ type: "text", text: VALID_STRUCTURED_SUMMARY }],
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
		const abort = new AbortController();
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
			{
				model,
				modelRegistry: registry,
				signal: abort.signal,
			} as unknown as ExtensionContext,
			compatibility,
		);
		expect(attempt.fallbackReason).toBeNull();
		expect(attempt.result?.summary).toContain("## Current Objective");
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
	},
);
