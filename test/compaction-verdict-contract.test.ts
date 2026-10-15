import { afterEach, describe, expect, it, vi } from "vitest";

const { runCustom } = vi.hoisted(() => ({ runCustom: vi.fn() }));

vi.mock("../src/compact.js", () => ({ runCustomCompaction: runCustom }));
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

import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { NATIVE_FALLBACK_REASON } from "../src/compatibility.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import {
	SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
	SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
	SUMMARIZATION_INTENT_EVIDENCE_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
	SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
} from "../src/summarization-overflow.js";
import type { EffectiveUsage } from "../src/types.js";

/**
 * Characterization tests for the compaction verdict contract
 * (src/compaction-coordinator.ts:785-1140). Today the reason a compaction was
 * declined, trimmed, cancelled or deferred is observable only as
 * `state.lastFallbackReason` plus a user notice; the return value says only
 * `cancel`, `compaction` or nothing. Each test pins one verdict through the
 * caller-visible effects first, and records the state field only as the interim
 * equivalence contract for the later verdict-interface work.
 */

type ExtensionEventContext = Parameters<
	Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["on"]>[1]
>[1];

const SUMMARY = {
	summary:
		"Compaction Summary — Compact+ memory\n## Current Objective\nRepair login.",
	firstKeptEntryId: "entry-kept",
};

function createCtx(options?: {
	contextWindow?: number;
	streamRoute?: "registry" | "none";
}): ExtensionEventContext {
	const contextWindow = options?.contextWindow ?? 200_000;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { notify: vi.fn() },
		compact: vi.fn(),
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		model: {
			provider: "test",
			id: "model",
			api: "openai-completions",
			contextWindow,
			maxTokens: 4096,
		},
		getContextUsage: vi.fn(() => ({
			tokens: 20_000,
			contextWindow,
			percent: 10,
		})),
		sessionManager: {
			getSessionFile: vi.fn(() => "/tmp/session.jsonl"),
			getSessionId: vi.fn(() => "session-1"),
			getLeafId: vi.fn(() => "leaf-1"),
			getBranch: vi.fn(() => []),
			buildSessionProjection: vi.fn(() => ({ messages: [] })),
		},
		signal: new AbortController().signal,
	} as unknown as ExtensionEventContext;
	if (options?.streamRoute !== "none") {
		Object.defineProperty(ctx, "modelRegistry", {
			value: { streamSimple: vi.fn() },
		});
	}
	return ctx;
}

function createCoordinator(
	_ctx: ExtensionEventContext,
	options?: { guardNativeCompaction?: boolean; usage?: EffectiveUsage },
) {
	const state = new CompactionState();
	const coordinator = new CompactionCoordinator({
		state,
		pi: { sendUserMessage: vi.fn() } as never,
		thresholdSettings: {
			...DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
			thresholdMode: "effective_cap",
			guardNativeCompaction: options?.guardNativeCompaction ?? true,
		},
		getEffectiveUsage: () =>
			options?.usage ?? {
				percent: 10,
				tokens: 20_000,
				contextWindow: 200_000,
				source: "native",
			},
		persistTelemetrySnapshot: vi.fn(),
	});
	return { coordinator, state };
}

function preparation() {
	return {
		isSplitTurn: false,
		messagesToSummarize: [{ role: "user", content: "Task: repair login." }],
		turnPrefixMessages: [],
		settings: { enabled: true, keepRecentTokens: 100, reserveTokens: 4096 },
	};
}

function notices(ctx: ExtensionEventContext): string[] {
	return vi.mocked(ctx.ui.notify).mock.calls.map(([text]) => text as string);
}

afterEach(() => {
	runCustom.mockReset();
});

