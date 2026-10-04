import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

// Real SDKs; mock only the import bridge.
const bridge = vi.hoisted(() => ({
	compact: vi.fn(),
	estimateTokens: vi.fn(),
	generateSummaryWithUsage: vi.fn(),
}));
const invokePi087Compact = bridge.compact;
const invokeSummary = bridge.generateSummaryWithUsage;
vi.mock("@earendil-works/pi-coding-agent", () => ({
	compact: (...args: unknown[]) => bridge.compact(...args),
	estimateTokens: (...args: unknown[]) => bridge.estimateTokens(...args),
	generateSummaryWithUsage: (...args: unknown[]) => invokeSummary(...args),
}));

import { runCustomCompaction } from "../src/compact.js";
import { prepareBudgetedCompactionFocus } from "../src/compaction-intent.js";
import { resolveCompactionRuntimeCompatibility } from "../src/compatibility.js";
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

const completedRuntimes: string[] = [];

it.for(runtimes)(
	"real Pi $version: provider routing and compaction",
	async ({ version, root }, ctx) => {
		if (!root) {
			if (process.env.PI_COMPACT_PLUS_TEST_REQUIRE_RUNTIMES === "1") {
				throw new Error("Required Pi runtime is missing");
			}
			ctx.skip();
			return;
		}
		for (const helper of Object.values(bridge)) helper.mockReset();
		const dependencies =
			version === "0.87.1"
				? join(root, "node_modules/@earendil-works")
				: dirname(root);
		const paths = {
			compact: join(root, "dist/core/compaction/compaction.js"),
			session: join(root, "dist/core/session-manager.js"),
			runtime: join(root, "dist/core/model-runtime.js"),
			registry: join(root, "dist/core/model-registry.js"),
			credentials: join(dependencies, "pi-ai/dist/auth/credential-store.js"),
			stream: join(dependencies, "pi-ai/dist/utils/event-stream.js"),
		};
		if (!Object.values(paths).every(existsSync)) {
			throw new Error("Pi test runtime incomplete");
		}
		const installed = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as { version?: string };
		expect(installed.version).toBe(version);
		for (const pkg of ["pi-agent-core", "pi-ai"]) {
			const nested = JSON.parse(
				readFileSync(join(dependencies, pkg, "package.json"), "utf8"),
			) as { version?: string };
			expect(nested.version, pkg).toBe(version);
		}
		const [
			{
				compact: compact087,
				prepareCompaction,
				generateSummaryWithUsage,
				estimateTokens,
			},
			{ SessionManager },
			{ ModelRuntime },
			{ ModelRegistry },
			{ InMemoryCredentialStore },
			{ createAssistantMessageEventStream },
		] = await Promise.all(
			Object.values(paths).map(
				(path) => import(/* @vite-ignore */ pathToFileURL(path).href),
			),
		);
		bridge.estimateTokens.mockImplementation(estimateTokens);
		invokeSummary.mockImplementation(generateSummaryWithUsage);
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
			api: "openai-completions" as const,
			name: "Routing test",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			baseUrl: "https://original.example.test/v1",
			contextWindow: 200_000,
			maxTokens: 4096,
		};
		const budgetSource = {
			role: "user" as const,
			content: "Task: repair login.",
			timestamp: 1,
		};
		const budgetPreparation = {
			messagesToSummarize: [budgetSource],
			turnPrefixMessages: [],
			isSplitTurn: false,
			settings: { reserveTokens: 1024 },
		};
		const budgeted = await prepareBudgetedCompactionFocus(
			[budgetSource],
			budgetPreparation,
			{ model, renderInstructions: () => "Keep the task." },
		);
		expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
		expect(budgeted.renderedInstructions).toBe("Keep the task.");
		invokeSummary.mockImplementationOnce(async (...args) => {
			try {
				await generateSummaryWithUsage(...args);
			} catch {
				throw new Error("wrapped SDK capture failure");
			}
		});
		const wrapped = await prepareBudgetedCompactionFocus(
			[budgetSource],
			budgetPreparation,
			{ model, renderInstructions: () => "Keep the task." },
		);
		expect(wrapped.focus.intentEvidence?.overflow).toBe(true);
		expect(wrapped.renderedInstructions).toBeUndefined();
		invokeSummary.mockResolvedValueOnce({ text: "unexpected SDK completion" });
		const uncaptured = await prepareBudgetedCompactionFocus(
			[budgetSource],
			budgetPreparation,
			{ model, renderInstructions: () => "Keep the task." },
		);
		expect(uncaptured.focus.intentEvidence?.overflow).toBe(true);
		expect(uncaptured.renderedInstructions).toBeUndefined();
		// Stress the disputed prefix using real native cuts, not fabricated input.
		// The latest retained raw range contains an older compaction entry;
		// replacement/omission edits must affect preparation and projection alike.
		for (const split of [false, true]) {
			const history = SessionManager.inMemory();
			history.appendMessage({
				role: "user",
				content: "Task: investigate the initial service.",
				timestamp: 0,
			});
			const earlierId = history.appendMessage({
				role: "user",
				content: "Preserve earlier retained context.",
				timestamp: 1,
			});
			const removedMessage = {
				role: "user" as const,
				content: "Task: deploy the obsolete service.",
				timestamp: 2,
			};
			const removedId = history.appendMessage(removedMessage);
			const replacedMessage = {
				role: "user" as const,
				content: "Investigate the withdrawn login request.",
				timestamp: 3,
			};
			const replacedId = history.appendMessage(replacedMessage);
			const firstCut = prepareCompaction(history.getBranch(), {
				enabled: true,
				reserveTokens: 1024,
				keepRecentTokens:
					estimateTokens(removedMessage) + estimateTokens(replacedMessage) + 1,
			});
			if (!firstCut) throw new Error("Expected the first native lifecycle cut");
			expect(firstCut.firstKeptEntryId).toBe(earlierId);
			history.appendCompaction(
				"First memory.",
				firstCut.firstKeptEntryId,
				firstCut.tokensBefore,
			);
			const intervening = {
				role: "user" as const,
				content: "Confirm routing repair only.",
				timestamp: 4,
			};
			history.appendMessage(intervening);
			const secondCut = prepareCompaction(history.getBranch(), {
				enabled: true,
				reserveTokens: 1024,
				keepRecentTokens:
					estimateTokens(replacedMessage) + estimateTokens(intervening) + 1,
			});
			if (!secondCut)
				throw new Error("Expected the second native lifecycle cut");
			expect(secondCut.firstKeptEntryId).toBe(removedId);
			history.appendCompaction(
				"Latest memory.",
				secondCut.firstKeptEntryId,
				secondCut.tokensBefore,
			);
			history.appendContextEdit(removedId, null);
			const replacement = `Repair routing instead. ${"routing detail ".repeat(8000)}`;
			history.appendContextEdit(replacedId, { content: replacement });
			// Prevent the native cut from rewinding over context-invisible edits.
			history.appendCustomMessageEntry(
				"native-prefix-fixture",
				"Preserved visible progress.",
				false,
			);
			const latest = "Preserve the audit trail too.";
			history.appendMessage({ role: "user", content: latest, timestamp: 3 });
			if (split) {
				history.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "Active progress ".repeat(200) }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					usage: { input: 1, output: 1, totalTokens: 2 },
					timestamp: 4,
				});
			}
			const native = prepareCompaction(history.getBranch(), {
				enabled: true,
				reserveTokens: 1024,
				keepRecentTokens: 1,
			});
			if (!native) throw new Error("Expected a native edited-history cut");
			expect(native.isSplitTurn).toBe(split);
			const projection = history.buildSessionProjection().messages;
			const supplied = [
				...native.messagesToSummarize,
				...native.turnPrefixMessages,
			].filter((message: { role: string }) => message.role === "user");
			const users = projection.filter(
				(message: { role: string }) => message.role === "user",
			);
			expect(
				users.map((message: { content: unknown }) => message.content),
			).toEqual([replacement, intervening.content, latest]);
			expect(users.slice(0, supplied.length)).toEqual(supplied);
			const result = await prepareBudgetedCompactionFocus(projection, native, {
				model: { ...model, contextWindow: 35_000 },
				renderInstructions: (focus) =>
					`Preserve current intent: ${JSON.stringify(focus.intentEvidence)}`,
			});
			expect(result.focus.intentEvidence?.overflow).toBeUndefined();
			expect(result.focus.intentEvidence?.recentUserTurns).toEqual(
				split ? [] : [latest],
			);
		}
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
		completedRuntimes.push(version);
	},
);

it("executes every discovered/configured SDK in the full matrix", () => {
	expect(completedRuntimes).toEqual(
		runtimes.filter(({ root }) => root).map(({ version }) => version),
	);
});
