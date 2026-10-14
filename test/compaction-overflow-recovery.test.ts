import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PI_OUTPUT_CAP_FAILURE,
	STRATA_CONTEXT_OVERFLOW,
} from "./fixtures/summarization-errors.js";

const { compactMock } = vi.hoisted(() => ({ compactMock: vi.fn() }));

vi.mock("../src/persist.js", () => ({
	loadTelemetryWithDiagnostics: vi.fn(async () => ({
		telemetry: null,
		issue: null,
	})),
	saveTelemetryWithDiagnostics: vi.fn(async () => ({
		saved: true,
		issue: null,
	})),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	// Compatibility routing keys off the real helper's arity, not its behavior.
	Object.defineProperty(compactMock, "length", {
		value: 13,
		configurable: true,
	});
	return { ...actual, compact: compactMock };
});

import {
	CompactionCoordinator,
	guidanceDigest,
} from "../src/compaction-coordinator.js";
import { registerCompactPlusEventHandlers } from "../src/events.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import {
	SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
} from "../src/summarization-overflow.js";
import type { EffectiveUsage } from "../src/types.js";

type ExtensionEventContext = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

const fetchSpy = vi.spyOn(globalThis, "fetch");

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

function createCtx(options?: {
	contextWindow?: number;
}): ExtensionEventContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: { notify: vi.fn() },
		compact: vi.fn(),
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		model: {
			provider: "strata",
			id: "qwen-test",
			api: "openai-completions",
			contextWindow: options?.contextWindow ?? 262_144,
			maxTokens: 8192,
		},
		getContextUsage: vi.fn(() => ({
			tokens: 250_000,
			contextWindow: options?.contextWindow ?? 262_144,
			percent: 95,
		})),
		sessionManager: {
			getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
			getSessionId: vi.fn(() => "session-1"),
			getLeafId: vi.fn(() => "leaf-1"),
			getBranch: vi.fn(() => []),
			buildSessionProjection: vi.fn(() => ({ messages: [] })),
		},
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k" })),
		},
	} as unknown as ExtensionEventContext;
}

function createCoordinator(
	state: CompactionState,
	options?: { guardNativeCompaction?: boolean; usageTokens?: number },
) {
	return new CompactionCoordinator({
		state,
		pi: { sendUserMessage: vi.fn() } as never,
		thresholdSettings: {
			...DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
			thresholdMode: "effective_cap",
			guardNativeCompaction: options?.guardNativeCompaction ?? true,
		},
		getEffectiveUsage: (): EffectiveUsage => ({
			percent: 95,
			tokens: options?.usageTokens ?? 250_000,
			contextWindow: 262_144,
			source: "native",
		}),
		persistTelemetrySnapshot: vi.fn(),
	});
}

function preparation(
	messages: AgentMessage[],
	options?: { prefix?: AgentMessage[]; splitTurn?: boolean },
) {
	return {
		isSplitTurn: options?.splitTurn ?? false,
		messagesToSummarize: messages,
		turnPrefixMessages: options?.prefix ?? [],
		settings: {
			enabled: true,
			keepRecentTokens: 20_000,
			reserveTokens: 16_384,
		},
	};
}

function event(
	ctx: ExtensionEventContext,
	messages: AgentMessage[],
	options?: {
		prefix?: AgentMessage[];
		splitTurn?: boolean;
		instructions?: string;
	},
) {
	return {
		preparation: preparation(messages, options),
		branchEntries: [],
		reason: "threshold",
		willRetry: false,
		customInstructions: options?.instructions,
		signal: ctx.signal ?? new AbortController().signal,
		streamFn: async () => ({ result: async () => ({}) }),
	} as never;
}

afterEach(() => {
	compactMock.mockReset();
	fetchSpy.mockClear();
});

