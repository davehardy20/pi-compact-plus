import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type {
	AgentSession,
	ExtensionFactory,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

// Only the package import bridge is mocked; each implementation is native.
const bridge = vi.hoisted(() => ({
	compact: vi.fn(),
	estimateTokens: vi.fn(),
	generateSummaryWithUsage: vi.fn(),
	findCutPoint: vi.fn(),
	prepareBranchEntries: vi.fn(),
	settingsCreate: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	compact: bridge.compact,
	estimateTokens: (...args: unknown[]) => bridge.estimateTokens(...args),
	generateSummaryWithUsage: (...args: unknown[]) =>
		bridge.generateSummaryWithUsage(...args),
	findCutPoint: (...args: unknown[]) => bridge.findCutPoint(...args),
	prepareBranchEntries: (...args: unknown[]) =>
		bridge.prepareBranchEntries(...args),
	SettingsManager: {
		create: (...args: unknown[]) => bridge.settingsCreate(...args),
	},
}));

import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { registerCompactPlusEventHandlers } from "../src/events.js";
import {
	DEFAULT_COMPACT_PLUS_SETTINGS,
	DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
} from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import { ToolOutputPruningCoordinator } from "../src/tool-output-pruning/coordinator.js";
import { getEffectiveUsage } from "../src/usage.js";
import { findInstalledPiRuntime } from "./fixtures/pi-runtime-discovery.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

const runtimes = [
	{
		version: "0.87.1",
		root:
			process.env.PI_COMPACT_PLUS_TEST_PI_087_ROOT ??
			findInstalledPiRuntime("0.87.1"),
	},
	{
		version: "1.0.1",
		root:
			process.env.PI_COMPACT_PLUS_TEST_PI_101_ROOT ??
			dirname(
				dirname(
					fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
				),
			),
	},
];

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

async function checkHost(version: string, root: string) {
	const dependencies =
		version === "0.87.1"
			? join(root, "node_modules/@earendil-works")
			: dirname(root);
	for (const [packageRoot, name] of [
		[root, "pi-coding-agent"],
		[join(dependencies, "pi-agent-core"), "pi-agent-core"],
		[join(dependencies, "pi-ai"), "pi-ai"],
	]) {
		const pkg = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		);
		expect(pkg.name).toBe(`@earendil-works/${name}`);
		expect(pkg.version).toBe(version);
	}
	const load = (path: string) =>
		import(/* @vite-ignore */ pathToFileURL(path).href);
	type SDK = typeof import("@earendil-works/pi-coding-agent");
	// Direct implementation modules avoid a recursive public-index mock bridge.
	const sdk = <K extends keyof SDK>(file: string) =>
		load(join(root, `dist/core/${file}.js`)) as Promise<Pick<SDK, K>>;
	const nativeHost = await sdk<"AgentSession">("agent-session");
	const { createAgentSession } = await sdk<"createAgentSession">("sdk");
	const { createReadTool } = await sdk<"createReadTool">("tools/read");
	const { DefaultResourceLoader } =
		await sdk<"DefaultResourceLoader">("resource-loader");
	const { SessionManager } = await sdk<"SessionManager">("session-manager");
	const { SettingsManager } = await sdk<"SettingsManager">("settings-manager");
	const {
		contentText,
		createAssistantMessageEventStream,
		getCurrentSystemMessage,
	} = (await load(
		join(dependencies, "pi-ai/dist/index.js"),
	)) as typeof import("@earendil-works/pi-ai");
	const nativeCompact = await sdk<
		"compact" | "estimateTokens" | "generateSummaryWithUsage" | "findCutPoint"
	>("compaction/compaction");
	const nativeBranch = await sdk<"prepareBranchEntries">(
		"compaction/branch-summarization",
	);
	for (const name of [
		"compact",
		"estimateTokens",
		"generateSummaryWithUsage",
		"findCutPoint",
	] as const) {
		bridge[name].mockReset().mockImplementation(nativeCompact[name]);
	}
	Object.defineProperty(bridge.compact, "length", {
		configurable: true,
		value: nativeCompact.compact.length,
	});
	bridge.prepareBranchEntries
		.mockReset()
		.mockImplementation(nativeBranch.prepareBranchEntries);
	bridge.settingsCreate
		.mockReset()
		.mockImplementation((...args: Parameters<typeof SettingsManager.create>) =>
			SettingsManager.create(...args),
		);
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
		expect(host, `native ${version} AgentSession`).toBeInstanceOf(
			nativeHost.AgentSession,
		);
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
		expect(bridge.compact).toHaveBeenCalledOnce();
		expect(bridge.generateSummaryWithUsage).toHaveBeenCalled();
		expect(bridge.findCutPoint).toHaveBeenCalled();
		expect(bridge.estimateTokens).toHaveBeenCalled();
		expect(bridge.prepareBranchEntries).toHaveBeenCalled();
		expect(bridge.settingsCreate).toHaveBeenCalled();
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
}

it.for(runtimes)(
	"real Pi $version host preserves system content and commit order",
	async ({ version, root }, test) => {
		if (!root) {
			if (process.env.PI_COMPACT_PLUS_TEST_REQUIRE_RUNTIMES === "1") {
				throw new Error("Required Pi host runtime missing");
			}
			test.skip();
			return;
		}
		await checkHost(version, root);
	},
);