describe("CompactionCoordinator verdict contract: custom attempt outcomes", () => {
	it("reports a trimmed attempt as a success that dropped evidence, not a decline", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator(ctx);
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			result: SUMMARY,
			fallbackReason: SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
			evidenceTrimmedTurns: 2,
		});

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result?.compaction).toBeDefined();
		expect(result?.cancel).toBeUndefined();
		expect(
			notices(ctx).some((text) => text.includes("Dropped 2 retained turns")),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
		);
		expect(state.pendingCompaction?.intentEvidenceTrimmedTurns).toBe(2);
	});

	it("cancels and names the intent-evidence reason when the attempt could not measure its request", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator(ctx);
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			cancel: true,
			fallbackReason: SUMMARIZATION_INTENT_EVIDENCE_REASON,
		});

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(
			notices(ctx).some((text) =>
				text.includes("could not capture its additional intent evidence"),
			),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(SUMMARIZATION_INTENT_EVIDENCE_REASON);
		expect(state.pendingCompaction).toBeNull();
		expect(state.isCompacting).toBe(false);
	});

	it("falls back to a generic cancel reason when the attempt reports no reason at all", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator(ctx);
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({ cancel: true });

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.lastFallbackReason).toBe("custom compaction cancelled");
	});

	it("records the attempt reason on a successful compaction so telemetry and state agree", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator(ctx);
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			result: SUMMARY,
			fallbackReason: SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
		});

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result?.compaction?.summary).toBe(SUMMARY.summary);
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
		);
		expect(state.pendingCompaction?.fallbackReason).toBe(
			SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
		);
	});

	it("cancels an overflowing custom request only after measuring Pi's own payload as oversized", async () => {
		const ctx = createCtx({ contextWindow: 400 });
		const { coordinator, state } = createCoordinator(ctx, {
			usage: {
				percent: 95,
				tokens: 380,
				contextWindow: 400,
				source: "native",
			},
		});
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			requestOverflow: true,
			fallbackReason: SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		});

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(
			notices(ctx).some((text) =>
				text.includes(
					"Native Pi compaction was skipped because it would send the same oversized transcript",
				),
			),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});

	it("keeps an exhausted output budget a cancel instead of deferring to native compaction", async () => {
		const ctx = createCtx({ contextWindow: 400 });
		const { coordinator, state } = createCoordinator(ctx, {
			usage: {
				percent: 95,
				tokens: 380,
				contextWindow: 400,
				source: "native",
			},
		});
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			requestOverflow: true,
			fallbackReason: SUMMARIZATION_OUTPUT_CAP_REASON,
		});

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(
			notices(ctx).some((text) =>
				text.includes("reached its output token limit before it was complete"),
			),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(SUMMARIZATION_OUTPUT_CAP_REASON);
	});

	it("defers to native compaction and relabels the verdict when provider usage contradicts the estimate", async () => {
		const ctx = createCtx({ contextWindow: 200_000 });
		const { coordinator, state } = createCoordinator(ctx);
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			fallbackReason: SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		});

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toBeUndefined();
		expect(
			notices(ctx).some((text) =>
				text.includes("falling back to default compaction"),
			),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		);
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(state.pendingCompaction?.fallbackReason).toBe(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		);
	});

	it("keeps the attempt's own reason when the request still fits and provider usage has headroom", async () => {
		const ctx = createCtx({ contextWindow: 200_000 });
		const { coordinator, state } = createCoordinator(ctx, {
			usage: {
				percent: 95,
				tokens: 190_000,
				contextWindow: 200_000,
				source: "native",
			},
		});
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			fallbackReason: "provider refused the summary request",
		});

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toBeUndefined();
		expect(
			notices(ctx).some((text) =>
				text.includes("custom summarization unavailable"),
			),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(
			"provider refused the summary request",
		);
	});

	it("replaces the attempt's own reason with the measured overflow when Pi's payload cannot fit either", async () => {
		const ctx = createCtx({ contextWindow: 400 });
		const { coordinator, state } = createCoordinator(ctx, {
			usage: {
				percent: 95,
				tokens: 380,
				contextWindow: 400,
				source: "native",
			},
		});
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			fallbackReason: "provider refused the summary request",
		});

		const result = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					...preparation(),
					messagesToSummarize: [
						{ role: "user", content: `Task: ${"x".repeat(400_000)}` },
					],
				},
				branchEntries: [],
			} as never,
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(
			notices(ctx).some((text) =>
				text.includes("cancelled native Pi compaction"),
			),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});

	it("uses the generic unavailable reason when the attempt reports neither a result nor a reason", async () => {
		const ctx = createCtx({ contextWindow: 200_000 });
		const { coordinator, state } = createCoordinator(ctx);
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({});

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toBeUndefined();
		expect(state.lastFallbackReason).toBe("custom summarization unavailable");
	});

	it("cancels when the branch changed while the attempt was running", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator(ctx);
		state.selectedMode = "standard";
		const manager = ctx.sessionManager as unknown as {
			getLeafId: ReturnType<typeof vi.fn>;
		};
		runCustom.mockImplementation(async () => {
			manager.getLeafId.mockReturnValue("leaf-moved");
			return { result: SUMMARY };
		});

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.lastFallbackReason).toBe("compaction context changed");
		expect(state.pendingCompaction).toBeNull();
	});

	it("reports an aborted attempt as aborted and releases the attempt state", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator(ctx);
		state.selectedMode = "standard";
		state.isCompacting = true;
		const controller = new AbortController();
		controller.abort();

		const result = await coordinator.onSessionBeforeCompact(
			{
				preparation: preparation(),
				branchEntries: [],
				signal: controller.signal,
			} as never,
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.lastFallbackReason).toBe("compaction aborted");
		expect(state.isCompacting).toBe(false);
		expect(state.selectedMode).toBeNull();
	});
});

