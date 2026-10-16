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
	SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
	SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
} from "../src/summarization-overflow.js";
import type { EffectiveUsage } from "../src/types.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

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
	options?: {
		guardNativeCompaction?: boolean;
		usageTokens?: number;
		usageSource?: EffectiveUsage["source"];
		persistTelemetrySnapshot?: () => Promise<void>;
	},
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
			source: options?.usageSource ?? "native",
		}),
		persistTelemetrySnapshot: options?.persistTelemetrySnapshot ?? vi.fn(),
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
	it("cancels when the custom request overflowed and Pi's own cut cannot fit either", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 250_000 });
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));

		// Compact+ sends a superset of what Pi sends, so a superset overflow alone is
		// not authority to decline. Here the transcript itself is oversized: Pi would
		// send the same cut, so the attempt cancels instead of re-sending it.
		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [
				user(`Task: repair login.\n${"old context ".repeat(90_000)}`),
			]),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.selectedMode).toBeNull();
		expect(state.isCompacting).toBe(false);
		expect(state.pendingCompaction).toBeNull();
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
	});

	it("defers to native compaction when Pi's own payload fits under the session bound", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 150_000 });
		state.selectedMode = "standard";
		// Pre-set the attempt state the deferral must release, so the assertions prove the
		// release happened rather than that the fields were never set.
		state.isCompacting = true;
		state.lastTriggerAuto = true;

		// The live failure shape: Compact+'s own measurement of its superset request denied
		// the compaction before any provider was consulted, while provider usage reports the
		// session well under the window. Pi sends a smaller payload, so declining here leaves
		// a session that never compacts.
		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [
				user(`Task: repair login.\n${"old context ".repeat(120_000)}`),
			]),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		// Provider usage sits comfortably under the window, so the estimate that denied
		// the request is recorded as a discrepancy rather than passed on as the reason.
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		);

		// A deferred compaction hands off to Pi, so it must not leave a stuck attempt
		// behind: that blocks every later automatic trigger.
		expect(state.selectedMode).toBeNull();
		expect(state.isCompacting).toBe(false);
		expect(state.lastTriggerAuto).toBe(false);

		await coordinator.maybeAutoCompact(ctx, "turn_end");
		expect(state.lastTriggerAuto).toBe(true);
	});

	it("defers a guided attempt instead of declining when usage reports headroom", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		// Seeds acceptance shape: provider usage sits well under the window while the
		// characters/4 estimate of the guided attempt claims it cannot fit. Compact+'s own
		// issued prompt is the payload under examination, not third-party guidance, so
		// bounded usage headroom outranks the estimate and the session still compacts.
		const coordinator = createCoordinator(state, { usageTokens: 150_000 });
		state.selectedMode = "standard";
		state.lastIssuedCompactionInstructions = "summarize the current task";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));
		const guided = event(
			ctx,
			[user(`Task: repair login.\n${"old context ".repeat(90_000)}`)],
			{ instructions: "summarize the current task" },
		);

		const result = await coordinator.onSessionBeforeCompact(guided, ctx);

		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		);

		await coordinator.onSessionCompact(
			{
				fromExtension: false,
				compactionEntry: {
					type: "compaction",
					summary: VALID_STRUCTURED_SUMMARY,
					details: {},
				},
			} as never,
			ctx,
		);
		expect(state.lastCompactTokens).toBeGreaterThan(0);
	});

	it("suppresses a native-guard decline when usage headroom contradicts the estimate", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 150_000 });
		state.selectedMode = null;
		state.lastIssuedCompactionInstructions = "summarize the current task";
		const guided = event(
			ctx,
			[user(`Task: repair login.\n${"old context ".repeat(90_000)}`)],
			{ instructions: "summarize the current task" },
		);

		expect(
			await coordinator.onSessionBeforeCompact(guided, ctx),
		).toBeUndefined();
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason: SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		});
	});

	it("keeps the native-guard decline when the guidance is not Compact+'s own", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 150_000 });
		state.selectedMode = null;
		// Third-party guidance is additive to reported usage, so usage headroom says
		// nothing about whether the request Pi will send can fit.
		state.lastIssuedCompactionInstructions = "a different prompt";
		const guided = event(
			ctx,
			[user(`Task: repair login.\n${"old context ".repeat(90_000)}`)],
			{ instructions: "focus on the failing tests" },
		);

		expect(await coordinator.onSessionBeforeCompact(guided, ctx)).toEqual({
			cancel: true,
		});
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		// The native guard declining its own summarization is a decline, not a cancel: no
		// Compact+ attempt was running when the decision was made.
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "declined",
			reason: SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		});
	});

	it("keeps the overflow reason when usage is already near the window", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const persist = vi.fn(async () => {});
		// Usage leaves no bounded headroom, so the estimate is not treated as a
		// discrepancy and the real overflow reason is recorded instead.
		const coordinator = createCoordinator(state, {
			usageTokens: 190_000,
			persistTelemetrySnapshot: persist,
		});
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [
				user(`Task: repair login.\n${"old context ".repeat(60_000)}`),
			]),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		// One decision writes one verdict: the pending record, the verdict and the persisted
		// telemetry all carry the reason the deferral settled on, and nothing rewrites them
		// afterwards.
		expect(state.pendingCompaction?.fallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason: SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
			usageTokens: 190_000,
		});
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("reports the overflow it defers on when the runtime has no stream route", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		// Usage leaves no bounded headroom, so the measurement is passed on as the reason
		// rather than relabelled as a discrepancy.
		const coordinator = createCoordinator(state, { usageTokens: 190_000 });
		state.selectedMode = "standard";
		// No Pi stream function and no registry streamSimple: the runtime resolves to native
		// fallback, and the deferral still has to say why the cut cannot fit.
		const base = event(ctx, [
			user(`Task: repair login.\n${"old context ".repeat(90_000)}`),
		]) as Record<string, unknown>;
		const noStream = { ...base, streamFn: undefined } as never;

		const result = await coordinator.onSessionBeforeCompact(noStream, ctx);

		expect(result).toEqual({ cancel: true });
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(state.pendingCompaction?.fallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason: SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
			usageTokens: 190_000,
		});
	});

	it("names every trimmed turn when more than one had to go", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 190_000 });
		state.selectedMode = "standard";

		const source = user(
			`Task: repair login.\n${"old context ".repeat(60_000)}`,
		);
		// Two large retained turns must both go before the request fits, so the notice has
		// to pluralise rather than reuse the single-turn wording.
		const retained = [
			user("oldest retained instruction ".repeat(4000)),
			user("middle retained instruction ".repeat(4000)),
			user("latest retained instruction ".repeat(40)),
		];
		ctx.sessionManager.buildSessionProjection = vi.fn(() => ({
			messages: [source, ...retained],
		})) as never;
		compactMock.mockResolvedValueOnce({
			summary: VALID_STRUCTURED_SUMMARY,
			firstKeptEntryId: "entry-1",
			tokensBefore: 123,
			details: null,
		});

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [source]),
			ctx,
		);

		expect(result?.compaction).toBeDefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Dropped 2 retained turns."),
			"warning",
		);
	});

	it("trims intent evidence instead of cancelling when the trimmed request fits", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 190_000 });
		state.selectedMode = "standard";

		const source = user(
			`Task: repair login.\n${"old context ".repeat(60_000)}`,
		);
		const retained = [
			user("oldest retained instruction ".repeat(4000)),
			user("latest retained instruction ".repeat(400)),
		];
		ctx.sessionManager.buildSessionProjection = vi.fn(() => ({
			messages: [source, ...retained],
		})) as never;
		compactMock.mockResolvedValueOnce({
			summary: VALID_STRUCTURED_SUMMARY,
			firstKeptEntryId: "entry-1",
			tokensBefore: 123,
			details: null,
		});

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [source]),
			ctx,
		);

		// Compact+ sends a superset of what Pi sends. When the superset only fails
		// because of the evidence Compact+ added itself, the attempt must shrink that
		// evidence and continue, not discard the whole compaction.
		expect(result).not.toEqual({ cancel: true });
		expect(result?.compaction).toBeDefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("trimmed additional intent evidence"),
			"warning",
		);
		// The notice names how much was dropped, so a live session can tell a trim from a
		// decline rather than inferring it from a reason string.
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Dropped 1 retained turn"),
			"warning",
		);
		expect(state.pendingCompaction?.executionPath).toBe("custom");
		// The count reaches telemetry, so status can distinguish a trimmed compaction from a
		// clean one after the session reloads.
		expect(state.pendingCompaction?.intentEvidenceTrimmedTurns).toBe(1);
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
		);

		await coordinator.onSessionCompact(
			{
				fromExtension: true,
				compactionEntry: {
					type: "compaction",
					summary: VALID_STRUCTURED_SUMMARY,
					details: {},
				},
			} as never,
			ctx,
		);
		// The count survives the settle into lastCompaction, so status can still tell a
		// trimmed compaction from a clean one after the session reloads.
		expect(state.lastCompaction?.intentEvidenceTrimmedTurns).toBe(1);
	});

	it("reports retained turns the evidence cap never admitted", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 190_000 });
		state.selectedMode = "standard";

		const source = user("Task: repair login.");
		const oversized = user("oversized retained paste ".repeat(60_000));
		const recent = user("latest retained instruction ".repeat(40));
		ctx.sessionManager.buildSessionProjection = vi.fn(() => ({
			messages: [source, oversized, recent],
		})) as never;
		compactMock.mockResolvedValueOnce({
			summary: VALID_STRUCTURED_SUMMARY,
			firstKeptEntryId: "entry-1",
			tokensBefore: 123,
			details: null,
		});

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [source]),
			ctx,
		);

		// The cap dropped this turn before the trim search ever ran, so the count the session
		// sees comes from the cap rather than a probe, and the compaction still proceeds.
		expect(result?.compaction).toBeDefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Dropped 1 retained turn"),
			"warning",
		);
		expect(state.pendingCompaction?.intentEvidenceTrimmedTurns).toBe(1);
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
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(state.lastOverflowReportedEpoch).toBe(state.currentCompactionEpoch);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("keeps the compatibility reason when the session-bound fast path defers", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const persist = vi.fn(async () => {});
		const coordinator = createCoordinator(state, {
			usageTokens: 150_000,
			persistTelemetrySnapshot: persist,
		});
		state.selectedMode = "standard";

		const deferred = event(ctx, [
			user(`Task: repair login.\n${"old context ".repeat(90_000)}`),
		]);
		delete (deferred as { streamFn?: unknown }).streamFn;

		const result = await coordinator.onSessionBeforeCompact(deferred, ctx);

		// The runtime resolves to native fallback on an over-window cut. Provider usage
		// reports bounded headroom, so the session-bound fast path skips the measurement and
		// the deferral stands, with the compatibility reason as the single persisted write.
		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(state.pendingCompaction?.fallbackReason).toBe(
			"No stream-aware provider route is available to the extension; Compact+ is falling back to native Pi compaction.",
		);
		expect(coordinator.getLastVerdict()?.reason).toBe(
			"No stream-aware provider route is available to the extension; Compact+ is falling back to native Pi compaction.",
		);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("records the discrepancy reason when guidance forces the measurement", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const persist = vi.fn(async () => {});
		const coordinator = createCoordinator(state, {
			usageTokens: 150_000,
			persistTelemetrySnapshot: persist,
		});
		state.selectedMode = "standard";
		state.lastIssuedCompactionInstructions = "summarize the current task";

		// Guidance is Compact+'s own prompt: it bypasses the fail-open session bound, so the
		// cut is really measured, while estimateDiscrepancy stays eligible because the prompt
		// is the payload under examination rather than something Pi adds on top.
		const deferred = event(
			ctx,
			[user(`Task: repair login.\n${"old context ".repeat(90_000)}`)],
			{ instructions: "summarize the current task" },
		);
		delete (deferred as { streamFn?: unknown }).streamFn;

		const result = await coordinator.onSessionBeforeCompact(deferred, ctx);

		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(state.pendingCompaction?.fallbackReason).toBe(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		);
		expect(state.pendingCompaction?.compatibilityReason).toBe(
			"No stream-aware provider route is available to the extension; Compact+ is falling back to native Pi compaction.",
		);
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		);
		expect(persist).toHaveBeenCalledTimes(1);
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
		expect(coordinator.getLastVerdict()?.reason).toBe(
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
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_OUTPUT_CAP_REASON,
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("output token limit"),
			"warning",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
	});

	it("never lets usage headroom excuse an exhausted output budget", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		// Usage leaves bounded headroom, but an exhausted output budget is about the
		// response: Pi would hit the same cap on the same cut, so this stays a cancel.
		const coordinator = createCoordinator(state, { usageTokens: 150_000 });
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(PI_OUTPUT_CAP_FAILURE));

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("Task: repair login.")]),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_OUTPUT_CAP_REASON,
		);
	});

	it("does not let usage headroom rewrite a provider-confirmed overflow", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		// The provider itself rejected the request, so the overflow is proven rather than
		// estimated. Headroom may still let Pi try its own smaller cut, but it must not
		// relabel a proven rejection as a suspect estimate.
		const coordinator = createCoordinator(state, { usageTokens: 150_000 });
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [
				user(`Task: repair login.\n${"old context ".repeat(60_000)}`),
			]),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});

	it("fails closed when usage is not provider-reported", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		// Comfortable headroom, but the number is Compact+'s own estimate rather than
		// provider-reported usage, so it cannot outrank the measured overflow.
		const coordinator = createCoordinator(state, {
			usageTokens: 150_000,
			usageSource: "estimated",
		});
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [
				user(`Task: repair login.
${"old context ".repeat(90_000)}`),
			]),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});

	it("defers the final fall-back when usage headroom contradicts the estimate", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 150_000 });
		state.selectedMode = "standard";
		state.lastIssuedCompactionInstructions = "summarize the current task";
		compactMock.mockRejectedValueOnce(new Error("provider request failed"));

		// The attempt failed for a reason that is not an overflow, and the guidance Pi would
		// append is Compact+'s own prompt. Headroom contradicts the estimate of Pi's payload,
		// so the session must still compact rather than be left unable to.
		const deferred = event(
			ctx,
			[user(`Task: repair login.\n${"old context ".repeat(90_000)}`)],
			{ instructions: "summarize the current task" },
		);

		const result = await coordinator.onSessionBeforeCompact(deferred, ctx);

		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(coordinator.getLastVerdict()?.reason).not.toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});

	it("keeps the final decline when oversized guidance is not Compact+'s own", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		// Comfortable headroom, but the guidance is third-party: those tokens are additive to
		// reported usage, so usage no longer contradicts the measurement of the payload Pi
		// would send and the decline stands.
		const coordinator = createCoordinator(state, { usageTokens: 150_000 });
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error("provider request failed"));

		const deferred = event(ctx, [user("Task: repair login.")], {
			instructions: "retained guidance ".repeat(90_000),
		});

		const result = await coordinator.onSessionBeforeCompact(deferred, ctx);

		expect(result).toEqual({ cancel: true });
		expect(coordinator.getLastVerdict()?.reason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
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
		expect(coordinator.getLastVerdict()?.reason).toBe(
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
		expect(coordinator.getLastVerdict()?.reason).toBe(
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
		expect(coordinator.getLastVerdict()).toBeNull();
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

	it("keys a deeply nested payload as partial instead of recursing without bound", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;
		const warnings = () =>
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			).length;
		// Nested well past the walk's depth budget but comfortably inside any host's call stack,
		// so what is being asserted is that the walk stops at its own budget, not how deep a
		// particular Node build tolerates before throwing. The margin over the budget is named so
		// that raising STRUCTURAL_DEPTH_BUDGET past it fails here with an obvious cause.
		const NEST_DEPTH_PAST_BUDGET = 800;
		const nest = (leaf: unknown): unknown => {
			let value = leaf;
			for (let index = 0; index < NEST_DEPTH_PAST_BUDGET; index++)
				value = { nested: value };
			return value;
		};
		const call = (leaf: string): AgentMessage =>
			({
				role: "assistant",
				content: [
					{ type: "text", text: "x".repeat(1_000_000) },
					{ type: "toolCall", id: "c1", name: "read", arguments: nest(leaf) },
				],
				timestamp: 1,
			}) as AgentMessage;

		expect(
			await coordinator.onSessionBeforeCompact(event(ctx, [call("v")]), ctx),
		).toEqual({ cancel: true });
		expect(warnings()).toBe(1);

		// The leaf differs only at NEST_DEPTH_PAST_BUDGET, past the walk's budget, so key
		// building never saw the difference: same partial key, still warned once, and still
		// measured on its own rather than judged by the earlier partial total. Without the depth
		// cap the walk would reach the leaf, produce a different key, and warn a second time.
		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [call("x".repeat(1_000_000))]),
				ctx,
			),
		).toEqual({ cancel: true });
		expect(warnings()).toBe(1);
	});

	it("re-measures a budget-exhausting cut when only its measurable text shrinks", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;
		// Wide enough to exhaust the node budget on every attempt, so the cut keeps the same
		// stable partial key while its measurable text changes.
		const wideArgs = Object.fromEntries(
			Array.from({ length: 12_000 }, (_unused, index) => [`k${index}`, "v"]),
		);
		const call = (text: string): AgentMessage =>
			({
				role: "assistant",
				content: [
					{ type: "text", text },
					{ type: "toolCall", id: "c1", name: "read", arguments: wideArgs },
				],
				timestamp: 1,
			}) as AgentMessage;

		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [call("x".repeat(1_000_000))]),
				ctx,
			),
		).toEqual({ cancel: true });

		// The partial key is stable, so the notice dedupe still recognizes the cut. It must
		// not carry a verdict: this cut now fits, and reusing the previous decline would
		// cancel a summarization request that can be sent.
		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [call("small task")]),
				ctx,
			),
		).toBeUndefined();
	});

	it("warns for an overflow whose cut it cannot key", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = "standard";
		const warnings = () =>
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) =>
					call[1] === "warning" &&
					typeof call[0] === "string" &&
					call[0].includes("cancelled"),
			).length;
		// Key building enumerates the payload and hits the throwing getter, so this cut has
		// no key at all. The overflow itself comes from the provider's response, so the guard
		// still reports it instead of letting the traversal failure escape.
		const payload = {
			get boom(): never {
				throw new Error("payload getter throws on enumeration");
			},
		};
		const call = (): AgentMessage =>
			({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "read", arguments: payload },
				],
				timestamp: 1,
			}) as unknown as AgentMessage;
		const cut = event(ctx, [call()]);

		compactMock.mockRejectedValue(new Error(PI_OUTPUT_CAP_FAILURE));
		expect(await coordinator.onSessionBeforeCompact(cut, ctx)).toEqual({
			cancel: true,
		});
		// A cut with no key has nothing to compare against, so it must not match the "no
		// notice recorded yet" state and lose its first warning.
		expect(warnings()).toBe(1);

		state.selectedMode = "standard";
		expect(await coordinator.onSessionBeforeCompact(cut, ctx)).toEqual({
			cancel: true,
		});
		// Still unkeyable, so it explains itself again rather than deduping against a
		// sentinel that means "nothing warned about yet".
		expect(warnings()).toBe(2);
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

	it("does not cancel a cut that is oversized only in image bytes", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;
		// Pi renders the summarization conversation through serializeConversation, which keeps
		// only type "text" blocks, so a megabyte of image data is not part of the request the
		// guard has to fit. Usage is pushed past the session-fit fast path so the guard actually
		// measures this cut: if measurement ever scored the image bytes, this cut would be
		// declined and a summarization request the provider can serve would be cancelled.
		const imageOnly = (data: string): AgentMessage =>
			({
				role: "assistant",
				content: [
					{ type: "text", text: "small task" },
					{ type: "image", data, mimeType: "image/png" },
				],
				timestamp: 1,
			}) as unknown as AgentMessage;

		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [imageOnly("x".repeat(1_000_000))]),
				ctx,
			),
		).toBeUndefined();
		// No decision recorded either: the guard measured the cut and found it fits.
		expect(coordinator.getLastVerdict()).toBeNull();
		expect(
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			).length,
		).toBe(0);
	});

	it("counts image payload in the cut key while measuring only text", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		state.selectedMode = null;
		const warnings = () =>
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			).length;
		const withImage = (data: string): AgentMessage =>
			({
				role: "assistant",
				content: [
					{ type: "text", text: "x".repeat(1_000_000) },
					{ type: "image", data, mimeType: "image/png" },
				],
				timestamp: 1,
			}) as unknown as AgentMessage;

		// Characterization of the measurement blind spot: Pi renders the summarization
		// conversation through contentText, which keeps only type "text" blocks, so image bytes
		// are never sent to the provider and estimateTokens scores an image part at zero. The
		// overflow below is caused entirely by the text payload.
		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [withImage("aGVsbG8=")]),
				ctx,
			),
		).toEqual({ cancel: true });

		// The unchanged cut reuses the recorded verdict and its notice dedupes.
		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [withImage("aGVsbG8=")]),
				ctx,
			),
		).toEqual({ cancel: true });
		expect(warnings()).toBe(1);

		// Only the image payload changed. The measurement cannot see those bytes, but the cut
		// key counts part data length, so this is a different cut: it must be measured fresh
		// instead of judged by the stale verdict.
		expect(
			await coordinator.onSessionBeforeCompact(
				event(ctx, [withImage("x".repeat(1_000_000))]),
				ctx,
			),
		).toEqual({ cancel: true });
		expect(warnings()).toBe(2);
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
		expect(coordinator.getLastVerdict()?.reason).toBe(
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
		// Pi still sends one request, and this cut cannot fit it, so the overflow is
		// authoritative: no silent deferral that performs no compaction and emits no
		// warning.
		const result = await coordinator.onSessionBeforeCompact(
			event(
				ctx,
				[user(`Task: repair login.\n${"old context ".repeat(90_000)}`)],
				{ splitTurn: true, prefix: [] },
			),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(coordinator.getLastVerdict()?.reason).toBe(
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

	it("expires a manual bypass left armed by an attempt Pi never settled", async () => {
		const state = new CompactionState();
		const ctx = createCtx({ contextWindow: 200_000 });
		const coordinator = createCoordinator(state, { usageTokens: 500_000 });
		const oversized = event(ctx, [user("x".repeat(1_000_000))]);
		const warnings = () =>
			(ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[1] === "warning",
			).length;

		// An automatic attempt warns once for the oversized cut and records the notice key.
		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});
		expect(warnings()).toBe(1);

		// Pi never calls back on this manual attempt, so neither onSettled nor the
		// synchronous-throw catch clears the bypass and manualAttemptInFlight stays armed.
		compactMock.mockImplementation(() => new Promise(() => {}));
		await coordinator.handleManualCommand("standard", ctx);

		// A session transition fences the abandoned attempt's callbacks and moves the epoch,
		// so the stale bypass no longer matches the attempt it is compared against.
		state.invalidateCompactionCallbacks();
		state.selectedMode = null;

		// Same unchanged cut in the new session: it dedupes instead of explaining itself. If
		// the stale bypass were still honoured, this would warn a second time.
		expect(await coordinator.onSessionBeforeCompact(oversized, ctx)).toEqual({
			cancel: true,
		});
		expect(warnings()).toBe(1);
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
		expect(coordinator.getLastVerdict()).toBeNull();
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
		expect(coordinator.getLastVerdict()).toBeNull();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
