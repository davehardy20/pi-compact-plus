import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type StreamOptions,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	type CompactionResult,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import * as compactRunner from "../src/compact.js";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { resolveCompactionRuntimeCompatibility } from "../src/compatibility.js";
import { registerCompactPlusEventHandlers } from "../src/events.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import {
	RECOVERY_FAILED_REASON,
	RECOVERY_SUCCESS_REASON,
	SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
} from "../src/summarization-overflow.js";
import { ToolOutputPruningCoordinator } from "../src/tool-output-pruning/coordinator.js";
import { getEffectiveUsage } from "../src/usage.js";
import { createMockPi } from "./fixtures/extension.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

const { runCustomCompaction } = compactRunner;

it.each(["standard", "hard"] as const)(
	"real SDK: %s summaries omit historical thinking and preserve the kept boundary",
	async (mode) => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("Task: repair routing."));
		const thinking = {
			type: "thinking" as const,
			thinking: "historical-reasoning-only ".repeat(30_000),
		};
		const historical = assistant(
			[
				thinking,
				{ type: "text", text: "Decision: preserve the audit controls." },
				{
					type: "toolCall",
					id: "audit-call",
					name: "read",
					arguments: { path: "src/routing.ts" },
				},
			],
			"toolUse",
		);
		session.appendMessage(historical);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "audit-call",
			toolName: "read",
			content: [{ type: "text", text: "Audit controls are enabled." }],
			isError: false,
			timestamp: Date.now(),
		});
		const redirect = "Stop investigating; finish the approved repair instead.";
		const keptId = session.appendMessage(user(redirect));
		session.appendMessage(
			assistant([{ type: "text", text: "Proceeding with the repair." }]),
		);
		const preparation = sdkCompaction.prepareCompaction(session.getBranch(), {
			enabled: true,
			reserveTokens: 4096,
			keepRecentTokens: 16,
		});
		expect(preparation.firstKeptEntryId).toBe(keptId);
		const requests: unknown[][] = [];
		const routed = vi.fn(async (...args: unknown[]) => {
			requests.push(args);
			const stream = createAssistantMessageEventStream();
			stream.end(assistant([{ type: "text", text: VALID_STRUCTURED_SUMMARY }]));
			return stream;
		});
		const auth = vi.fn();
		const registry = { streamSimple: routed, getApiKeyAndHeaders: auth };
		const model = {
			id: "local-test",
			provider: "local-test",
			api: "openai-completions",
			contextWindow: 32_768,
			maxTokens: 4096,
		};
		const ctx = {
			model,
			modelRegistry: registry,
		} as unknown as ExtensionContext;
		const compatibility = resolveCompactionRuntimeCompatibility({
			event: {},
			modelRegistry: registry,
		});
		const fetch = vi.spyOn(globalThis, "fetch");
		try {
			const attempt = await runCustomCompaction(
				preparation,
				mode,
				ctx,
				compatibility,
				undefined,
				{ projected: session.buildSessionContext().messages },
			);
			expect(attempt.result?.firstKeptEntryId).toBe(keptId);
			expect(attempt.fallbackReason).toBeNull();
			expect(routed).toHaveBeenCalledTimes(1);
			const payload = JSON.stringify(requests[0]?.[1]);
			expect(payload).not.toContain("historical-reasoning-only");
			expect(payload).toContain("Decision: preserve the audit controls.");
			expect(payload).toContain("src/routing.ts");
			expect(payload).toContain("Audit controls are enabled.");
			expect(payload).toContain(redirect);
			expect(historical.content[0]).toBe(thinking);
			expect(auth).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	},
);

