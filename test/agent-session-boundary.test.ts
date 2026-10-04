import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type Context,
	contentText,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
} from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	createReadTool,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { registerCompactPlusEventHandlers } from "../src/events.js";
import {
	DEFAULT_COMPACT_PLUS_SETTINGS,
	DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
} from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import { ToolOutputPruningCoordinator } from "../src/tool-output-pruning/coordinator.js";
import { getEffectiveUsage } from "../src/usage.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

vi.mock("../src/persist.js", () => ({
	loadTelemetryWithDiagnostics: async () => ({ telemetry: null, issue: null }),
}));

function response(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	input = 1,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		provider: "local-test",
		model: "boundary-test",
		api: "openai-completions",
		usage: {
			input,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

it("host preserves system content and commit order", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "compact-plus-host-"));
	const sentinel = "SYSTEM-SENTINEL: preserve this authoritative instruction.";
	const settings = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 100 },
		cacheWarming: "off",
	});
	const settingsSpy = vi
		.spyOn(SettingsManager, "create")
		.mockReturnValue(settings);
	const manager = SessionManager.inMemory(cwd);
	manager.appendMessage({
		role: "user",
		content: "Task: repair login.",
		timestamp: 1,
	});
	manager.appendMessage(response([{ type: "text", text: "Earlier context." }]));
	const state = new CompactionState();
	const order: string[] = [];
	const errors: unknown[] = [];
	let promptSections: Record<string, string> | undefined;
	const model: Model<"openai-completions"> = {
		id: "boundary-test",
		name: "Local scripted test",
		provider: "local-test",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let requests = 0;
	const stream = vi.fn((_model: unknown, context: Context) => {
		let message: AssistantMessage;
		const system = getCurrentSystemMessage(context.messages);
		const systemText = [
			contentText(system?.content ?? ""),
			...Object.values(system?.sections ?? {}),
		].join("\n");
		if (systemText.includes("context summarization assistant")) {
			order.push("summary-request");
			message = response([{ type: "text", text: VALID_STRUCTURED_SUMMARY }]);
		} else {
			requests++;
			order.push(`assistant-request-${requests}`);
			expect(systemText).toContain(sentinel);
			expect(system?.toolsAdded?.map((tool) => tool.name)).toContain("probe");
			if (requests === 1) {
				expect(systemText).toContain("section-v1");
				expect(systemText).toContain("withdraw-this-section");
				message = response(
					[
						{
							type: "toolCall",
							id: "probe-call",
							name: "probe",
							arguments: { path: "unused" },
						},
					],
					"toolUse",
					160_000,
				);
			} else {
				expect(requests).toBe(2);
				expect(systemText).toContain("section-v2");
				expect(systemText).not.toContain("section-v1");
				expect(systemText).not.toContain("withdraw-this-section");
				const compaction = manager
					.getBranch()
					.find((entry) => entry.type === "compaction");
				expect(compaction?.type).toBe("compaction");
				if (compaction?.type !== "compaction") {
					throw new Error("draft not committed");
				}
				expect(compaction.systemMessage?.sections?.preamble).toBe(sentinel);
				expect(state.lastCompaction?.executionPath).toBe("custom");
				expect(
					manager
						.buildSessionProjection()
						.messages.some(
							(entry) =>
								entry.role === "toolResult" &&
								entry.toolCallId === "probe-call",
						),
				).toBe(true);
				message = response([{ type: "text", text: "Finished." }]);
			}
		}
		const result = createAssistantMessageEventStream();
		result.push({ type: "start", partial: message });
		if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
			throw new Error("unexpected scripted stop reason");
		}
		result.push({ type: "done", reason: message.stopReason, message });
		result.end(message);
		return result;
	});
	// Only provider transport/auth are fake; AgentSession, Agent and extension
	// dispatch, preview, commit and continuation all use the installed SDK.
	const runtime = {
		streamSimple: stream,
		getAuth: async () => undefined,
		getCompatibilityRequestConfig: () => ({ authHeader: false }),
		hasConfiguredAuth: () => true,
		getModel: () => model,
		getModels: () => [model],
		getAvailableSnapshot: () => [model],
		getRegisteredProviderIds: () => [],
		getError: () => undefined,
	} as unknown as ModelRuntime;
	const extension: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", (event) => {
			promptSections = event.systemPromptOptions.sections;
			promptSections.compact_plus_probe = "section-v1";
			promptSections.compact_plus_withdrawn = "withdraw-this-section";
		});
		const pruning = new ToolOutputPruningCoordinator({
			state: state.toolOutputPruning,
			getSettings: () => ({
				...DEFAULT_COMPACT_PLUS_SETTINGS,
				toolOutputPruneExcludedTools: [],
				toolOutputPruneIncludedTools: [],
			}),
		});
		registerCompactPlusEventHandlers(pi, {
			state,
			toolOutputPruning: pruning,
			compactionCoordinator: new CompactionCoordinator({
				state,
				pi,
				thresholdSettings: DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
				getEffectiveUsage,
				persistTelemetrySnapshot: async () => {},
			}),
			persistTelemetrySnapshot: async () => {},
		});
		pi.on("turn_start", () => {
			if (state.lastCompaction) order.push("commit-confirmed");
		});
	};
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPrompt: sentinel,
		extensionFactories: [extension],
	});
	const execute = vi.fn(async () => {
		order.push("tool-executed");
		if (!promptSections) throw new Error("missing native prompt options");
		promptSections.compact_plus_probe = "section-v2";
		delete promptSections.compact_plus_withdrawn;
		return {
			content: [{ type: "text" as const, text: "Tool output ".repeat(500) }],
			details: {},
		};
	});
	let host: AgentSession | undefined;
	try {
		await loader.reload();
		({ session: host } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model,
			modelRuntime: runtime,
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager: manager,
			tools: ["probe"],
			customTools: [{ ...createReadTool(cwd), name: "probe", execute }],
			thinkingLevel: "off",
		}));
		await host.bindExtensions({
			mode: "tui",
			onError: (error) => errors.push(error),
		});
		host.subscribe((event) => {
			if (
				event.type === "entry_appended" &&
				event.entry.type === "compaction"
			) {
				order.push("draft-committed");
			}
		});
		const compact = vi.spyOn(host, "compact");
		const abort = vi.spyOn(host, "abort");
		await host.prompt("Continue with the current task.");
		const last = host.agent.state.messages.at(-1);
		if (last?.role === "assistant" && last.stopReason === "error") {
			throw new Error(last.errorMessage ?? "scripted request failed");
		}
		const projectedSystem = getCurrentSystemMessage(
			manager.buildSessionProjection().messages,
		);
		expect(projectedSystem?.sections?.compact_plus_probe).toContain(
			"section-v2",
		);
		expect(projectedSystem?.sections?.compact_plus_withdrawn).toBeUndefined();
		expect(errors).toEqual([]);
		expect(execute).toHaveBeenCalledOnce();
		expect(compact).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(order).toEqual([
			"assistant-request-1",
			"tool-executed",
			"summary-request",
			"draft-committed",
			"commit-confirmed",
			"assistant-request-2",
		]);
	} finally {
		host?.dispose();
		settingsSpy.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	}
});