describe("CompactionCoordinator summarisation overflow handling", () => {
	it("declines native fallback when the custom request itself overflowed", async () => {
		const state = new CompactionState();
		const ctx = createCtx();
		const coordinator = createCoordinator(state);
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));

		// Asymmetry is intentional: Compact+ sends a superset of what Pi sends (its
		// rendered instructions carry intent evidence Pi never sends), so a
		// provider-confirmed overflow cancels even though Pi's own cut would fit.
		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("Task: repair login.")]),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.selectedMode).toBeNull();
		expect(state.isCompacting).toBe(false);
		expect(state.pendingCompaction).toBeNull();
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
	});

	it("cancels a native Pi compaction whose transcript alone cannot fit", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state);
		state.selectedMode = null;

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [
				user(`Task: repair login.\n${"old context ".repeat(90_000)}`),
			]),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(state.lastOverflowReportedEpoch).toBe(state.currentCompactionEpoch);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("cancels the deferred native path too when the payload cannot fit", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state);
		state.selectedMode = "standard";

		const deferred = event(ctx, [
			user(`Task: repair login.\n${"old context ".repeat(90_000)}`),
		]);
		delete (deferred as { streamFn?: unknown }).streamFn;

		const result = await coordinator.onSessionBeforeCompact(deferred, ctx);

		expect(result).toEqual({ cancel: true });
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
	});

	it("names an output-cap failure as an output-cap failure", async () => {
		const state = new CompactionState();
		const ctx = createCtx();
		const coordinator = createCoordinator(state);
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(PI_OUTPUT_CAP_FAILURE));

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("Task: repair login.")]),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.lastFallbackReason).toBe(SUMMARIZATION_OUTPUT_CAP_REASON);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("output token limit"),
			"warning",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
	});

	it("guards the final fall-back to native compaction too", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state);
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error("provider request failed"));

		// Compact+ budgets its own rendered prompt, so the custom attempt passed.
		// Pi would send the caller's guidance verbatim on the deferred request.
		const deferred = event(ctx, [user("Task: repair login.")]);
		(deferred as { customInstructions?: string }).customInstructions =
			"retained guidance ".repeat(90_000);

		const result = await coordinator.onSessionBeforeCompact(deferred, ctx);

		expect(result).toEqual({ cancel: true });
		expect(state.pendingCompaction).toBeNull();
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});

	it("measures the split-turn prefix the native path would summarize", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state);
		state.selectedMode = null;

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [], {
				splitTurn: true,
				prefix: [user(`Task: repair login.\n${"old context ".repeat(90_000)}`)],
			}),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});

	it("keeps split-turn requests separate the way Pi sends them", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state);
		state.selectedMode = null;

		// Each request fits alone; only the combined cut would overflow, and Pi never
		// sends a combined cut on a split turn.
		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("a".repeat(700_000))], {
				splitTurn: true,
				prefix: [user("b".repeat(700_000))],
			}),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(state.lastFallbackReason).toBeNull();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("defers to native when only Compact+'s merged split-turn request overflowed", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 400_000 });
		const coordinator = createCoordinator(state);
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));

		// Compact+ merges both slices into one request. Pi sends them separately.
		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("a".repeat(700_000))], {
				splitTurn: true,
				prefix: [user("b".repeat(700_000))],
			}),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
	});

	it("defers to native when the transcript itself is what cannot fit a split turn", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 400_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = "standard";

		// The merged request cannot fit and no evidence was added: the transcript is
		// the cause. Pi sends each slice separately and each fits, so this is not an
		// intent-evidence decline.
		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("a".repeat(1_200_000))], {
				splitTurn: true,
				prefix: [user("b".repeat(1_200_000))],
			}),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(compactMock).not.toHaveBeenCalled();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("intent evidence"),
			"warning",
		);
	});

	it("re-measures a cut that shrinks in place instead of reusing a stale verdict", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;

		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [user("x".repeat(1_000_000))]),
				ctx,
			),
		).toEqual({ cancel: true });

		// Same session, leaf, model, and message count; only the content shrank.
		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [user("x".repeat(200_000))]),
				ctx,
			),
		).toBeUndefined();
	});

	it("clears the manual bypass when the attempt settles without reaching the guard", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = "standard";
		compactMock.mockRejectedValue(new Error(STRATA_CONTEXT_OVERFLOW));
		const oversized = event(ctx, [user("x".repeat(1_000_000))]);
		const warnings = () =>
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			).length;

		// An automatic attempt already warned once about this cut.
		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});

		// A manual attempt settles without Pi ever firing session_before_compact.
		await coordinator.handleManualCommand("standard", ctx);
		const compactSpy = ctx.compact as ReturnType<typeof vi.fn>;
		const issued = compactSpy.mock.calls[0]?.[0] as {
			onComplete?: (result: unknown) => void;
		};
		issued.onComplete?.({ estimatedTokensAfter: 1000 });

		// The bypass must have expired with that attempt, so the unchanged cut dedupes.
		state.selectedMode = "standard";
		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});
		expect(warnings()).toBe(1);
	});

	it("does not leave the session compacting when Pi throws synchronously", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error("Pi rejected the compaction request");
		});

		await expect(
			coordinator.handleManualCommand("standard", ctx),
		).rejects.toThrow("Pi rejected the compaction request");
		expect(state.isCompacting).toBe(false);

		// A later manual command must still run, not be refused as already in progress.
		await coordinator.handleManualCommand("standard", ctx);
		expect(
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) =>
					call[1] === "warning" &&
					String(call[0]).includes("already in progress"),
			),
		).toHaveLength(0);
	});

	it("re-measures when tool arguments grow by adding siblings", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;
		const args = (count: number): Record<string, string> =>
			Object.fromEntries(
				Array.from({ length: count }, (_unused, index) => [
					`key_${index}`,
					"v".repeat(267),
				]),
			);
		const call = (count: number): AgentMessage =>
			({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "read", arguments: args(count) },
				],
				timestamp: 1,
			}) as AgentMessage;

		expect(
			await coordinator.onSessionBeforeCompact(event(ctx, [call(100)]), ctx),
		).toBeUndefined();

		// Same part, same type, same name. The payload grew through sibling keys, which
		// a character accumulator would have stopped counting.
		expect(
			await coordinator.onSessionBeforeCompact(event(ctx, [call(3000)]), ctx),
		).toEqual({ cancel: true });
	});

	it("re-measures when the key walk ran out of node budget", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;
		const args = (growing: string): Record<string, string> => ({
			...Object.fromEntries(
				Array.from({ length: 12_000 }, (_unused, index) => [`k${index}`, "v"]),
			),
			growing,
		});
		const call = (growing: string): AgentMessage =>
			({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "read",
						arguments: args(growing),
					},
				],
				timestamp: 1,
			}) as AgentMessage;

		expect(
			await coordinator.onSessionBeforeCompact(event(ctx, [call("v")]), ctx),
		).toBeUndefined();

		// The walk stopped before the growing field, so the partial total cannot be a
		// verdict another cut may match: the grown payload is measured again.
		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [call("x".repeat(1_000_000))]),
				ctx,
			),
		).toEqual({ cancel: true });
	});

	it("keeps a manual attempt's bypass when an older attempt settles late", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		const oversized = () =>
			event(ctx, [
				user(`Task: repair login.\n${"old context ".repeat(90_000)}`),
			]);
		const warnings = () =>
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			).length;

		const settles: Array<(() => void) | undefined> = [];
		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onComplete }: { onComplete?: () => void }) => {
				settles.push(onComplete);
			},
		);

		// Attempt A starts, and the session transitions before Pi ever settles it.
		await coordinator.handleManualCommand("standard", ctx);
		state.reset();

		// An automatic decline in the new epoch already warned about this exact cut.
		expect(await coordinator.onSessionBeforeCompact(oversized(), ctx)).toEqual({
			cancel: true,
		});
		expect(warnings()).toBe(1);

		// Attempt B starts in the new epoch, then A settles late.
		await coordinator.handleManualCommand("standard", ctx);
		settles[0]?.();

		// B still owns the bypass, so its decline explains itself instead of being
		// deduped against the earlier automatic warning.
		expect(await coordinator.onSessionBeforeCompact(oversized(), ctx)).toEqual({
			cancel: true,
		});
		expect(warnings()).toBe(2);
	});

	it("warns once for a budget-exhausting cut even though it is re-measured", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;
		const args: Record<string, string> = {
			...Object.fromEntries(
				Array.from({ length: 12_000 }, (_unused, index) => [`k${index}`, "v"]),
			),
			growing: "x".repeat(1_000_000),
		};
		const call = (): AgentMessage =>
			({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "read", arguments: args },
				],
				timestamp: 1,
			}) as AgentMessage;
		const warnings = () =>
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			).length;

		// The verdict cache cannot reuse a partial total, so each attempt measures
		// again. The notice dedupe uses the stable partial form, so the user still
		// hears about the unchanged cut only once.
		expect(
			await coordinator.onSessionBeforeCompact(event(ctx, [call()]), ctx),
		).toEqual({ cancel: true });
		expect(warnings()).toBe(1);
		expect(
			await coordinator.onSessionBeforeCompact(event(ctx, [call()]), ctx),
		).toEqual({ cancel: true });
		expect(warnings()).toBe(1);
	});

	it("digests guidance content so equal-length guidance is not one cut", () => {
		const a = "A".repeat(1_000_000);
		const b = `${"A".repeat(499_998)}ZZ${"A".repeat(500_000)}`;
		expect(a.length).toBe(b.length);
		expect(a.slice(0, 32)).toBe(b.slice(0, 32));
		expect(a.slice(-32)).toBe(b.slice(-32));
		expect(guidanceDigest(a)).not.toBe(guidanceDigest(b));
		expect(guidanceDigest(a)).toBe(guidanceDigest("A".repeat(1_000_000)));
	});

	it("cannot see image growth because Pi drops image parts from the request", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;
		const image = (data: string): AgentMessage =>
			({
				role: "assistant",
				content: [{ type: "image", data, mimeType: "image/png" }],
				timestamp: 1,
			}) as unknown as AgentMessage;

		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [image("aGVsbG8=")]),
				ctx,
			),
		).toBeUndefined();

		// Characterization: Pi renders the summarization conversation through
		// contentText, which keeps only type "text" blocks, so image bytes are never sent
		// to the provider and estimateTokens scores an image part at zero. A 1,000,000
		// character base64 payload therefore cannot make the request overflow, and the
		// guard correctly leaves it alone. The key still counts the data, so a cut whose
		// image changed is not judged by a stale verdict.
		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [image("x".repeat(1_000_000))]),
				ctx,
			),
		).toBeUndefined();
	});

	it("resets guard state when the registered session_start handler runs", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		const resetSpy = vi.spyOn(coordinator, "resetOverflowState");
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => unknown
		>();
		const pi = {
			on: vi.fn((name: string, handler: unknown) => {
				handlers.set(
					name,
					handler as (event: unknown, ctx: unknown) => unknown,
				);
			}),
		} as never;

		registerCompactPlusEventHandlers(pi, {
			state,
			toolOutputPruning: { onSessionStart: vi.fn() } as never,
			compactionCoordinator: coordinator,
			persistTelemetrySnapshot: vi.fn(),
		});

		const sessionStart = handlers.get("session_start");
		expect(sessionStart).toBeDefined();
		await sessionStart?.({}, ctx);
		expect(resetSpy).toHaveBeenCalledTimes(1);
		resetSpy.mockRestore();
	});

	it("re-measures when only a tool call's arguments grow", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;
		const call = (args: unknown): AgentMessage =>
			({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "read", arguments: args },
					{ type: "text", text: "done" },
				],
				timestamp: 1,
			}) as AgentMessage;

		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [call({ path: "a.txt" })]),
				ctx,
			),
		).toBeUndefined();

		// Same part count, types, and text lengths. Only the tool arguments grew.
		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [call({ path: "x".repeat(1_000_000) })]),
				ctx,
			),
		).toEqual({ cancel: true });
	});

	it("measures caller guidance instead of trusting the session-fit fast path", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		// Pi reports the session as fitting, so the transcript-only fast path would
		// skip the guard and hand Pi an oversized guided request.
		const coordinator = createCoordinator(state, { usageTokens: 20_000 });
		state.selectedMode = null;

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("small task")], { instructions: "y".repeat(1_600_000) }),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});

	it("still skips the guard for a fitting session with no caller guidance", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 20_000 });
		state.selectedMode = null;

		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [user("small task")]),
				ctx,
			),
		).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("cancels a provider-confirmed overflow on a split turn with no prefix", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));

		// Compact+'s boundary preparation reports isSplitTurn with an empty prefix.
		// Pi still sends one request, so the overflow is authoritative: no silent
		// deferral that performs no compaction and emits no warning.
		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("Task: repair login.")], {
				splitTurn: true,
				prefix: [],
			}),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
	});

	it("explains every manual decline of an unchanged oversized cut", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		const oversized = event(ctx, [user("x".repeat(1_000_000))]);
		const warnings = () =>
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			).length;

		await coordinator.handleManualCommand("standard", ctx);
		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});
		await coordinator.handleManualCommand("standard", ctx);
		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});
		expect(warnings()).toBe(2);
	});

	it("dedupes automatic repeats after a manual decline", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		const oversized = event(ctx, [user("x".repeat(1_000_000))]);

		await coordinator.handleManualCommand("standard", ctx);
		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});
		// The manual bypass is attempt-scoped: later automatic attempts dedupe.
		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});
		expect(
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			),
		).toHaveLength(1);
	});

	it("resetOverflowState clears the notice dedupe for a new session", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = "standard";
		compactMock.mockRejectedValue(new Error(STRATA_CONTEXT_OVERFLOW));
		const oversized = event(ctx, [user("x".repeat(1_000_000))]);

		await coordinator.onSessionBeforeCompact(oversized, ctx);
		await coordinator.onSessionBeforeCompact(oversized, ctx);
		expect(
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			),
		).toHaveLength(1);

		coordinator.resetOverflowState();
		state.selectedMode = "standard";
		await coordinator.onSessionBeforeCompact(oversized, ctx);
		expect(
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			),
		).toHaveLength(2);
	});

	it("warns once per unchanged cut", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state);
		state.selectedMode = null;
		const oversized = event(ctx, [user("x".repeat(1_000_000))]);

		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});
		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
	});

	it("hands compaction back to Pi when the guard is disabled", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, {
			guardNativeCompaction: false,
		});
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("Task: repair login.")]),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
	});

	it("skips the measurement when the whole session already fits", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 20_000 });
		state.selectedMode = null;

		// Pi reports the session well inside the window, so any cut of it fits.
		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("x".repeat(1_000_000))]),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("records network calls, so the no-network assertions are not vacuous", async () => {
		await globalThis.fetch("data:text/plain,ok");
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("leaves the native path alone when the guard is disabled", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, {
			guardNativeCompaction: false,
		});
		state.selectedMode = null;

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [
				user(`Task: repair login.\n${"old context ".repeat(90_000)}`),
			]),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(state.lastFallbackReason).toBeNull();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("leaves a fitting native Pi compaction untouched", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state);
		state.selectedMode = null;

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("Task: repair login.")]),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(state.lastFallbackReason).toBeNull();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