// Resolve the installed, lockfile-controlled SDK; never use a global Pi path.
const sdkRoot = dirname(
	fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const sdkCompaction = await import(
	/* @vite-ignore */ pathToFileURL(
		join(sdkRoot, "core/compaction/compaction.js"),
	).href
);
function installedVersion(specifier: string): string {
	const entry = fileURLToPath(import.meta.resolve(specifier));
	return (
		JSON.parse(
			readFileSync(join(dirname(entry), "../package.json"), "utf8"),
		) as { version: string }
	).version;
}

function user(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}
function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		api: "openai-completions",
		provider: "local-test",
		model: "local-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

it.each(["opted in", "disabled", "no freshness check", "stale model"] as const)(
	"real SDK: oversized split cut (%s)",
	async (scenario) => {
		const history = user(`HISTORY_MARKER ${"x".repeat(70_000)}`);
		const prefix = user(`PREFIX_MARKER ${"y".repeat(70_000)}`);
		const preparation: Parameters<typeof runCustomCompaction>[0] = {
			messagesToSummarize: [history],
			turnPrefixMessages: [prefix],
			isSplitTurn: true,
			firstKeptEntryId: "keep-this-entry",
			tokensBefore: 27_000,
			settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 500 },
			fileOps: {
				read: new Set(["src/example.ts"]),
				written: new Set(),
				edited: new Set(),
			},
		};
		const model = {
			id: "local-test",
			provider: "local-test",
			api: "openai-completions",
			contextWindow: 32_768,
			maxTokens: 4096,
		};
		const streamSimple = vi.fn(async (..._args: unknown[]) => {
			if (scenario === "stale model") model.maxTokens--;
			const stream = createAssistantMessageEventStream();
			stream.end(assistant([{ type: "text", text: VALID_STRUCTURED_SUMMARY }]));
			return stream;
		});
		const getApiKeyAndHeaders = vi.fn();
		const registry = { streamSimple, getApiKeyAndHeaders };
		const ctx = {
			model,
			modelRegistry: registry,
		} as unknown as ExtensionContext;
		const compatibility = resolveCompactionRuntimeCompatibility({
			event: {},
			modelRegistry: registry,
		});
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Unexpected network request"));
		try {
			const intent = {
				projected: [history, prefix],
				isCurrent: scenario === "no freshness check" ? undefined : () => true,
				enableRecovery: scenario === "disabled" ? undefined : (true as const),
			};
			const pending = runCustomCompaction(
				preparation,
				"standard",
				ctx,
				compatibility,
				undefined,
				intent,
			);
			if (scenario === "opted in") {
				// Change the caller's data while the initial budget check is pending.
				preparation.firstKeptEntryId = "changed-id";
				prefix.content = user(`CHANGED_PREFIX ${"z".repeat(70_000)}`).content;
			}
			const attempt = await pending;
			if (scenario === "stale model") {
				expect(attempt).toMatchObject({
					cancel: true,
					result: undefined,
					fallbackReason: "compaction context changed",
				});
				expect(streamSimple).toHaveBeenCalledTimes(1);
				return;
			}
			if (scenario !== "opted in") {
				expect(attempt).toMatchObject({
					result: undefined,
					requestOverflow: true,
					fallbackReason: SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
				});
				expect(streamSimple).not.toHaveBeenCalled();
				return;
			}
			expect(attempt).toMatchObject({
				fallbackReason: RECOVERY_SUCCESS_REASON,
				recoveryRequests: 3,
				result: {
					firstKeptEntryId: "keep-this-entry",
					tokensBefore: 27_000,
					usage: { input: 3, output: 3, totalTokens: 6 },
				},
			});
			expect(streamSimple).toHaveBeenCalledTimes(3);
			const [first, second, reducer] = streamSimple.mock.calls.map(
				(call) => JSON.stringify(call[1]).split("</conversation>", 1)[0],
			);
			expect(first).toContain("HISTORY_MARKER");
			expect(first).not.toContain("PREFIX_MARKER");
			expect(second).toContain("PREFIX_MARKER");
			expect(second).not.toContain("HISTORY_MARKER");
			expect(reducer).toContain("Historical partial 2");
		} finally {
			const fetched = fetch.mock.calls.length;
			fetch.mockRestore();
			expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
			expect(fetched).toBe(0);
		}
	},
);

