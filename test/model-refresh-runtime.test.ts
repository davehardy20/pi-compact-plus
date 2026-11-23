import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import * as projectSdk from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import { findInstalledPiRuntime } from "./fixtures/pi-runtime-discovery.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

const installedRoot = findInstalledPiRuntime("1.3.0");

it.for(["project", "installed 1.3.0"])(
	"%s SDK: unrelated provider registration preserves a paid summary",
	async (version, test) => {
		if (version !== "project" && !installedRoot) {
			test.skip();
			return;
		}
		const sdk: typeof projectSdk =
			version === "project"
				? projectSdk
				: await import(
						pathToFileURL(join(installedRoot ?? "", "dist/index.js")).href
					);
		const root = mkdtempSync(join(tmpdir(), "compact-plus-model-refresh-"));
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Unexpected network request"));
		let host: projectSdk.AgentSession | undefined;
		try {
			const model: Model<"openai-completions"> = {
				id: "offline-model",
				name: "Offline model refresh fixture",
				provider: "offline-fixture",
				api: "openai-completions",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				contextWindow: 65_536,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const runtime = await sdk.ModelRuntime.create({
				modelsPath: null,
				credentials: new InMemoryCredentialStore(),
				refreshOnCreate: false,
				allowModelNetwork: false,
			});
			runtime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				models: [model],
			});
			const settings = sdk.SettingsManager.inMemory({
				compaction: {
					enabled: true,
					reserveTokens: 4096,
					keepRecentTokens: 100,
				},
				cacheWarming: "off",
			});
			const manager = sdk.SessionManager.inMemory(root);
			for (const text of [
				"Earlier task. ".repeat(1000),
				"Retain this follow-up. ".repeat(150),
			]) {
				manager.appendMessage({
					role: "user",
					content: text,
					timestamp: Date.now(),
				});
				manager.appendMessage(reply("Acknowledged."));
			}
			const state = new CompactionState();
			const stream = vi.fn();
			const extension: projectSdk.ExtensionFactory = (pi) => {
				const coordinator = new CompactionCoordinator({
					state,
					pi,
					thresholdSettings: DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
					getEffectiveUsage: () => null,
					persistTelemetrySnapshot: vi.fn(),
				});
				pi.on("session_before_compact", async (event, ctx) => {
					state.selectedMode = "standard";
					stream.mockImplementation(() => {
						const before = ctx.model;
						pi.registerProvider("unrelated-offline-fixture", {
							baseUrl: "https://unrelated.invalid",
							api: model.api,
							models: [{ ...model, id: "unrelated" }],
						});
						// Real SDK replacement, not assignment to the mocked context.
						expect(ctx.model).not.toBe(before);
						expect(ctx.model).toEqual(before);
						const result = createAssistantMessageEventStream();
						result.end(reply(VALID_STRUCTURED_SUMMARY));
						return result;
					});
					const offlineEvent = { ...event, streamFn: stream };
					return coordinator.onSessionBeforeCompact(offlineEvent, ctx);
				});
			};
			const loader = new sdk.DefaultResourceLoader({
				cwd: root,
				agentDir: root,
				settingsManager: settings,
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
				systemPrompt: "Offline fixture",
				extensionFactories: [extension],
			});
			await loader.reload();
			({ session: host } = await sdk.createAgentSession({
				cwd: root,
				agentDir: root,
				model: runtime.getModel(model.provider, model.id),
				modelRuntime: runtime,
				resourceLoader: loader,
				settingsManager: settings,
				sessionManager: manager,
				noTools: "all",
			}));
			const errors: unknown[] = [];
			await host.bindExtensions({
				mode: "tui",
				onError: (e) => errors.push(e),
			});
			const outcome = await host.compact();
			expect(outcome.summary).toContain("Finish the current repair.");
			expect(stream).toHaveBeenCalledTimes(1);
			expect(
				manager.getBranch().filter((e) => e.type === "compaction"),
			).toHaveLength(1);
			expect(errors).toEqual([]);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			host?.dispose();
			fetchSpy.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "offline-fixture",
		model: "offline-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
