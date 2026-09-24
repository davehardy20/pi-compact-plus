import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { resolveCompactionRuntimeCompatibility } from "../src/compatibility.js";

// The project pins Pi 0.83.0 for CI. Exercise the installed 0.87.1 registry
// when present without changing the package support range or using network I/O.
const hostPi = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
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
	runtimePath,
	registryPath,
	credentialsPath,
	streamPath,
].every(existsSync);

it.skipIf(!hasHostRuntime)(
	"reaches the custom provider boundary through the Pi 0.87 registry without network I/O",
	async () => {
		const [
			{ ModelRuntime },
			{ ModelRegistry },
			{ InMemoryCredentialStore },
			{ createAssistantMessageEventStream },
		] = await Promise.all(
			[runtimePath, registryPath, credentialsPath, streamPath].map(
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
				content: [{ type: "text", text: "provider boundary reached" }],
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
		const compatibility = resolveCompactionRuntimeCompatibility({
			event: {},
			modelRegistry: registry,
			compactHelperArity: 12,
		});
		expect(compatibility.streamRoute).toBe("registry");
		const abort = new AbortController();
		const stream = await compatibility.streamFn?.(
			model,
			{ messages: [] },
			{ signal: abort.signal },
		);
		const response = await stream?.result();
		expect(response).toMatchObject({
			content: [{ type: "text", text: "provider boundary reached" }],
		});
		expect(providerStream).toHaveBeenCalledTimes(1);
	},
);