describe("CompactionCoordinator verdict contract: native deferral", () => {
	it("defers to native Pi compaction and records the compatibility reason when no stream-aware route exists", async () => {
		const ctx = createCtx({ streamRoute: "none" });
		const { coordinator, state } = createCoordinator(ctx);
		state.selectedMode = "standard";

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toBeUndefined();
		expect(
			notices(ctx).some((text) =>
				text.includes("deferring to native Pi compaction"),
			),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(NATIVE_FALLBACK_REASON);
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(state.isCompacting).toBe(false);
	});

	it("cancels the native deferral when Pi's own request is measured as oversized", async () => {
		const ctx = createCtx({ contextWindow: 400, streamRoute: "none" });
		const { coordinator, state } = createCoordinator(ctx, {
			usage: {
				percent: 95,
				tokens: 380,
				contextWindow: 400,
				source: "native",
			},
		});
		state.selectedMode = "standard";

		const result = await coordinator.onSessionBeforeCompact(
			{ preparation: preparation(), branchEntries: [] } as never,
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(
			notices(ctx).some((text) =>
				text.includes("cancelled native Pi compaction"),
			),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});

	it("skips the native overflow guard while provider usage plus the reserve still fit the window", async () => {
		const ctx = createCtx({ contextWindow: 400_000, streamRoute: "none" });
		const { coordinator, state } = createCoordinator(ctx, {
			usage: {
				percent: 47,
				tokens: 190_000,
				contextWindow: 400_000,
				source: "native",
			},
		});
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({});

		const result = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					...preparation(),
					messagesToSummarize: [
						{ role: "user", content: `Task: ${"x".repeat(2_000_000)}` },
					],
				},
				branchEntries: [],
			} as never,
			ctx,
		);

		// Today's fail-open fast path: the cut is a subset of the live session, so while
		// Pi reports the session fitting inside `contextWindow - reserveTokens` the guard
		// never measures and the compatibility reason stands.
		expect(result).toBeUndefined();
		expect(state.lastFallbackReason).toBe(NATIVE_FALLBACK_REASON);
	});

	it("relabels the native deferral as a suspect estimate when provider headroom contradicts the measured overflow", async () => {
		const ctx = createCtx({ contextWindow: 200_000, streamRoute: "none" });
		const { coordinator, state } = createCoordinator(ctx, {
			usage: {
				percent: 50,
				tokens: 100_000,
				contextWindow: 200_000,
				source: "native",
			},
		});
		state.selectedMode = "standard";
		// The guard only measures when guidance is present, and the discrepancy only
		// speaks when the guidance is Compact+'s own issued prompt echoed back verbatim.
		const issuedPrompt = `<current-focus>\nObjective: repair login.\n</current-focus>\n${"rule text ".repeat(500)}`;
		state.lastIssuedCompactionInstructions = issuedPrompt;
		runCustom.mockResolvedValue({});

		const result = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					...preparation(),
					messagesToSummarize: [
						{ role: "user", content: `Task: ${"x".repeat(1_000_000)}` },
					],
				},
				customInstructions: issuedPrompt,
				branchEntries: [],
			} as never,
			ctx,
		);

		expect(result).toBeUndefined();
		expect(
			notices(ctx).some((text) =>
				text.includes("deferring to native Pi compaction"),
			),
		).toBe(true);
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		);
		expect(state.pendingCompaction?.fallbackReason).toBe(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
		);
	});
});

describe("CompactionCoordinator verdict contract: no selected mode", () => {
	it("cancels a native compaction whose own request cannot fit, and warns once for the same cut", async () => {
		const ctx = createCtx({ contextWindow: 400, streamRoute: "none" });
		const { coordinator, state } = createCoordinator(ctx, {
			usage: {
				percent: 95,
				tokens: 380,
				contextWindow: 400,
				source: "native",
			},
		});

		const first = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					...preparation(),
					messagesToSummarize: [
						{ role: "user", content: `Task: ${"x".repeat(400_000)}` },
					],
				},
				branchEntries: [],
			} as never,
			ctx,
		);
		const second = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					...preparation(),
					messagesToSummarize: [
						{ role: "user", content: `Task: ${"x".repeat(400_000)}` },
					],
				},
				branchEntries: [],
			} as never,
			ctx,
		);

		expect(first).toEqual({ cancel: true });
		expect(second).toEqual({ cancel: true });
		const warnings = notices(ctx).filter((text) =>
			text.includes("cancelled native Pi compaction"),
		);
		expect(warnings).toHaveLength(1);
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
	});
});