it.each(["success", "invalid reducer", "abort", "stale leaf"] as const)(
	"real SDK and coordinator: persist only a valid, current recovery (%s)",
	async (scenario) => {
		const root = mkdtempSync(join(tmpdir(), "compact-plus-recovery-"));
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Unexpected network request"));
		let host: AgentSession | undefined;
		let attempt: Awaited<ReturnType<typeof runCustomCompaction>> | undefined;
		const runner = vi.spyOn(compactRunner, "runCustomCompaction");
		try {
			// Exercise the real runner with the coordinator's freshness callback.
			// Recovery is enabled only at this test seam, not in the coordinator.
			runner.mockImplementation(
				async (cut, mode, ctx, compat, signal, intent) => {
					attempt = await runCustomCompaction(cut, mode, ctx, compat, signal, {
						...intent,
						enableRecovery: true,
					});
					return attempt;
				},
			);
			const manager = SessionManager.create(root, root);
			const earlier = manager.appendMessage(
				user(`FIRST ${"x".repeat(70_000)}`),
			);
			manager.appendMessage(assistant([{ type: "text", text: "First reply" }]));
			manager.appendMessage(user(`SECOND ${"y".repeat(70_000)}`));
			manager.appendMessage(
				assistant([{ type: "text", text: "Second reply" }]),
			);
			// Cross the keep-recent budget at the user message, not its reply.
			const kept = manager.appendMessage(
				user("Retain follow-up. ".repeat(150)),
			);
			manager.appendMessage(
				assistant([{ type: "text", text: "Recent reply" }]),
			);
			const settings = SettingsManager.inMemory({
				compaction: {
					enabled: true,
					reserveTokens: 4096,
					keepRecentTokens: 500,
				},
				cacheWarming: "off",
			});
			const model: Model<"openai-completions"> = {
				id: "local-test",
				name: "Offline compaction fixture",
				provider: "local-test",
				api: "openai-completions",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				contextWindow: 32_768,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const nativeStream = vi.fn(() => {
				throw new Error("Unexpected native summary");
			});
			const runtime = {
				streamSimple: nativeStream,
				getAuth: async () => undefined,
				getCompatibilityRequestConfig: () => ({ authHeader: false }),
				hasConfiguredAuth: () => true,
				getModel: () => model,
				getModels: () => [model],
				getAvailableSnapshot: () => [model],
				getRegisteredProviderIds: () => [],
				getError: () => undefined,
			} as unknown as ModelRuntime;
			let issued = 0;
			const auth = vi.fn(async () => ({
				ok: true,
				apiKey: `fixture-key-${++issued}`,
			}));
			const checkpointCounts: number[] = [];
			const finalSummary = VALID_STRUCTURED_SUMMARY.replace(
				"Finish the current repair.",
				"Finish the offline recovery test.",
			);
			const streamFn = vi.fn(
				async (_model: unknown, _context: unknown, _options: StreamOptions) => {
					const request = streamFn.mock.calls.length;
					checkpointCounts.push(
						manager.getEntries().filter((e) => e.type === "compaction").length,
					);
					if (request === 1 && scenario === "abort") host?.abortCompaction();
					if (request === 1 && scenario === "stale leaf")
						manager.branch(earlier);
					const reduced =
						scenario === "invalid reducer"
							? "Malformed final summary"
							: finalSummary;
					const text = request === 3 ? reduced : VALID_STRUCTURED_SUMMARY;
					const stream = createAssistantMessageEventStream();
					stream.end(assistant([{ type: "text", text }]));
					return stream;
				},
			);
			let tokensBefore: number | undefined;
			const compacted: boolean[] = [];
			const state = new CompactionState();
			const persist = vi.fn();
			const extension: ExtensionFactory = (pi) => {
				const coordinator = new CompactionCoordinator({
					state,
					pi,
					thresholdSettings: {
						...DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
						guardNativeCompaction: false,
					},
					getEffectiveUsage: () => null,
					persistTelemetrySnapshot: persist,
				});
				pi.on("session_before_compact", (event, ctx) => {
					tokensBefore = event.preparation.tokensBefore;
					state.selectedMode = "standard";
					// Inject the offline stream and rotating auth while preserving the
					// SDK's live context getters and its ownership of checkpoint commits.
					const offlineEvent = { ...event, streamFn };
					return coordinator.onSessionBeforeCompact(
						offlineEvent,
						Object.create(ctx, {
							modelRegistry: { value: { getApiKeyAndHeaders: auth } },
						}),
					);
				});
				pi.on("session_compact", async (event, ctx) => {
					compacted.push(event.fromExtension);
					await coordinator.onSessionCompact(event, ctx);
				});
			};
			const loader = new DefaultResourceLoader({
				cwd: root,
				agentDir: root,
				settingsManager: settings,
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
				systemPrompt: "Offline compaction fixture",
				extensionFactories: [extension],
			});
			await loader.reload();
			({ session: host } = await createAgentSession({
				cwd: root,
				agentDir: root,
				model,
				modelRuntime: runtime,
				resourceLoader: loader,
				settingsManager: settings,
				sessionManager: manager,
				noTools: "all",
			}));
			const errors: unknown[] = [];
			await host.bindExtensions({
				mode: "tui",
				onError: (error) => errors.push(error),
			});
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected a file-backed session");
			const before = readFileSync(file, "utf8");
			if (scenario === "success") {
				await host.compact();
			} else {
				await expect(host.compact()).rejects.toThrow("Compaction cancelled");
			}
			expect(errors).toEqual([]);
			expect(runner).toHaveBeenCalledOnce();
			expect(runner.mock.calls[0]?.[5]?.enableRecovery).toBeUndefined();
			expect(nativeStream).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
			const count = scenario === "abort" || scenario === "stale leaf" ? 1 : 3;
			expect(streamFn).toHaveBeenCalledTimes(count);
			expect(auth).toHaveBeenCalledTimes(count);
			expect(
				streamFn.mock.calls.map(([, , options]) => options.apiKey),
			).toEqual(
				Array.from({ length: count }, (_, i) => `fixture-key-${i + 1}`),
			);
			expect(checkpointCounts).toEqual(Array.from({ length: count }, () => 0));
			const restored = SessionManager.open(file, root, root);
			const compactions = restored
				.getEntries()
				.filter((e) => e.type === "compaction");
			if (scenario !== "success") {
				const reasons = {
					"invalid reducer": RECOVERY_FAILED_REASON,
					abort: "compaction aborted",
					"stale leaf": "compaction context changed",
				};
				expect(attempt).toMatchObject({
					cancel: true,
					result: undefined,
					recoveryAttempted: true,
					fallbackReason: reasons[scenario],
				});
				expect(compacted).toEqual([]);
				expect(persist).not.toHaveBeenCalled();
				expect(state.pendingCompaction).toBeNull();
				expect(state.lastCompaction).toBeNull();
				expect(state.lastVerdict).toMatchObject({
					kind: "cancelled",
					reason: reasons[scenario],
				});
				expect(compactions).toEqual([]);
				expect(readFileSync(file, "utf8")).toBe(before);
				return;
			}
			expect(attempt).toMatchObject({
				fallbackReason: RECOVERY_SUCCESS_REASON,
				recoveryRequests: 3,
			});
			expect(compacted).toEqual([true]);
			expect(state.lastVerdict).toMatchObject({ kind: "accepted" });
			expect(compactions).toHaveLength(1);
			expect(compactions[0]?.summary).toContain(
				"Finish the offline recovery test.",
			);
			expect(compactions[0]).toMatchObject({
				firstKeptEntryId: kept,
				tokensBefore,
				summary: attempt?.result?.summary,
				usage: { input: 3, output: 3, totalTokens: 6 },
			});
		} finally {
			host?.dispose();
			runner.mockRestore();
			fetchSpy.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it("Pi 1.5.2: real SDK tool turn -> safe cut -> streamed summary -> echo -> continuation, with retained redirect", async () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { devDependencies: Record<string, string> };
	for (const pkg of [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
	]) {
		expect(manifest.devDependencies[pkg], pkg).toBe("1.5.2");
		expect(installedVersion(pkg), pkg).toBe("1.5.2");
	}
	const session = SessionManager.inMemory();
	session.appendMessage(user("Investigate the old issue."));
	session.appendMessage(
		assistant(
			[
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "src/compact.ts" },
				},
			],
			"toolUse",
		),
	);
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "Historical output ".repeat(90) }],
		isError: false,
		timestamp: Date.now(),
	};
	session.appendMessage(toolResult);
	session.appendMessage(
		assistant([{ type: "text", text: "The tool completed." }]),
	);
	const redirect = "Stop investigating; finish the approved repair instead.";
	const keptId = session.appendMessage(user(redirect));
	session.appendMessage(
		assistant([{ type: "text", text: "Proceeding with the repair." }]),
	);
	const preparation = sdkCompaction.prepareCompaction(session.getBranch(), {
		enabled: true,
		reserveTokens: 1024,
		keepRecentTokens: 16,
	}) as { firstKeptEntryId: string; messagesToSummarize: AgentMessage[] };
	expect(preparation).toBeDefined();
	expect(preparation.firstKeptEntryId).toBe(keptId);
	expect(
		preparation.messagesToSummarize.some((m) => m.role === "toolResult"),
	).toBe(true);
	const routed = vi.fn(() => {
		const stream = createAssistantMessageEventStream();
		stream.end(assistant([{ type: "text", text: VALID_STRUCTURED_SUMMARY }]));
		return stream;
	});
	const result = (await sdkCompaction.compact(
		preparation,
		{
			id: "local-test",
			provider: "local-test",
			api: "openai-completions",
			maxTokens: 4096,
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		routed,
	)) as CompactionResult;
	expect(routed).toHaveBeenCalledTimes(1);
	expect(result.firstKeptEntryId).toBe(keptId);
	expect(result.summary).toContain("## Current Objective");
	// Pi owns the entry and the post-compaction projection; neither is mocked.
	session.appendCompaction(
		result.summary,
		result.firstKeptEntryId,
		result.tokensBefore,
		result.details,
		false,
		result.usage,
	);
	const projected = session.buildSessionContext().messages;
	expect(projected[0]?.role).toBe("compactionSummary");
	// Pi's explicit unknown post-compaction usage must not resurrect stale estimates.
	expect(
		getEffectiveUsage({
			sessionManager: session,
			model: { contextWindow: 8192 },
			getContextUsage: () => ({ tokens: null, percent: null }),
		} as unknown as ExtensionContext),
	).toMatchObject({ source: "native", tokens: null, percent: null });
	expect(
		projected.some(
			(m) => m.role === "user" && JSON.stringify(m.content).includes(redirect),
		),
	).toBe(true);

	const pi = createMockPi();
	const state = new CompactionState();
	const pruning = new ToolOutputPruningCoordinator({
		state: state.toolOutputPruning,
		getSettings: () => ({ experimentalToolOutputPruning: false }) as never,
	});
	const coordinator = new CompactionCoordinator({
		state,
		pi: pi as never,
		thresholdSettings: { thresholdMode: "percent", cooldownMs: 0 } as never,
		getEffectiveUsage: () => null,
		persistTelemetrySnapshot: async () => {},
	});
	registerCompactPlusEventHandlers(pi as never, {
		state,
		toolOutputPruning: pruning,
		compactionCoordinator: coordinator,
		persistTelemetrySnapshot: async () => {},
	});
	const ctx = {
		sessionManager: session,
		model: { id: "local-test", provider: "local-test", contextWindow: 8192 },
		modelRegistry: {},
		hasUI: false,
	} as unknown as ExtensionContext;
	// Delivery of the real preparation is simulated; no Pi agent run or network occurs.
	state.selectedMode = "standard";
	const before = await pi.events.get("session_before_compact")?.[0]?.(
		{ preparation, signal: new AbortController().signal },
		ctx,
	);
	expect(before).toBeUndefined();
	expect(coordinator.getLastVerdict()?.reason).toContain(
		"No stream-aware provider route",
	);
	expect(routed).toHaveBeenCalledTimes(1); // only the explicit native SDK call above streamed
	const onContext = pi.events.get("context")?.[0];
	expect(onContext).toBeDefined();
	const echo = (await onContext?.({ messages: projected }, ctx)) as
		| { messages: AgentMessage[] }
		| undefined;
	expect(echo?.messages).toHaveLength(projected.length + 1);
	const echoIndex = echo?.messages.findIndex((m) =>
		JSON.stringify(m).includes("<focus-echo>"),
	);
	expect(echoIndex).toBe(1);
	expect(JSON.stringify(echo?.messages[echoIndex ?? -1])).toContain(
		"Finish the current repair",
	);
	expect(echo?.messages[(echoIndex ?? -1) + 1]).toBe(projected[1]);
	// A new turn remains after the compaction boundary and an echo is injected only once.
	session.appendMessage(user("Continue the approved repair."));
	const continuation = session.buildSessionContext().messages;
	expect(continuation.at(-1)?.role).toBe("user");
	const nextEcho = (await onContext?.({ messages: continuation }, ctx)) as {
		messages: AgentMessage[];
	};
	expect(nextEcho.messages.at(-1)?.role).toBe("user");
	expect(
		nextEcho.messages.filter((m) => JSON.stringify(m).includes("<focus-echo>")),
	).toHaveLength(1);
	// Message-local dedup prevents a second copy in the same context batch.
	expect(
		await onContext?.({ messages: nextEcho.messages }, ctx),
	).toBeUndefined();
});
