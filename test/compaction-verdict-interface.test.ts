import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prepareBoundaryCompaction, runCustom } = vi.hoisted(() => ({
	prepareBoundaryCompaction: vi.fn(),
	runCustom: vi.fn(),
}));

vi.mock("../src/boundary-preparation.js", () => ({
	prepareBoundaryCompaction,
}));
vi.mock("../src/compact.js", () => ({ runCustomCompaction: runCustom }));

import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import {
	type CompactionVerdict,
	compactionVerdictKindForReason,
} from "../src/compaction-verdict.js";
import { NATIVE_FALLBACK_REASON } from "../src/compatibility.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import {
	SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
	SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
	SUMMARIZATION_INTENT_EVIDENCE_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
} from "../src/summarization-overflow.js";
import type { EffectiveUsage } from "../src/types.js";

/**
 * Interface contract for the typed compaction verdict.
 *
 * Two guarantees are pinned here. First: what Pi sees is unchanged. The Pi-owned
 * handlers still return exactly `undefined | { cancel: true } | { compaction }` for
 * `session_before_compact` and `{ entries } | undefined` for `turn_end`, asserted by
 * exact top-level keys so an extra Pi-visible field cannot slip in, and the verdict
 * travels only through `getLastVerdict()`. Second: the Compact+-owned entry points
 * record no verdict of their own at a guard that writes no reason, so an accessor read
 * after such a call still reports the previous decision, never an invented one.
 */

type ExtensionEventContext = Parameters<
	Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["on"]>[1]
>[1];

const SUMMARY = {
	summary:
		"Compaction Summary — Compact+ memory\n## Current Objective\nRepair login.",
	firstKeptEntryId: "entry-kept",
};

const HIGH_USAGE: EffectiveUsage = {
	percent: 80,
	tokens: 160_000,
	contextWindow: 200_000,
	source: "native",
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

function createCoordinator(options?: {
	usage?: EffectiveUsage | null;
	thresholdMode?: "effective_cap" | "percent";
	guardNativeCompaction?: boolean;
}) {
	const state = new CompactionState();
	const usage: EffectiveUsage | null =
		options?.usage === undefined ? HIGH_USAGE : options.usage;
	const coordinator = new CompactionCoordinator({
		state,
		pi: { sendUserMessage: vi.fn() } as never,
		thresholdSettings: {
			...DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
			thresholdMode: options?.thresholdMode ?? "effective_cap",
			guardNativeCompaction:
				options?.guardNativeCompaction ??
				DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS.guardNativeCompaction,
		},
		getEffectiveUsage: () => usage,
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

function beforeCompact(
	ctx: ExtensionEventContext,
	coordinator: CompactionCoordinator,
) {
	return coordinator.onSessionBeforeCompact(
		{ preparation: preparation(), branchEntries: [] } as never,
		ctx,
	);
}

function boundaryPreparation() {
	return {
		isSplitTurn: false,
		messagesToSummarize: [
			{ role: "user", content: "Task: repair login." },
			{ role: "assistant", content: [] },
		],
		turnPrefixMessages: [],
		settings: { enabled: true, keepRecentTokens: 100, reserveTokens: 4096 },
	};
}

function boundaryEvent() {
	return {
		type: "turn_end",
		turnIndex: 3,
		outcome: "completed",
		message: { role: "assistant", stopReason: "toolUse", content: [] },
		entries: [],
		context: {
			contextEntries: [],
			contextMessages: [{ role: "user", content: "Task: repair login." }],
			pendingMessages: [],
		},
	} as never;
}

beforeEach(() => {
	// Arm the succeeding downstream attempt before every test, so the accepted arms do
	// not depend on a previous test having run.
	prepareBoundaryCompaction.mockReturnValue(boundaryPreparation());
	runCustom.mockResolvedValue({ result: SUMMARY });
});

afterEach(() => {
	prepareBoundaryCompaction.mockReset();
	runCustom.mockReset();
});

describe("Pi-owned handlers keep their return shape", () => {
	it("cancels a custom attempt the same way and exposes the verdict separately", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({ cancel: true });

		const result = await beforeCompact(ctx, coordinator);

		expect(result).toEqual({ cancel: true });
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "cancelled",
			reason: "custom compaction cancelled",
		});
	});

	it("defers to native Pi compaction the same way and exposes a deferred verdict", async () => {
		const ctx = createCtx({ streamRoute: "none" });
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";

		const result = await beforeCompact(ctx, coordinator);

		expect(result).toBeUndefined();
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason: NATIVE_FALLBACK_REASON,
		});
	});

	it("reports an aborted attempt the same way and exposes a cancelled verdict", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
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
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "cancelled",
			reason: "compaction aborted",
		});
	});
});

describe("Compact+-owned entry points expose their decision through the accessor", () => {
	it("records no verdict when the trigger stopped at a guard that writes no reason", async () => {
		const ctx = createCtx();
		const { coordinator } = createCoordinator({ usage: null });

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(coordinator.getLastVerdict()).toBeNull();
	});

	it("records no verdict when a manual command is refused before any decision", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.isCompacting = true;

		await coordinator.handleManualCommand("standard", ctx);

		expect(coordinator.getLastVerdict()).toBeNull();
	});

	it("leaves an earlier verdict untouched when a guard stops the trigger", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({ cancel: true });
		await beforeCompact(ctx, coordinator);
		const recorded = coordinator.getLastVerdict() as CompactionVerdict;
		expect(recorded.kind).toBe("cancelled");

		await coordinator.maybeAutoCompact(ctx, "turn_end", 9);

		expect(coordinator.getLastVerdict()).toEqual(recorded);
	});
});

describe("verdict lifetime", () => {
	it("starts with no verdict", () => {
		const { coordinator } = createCoordinator();
		expect(coordinator.getLastVerdict()).toBeNull();
	});

	it("is cleared with the rest of the session state", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({ cancel: true });
		await beforeCompact(ctx, coordinator);
		expect(coordinator.getLastVerdict()).not.toBeNull();

		state.reset();

		expect(coordinator.getLastVerdict()).toBeNull();
	});

	it("is cleared when the model changes", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.resetOnModelChange("model-a");
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({ cancel: true });
		await beforeCompact(ctx, coordinator);
		expect(coordinator.getLastVerdict()).not.toBeNull();

		state.resetOnModelChange("model-b");

		expect(coordinator.getLastVerdict()).toBeNull();
	});
});

describe("verdict travels with the compaction it describes", () => {
	it("records an accepted compaction with no reason", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			result: SUMMARY,
			classifiedCounts: { totalMessages: 2 },
		});

		const result = await beforeCompact(ctx, coordinator);

		expect(Object.keys(result ?? {})).toEqual(["compaction"]);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "accepted",
			reason: null,
		});
	});

	it("records the trimmed turn count when the attempt dropped its own evidence", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			result: SUMMARY,
			classifiedCounts: { totalMessages: 2 },
			fallbackReason: "intent evidence was trimmed to fit the summary request",
			evidenceTrimmedTurns: 3,
		});

		const result = await beforeCompact(ctx, coordinator);

		expect(Object.keys(result ?? {})).toEqual(["compaction"]);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "trimmed",
			reason: "intent evidence was trimmed to fit the summary request",
			evidenceTrimmedTurns: 3,
		});
	});
});

describe("Pi-owned boundary handler keeps its return shape", () => {
	it("offers the same boundary entry and exposes the verdict separately", async () => {
		const ctx = createCtx();
		const { coordinator } = createCoordinator({ thresholdMode: "percent" });

		const result = await coordinator.maybeAutoCompactAtBoundary(
			boundaryEvent(),
			ctx,
		);

		expect(Object.keys(result ?? {})).toEqual(["entries"]);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "accepted",
			reason: null,
		});
	});

	it("returns no boundary result when preparation is unavailable", async () => {
		const ctx = createCtx();
		const { coordinator } = createCoordinator({ thresholdMode: "percent" });
		prepareBoundaryCompaction.mockReturnValue(undefined);

		const result = await coordinator.maybeAutoCompactAtBoundary(
			boundaryEvent(),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(coordinator.getLastVerdict()).toBeNull();
	});

	it("returns no boundary result when a guard stops the trigger", async () => {
		const ctx = createCtx();
		const { coordinator } = createCoordinator({
			thresholdMode: "percent",
			usage: null,
		});

		const result = await coordinator.maybeAutoCompactAtBoundary(
			boundaryEvent(),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(prepareBoundaryCompaction).not.toHaveBeenCalled();
		expect(coordinator.getLastVerdict()).toBeNull();
	});
});

describe("restored telemetry cannot disagree with the verdict", () => {
	it("derives a verdict from a persisted reason", () => {
		const { coordinator, state } = createCoordinator();

		coordinator.restoreVerdictFromPersistedReason(NATIVE_FALLBACK_REASON);

		expect(state.lastFallbackReason).toBe(NATIVE_FALLBACK_REASON);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason: NATIVE_FALLBACK_REASON,
		});
	});

	it("cannot restore a settlement that happened after the persisted decision", async () => {
		// Compact+ defers, Pi settles a compaction, and the session's newest verdict becomes
		// `accepted`. The prose that survives telemetry is still the deferral's, so the same
		// reason restores as `deferred`. A restore cannot see the settlement, only the decision
		// that was last persisted.
		const ctx = createCtx({ streamRoute: "none" });
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";

		await beforeCompact(ctx, coordinator);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason: NATIVE_FALLBACK_REASON,
		});

		await coordinator.onSessionCompact(
			{
				compactionEntry: {
					timestamp: new Date().toISOString(),
					details: null,
				},
				fromExtension: false,
			} as never,
			ctx,
		);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "accepted",
			reason: NATIVE_FALLBACK_REASON,
		});

		const { coordinator: restored } = createCoordinator();
		restored.restoreVerdictFromPersistedReason(NATIVE_FALLBACK_REASON);
		expect(restored.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason: NATIVE_FALLBACK_REASON,
		});
	});

	it("records no verdict when the persisted telemetry recorded no reason", () => {
		const { coordinator } = createCoordinator();

		coordinator.restoreVerdictFromPersistedReason(null);

		expect(coordinator.getLastVerdict()).toBeNull();
	});
});

type MappingRow = {
	reason: string;
	/** Arrange the mocks and state that make this the reason Compact+ writes. */
	arm: (state: CompactionState, ctx: ExtensionEventContext) => void;
	drive: (
		coordinator: CompactionCoordinator,
		ctx: ExtensionEventContext,
	) => Promise<unknown>;
};

/**
 * One row per reason Compact+ can write on exactly one path. Each row drives the real
 * writer, then compares the kind the coordinator recorded with the kind the mapper predicts
 * from the reason alone. The mapper is what a restored session reads, so a mismatch here is a
 * divergence between what a live session decided and what the next session will believe.
 */
function singlePathRows(): MappingRow[] {
	const customAttempt =
		(attempt: Record<string, unknown>) => (state: CompactionState) => {
			state.selectedMode = "standard";
			runCustom.mockResolvedValue(attempt);
		};
	const viaBeforeCompact = async (
		coordinator: CompactionCoordinator,
		ctx: ExtensionEventContext,
	) => beforeCompact(ctx, coordinator);

	return [
		{
			reason: "custom compaction cancelled",
			arm: customAttempt({ cancel: true }),
			drive: viaBeforeCompact,
		},
		{
			// The intent-evidence overflow is a fail-closed cancel: the attempt cannot send what
			// it rendered, and no other path writes this reason.
			reason: SUMMARIZATION_INTENT_EVIDENCE_REASON,
			arm: customAttempt({
				cancel: true,
				fallbackReason: SUMMARIZATION_INTENT_EVIDENCE_REASON,
			}),
			drive: viaBeforeCompact,
		},
		{
			reason: "compaction context changed",
			arm: customAttempt({
				cancel: true,
				fallbackReason: "compaction context changed",
			}),
			drive: viaBeforeCompact,
		},
		{
			reason: "compaction aborted",
			arm: (state) => {
				state.selectedMode = "standard";
				state.isCompacting = true;
			},
			drive: async (coordinator, ctx) => {
				const controller = new AbortController();
				controller.abort();
				return coordinator.onSessionBeforeCompact(
					{
						preparation: preparation(),
						branchEntries: [],
						signal: controller.signal,
					} as never,
					ctx,
				);
			},
		},
		{
			reason: "auth unavailable",
			arm: customAttempt({
				result: undefined,
				fallbackReason: "auth unavailable",
			}),
			drive: viaBeforeCompact,
		},
		{
			reason: "compact returned undefined",
			arm: customAttempt({
				result: undefined,
				fallbackReason: "compact returned undefined",
			}),
			drive: viaBeforeCompact,
		},
		{
			reason: "model unavailable",
			arm: customAttempt({
				result: undefined,
				fallbackReason: "model unavailable",
			}),
			drive: viaBeforeCompact,
		},
		{
			reason: "compact error: provider request failed",
			arm: customAttempt({
				result: undefined,
				fallbackReason: "compact error: provider request failed",
			}),
			drive: viaBeforeCompact,
		},
		{
			reason: "compaction summary invalid: summary is empty",
			arm: customAttempt({
				result: undefined,
				fallbackReason: "compaction summary invalid: summary is empty",
			}),
			drive: viaBeforeCompact,
		},
		{
			reason: "custom summarization unavailable",
			arm: customAttempt({ result: undefined }),
			drive: viaBeforeCompact,
		},
		{
			reason: SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
			arm: customAttempt({
				result: SUMMARY,
				fallbackReason: SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
				evidenceTrimmedTurns: 2,
			}),
			drive: viaBeforeCompact,
		},
		{
			reason: "safe turn-boundary compaction unavailable",
			arm: (_state, ctx) => {
				const manager = ctx.sessionManager as unknown as {
					getBranch: ReturnType<typeof vi.fn>;
				};
				manager.getBranch.mockImplementation(() => {
					throw new Error("session manager failed mid-attempt");
				});
			},
			drive: async (coordinator, ctx) =>
				coordinator.maybeAutoCompactAtBoundary(boundaryEvent(), ctx),
		},
		{
			reason: NATIVE_FALLBACK_REASON,
			arm: (state) => {
				// A custom attempt is requested; the row's context has no stream-aware route, so
				// the runtime defers before the attempt can produce a result.
				state.selectedMode = "standard";
			},
			drive: viaBeforeCompact,
		},
	];
}

describe("live verdict kinds agree with the reason mapping", () => {
	it("records the kind the mapper predicts for every single-path reason", async () => {
		for (const row of singlePathRows()) {
			const nativeRoute = row.reason === NATIVE_FALLBACK_REASON;
			const ctx = createCtx(nativeRoute ? { streamRoute: "none" } : undefined);
			const { coordinator, state } = createCoordinator();
			row.arm(state, ctx);
			await row.drive(coordinator, ctx);

			const live = coordinator.getLastVerdict();
			expect(live, row.reason).not.toBeNull();
			expect(live?.reason, row.reason).toBe(row.reason);
			expect(live?.kind, row.reason).toBe(
				compactionVerdictKindForReason(row.reason),
			);
		}
	});

	it("pins the divergence for the output-cap reason too", async () => {
		// The shape src/compact.ts returns when the provider confirms an exhausted output
		// budget: no result, no cancel, requestOverflow and providerConfirmed set. With
		// comfortable headroom for Pi's own payload the coordinator defers, so the live kind is
		// `deferred` while the mapper, reading only the prose, says `cancelled`.
		const reason = SUMMARIZATION_OUTPUT_CAP_REASON;
		expect(compactionVerdictKindForReason(reason)).toBe("cancelled");

		const ctx = createCtx();
		const { coordinator, state } = createCoordinator({
			// The kill switch is what makes an exhausted output budget a deferral instead of a
			// cancel: Pi is allowed to try the same cut itself.
			guardNativeCompaction: false,
		});
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			result: undefined,
			fallbackReason: reason,
			requestOverflow: true,
			providerConfirmed: true,
		});
		await beforeCompact(ctx, coordinator);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason,
		});

		const { coordinator: restored } = createCoordinator();
		restored.restoreVerdictFromPersistedReason(reason);
		expect(restored.getLastVerdict()).toMatchObject({
			kind: "cancelled",
			reason,
		});
	});

	it("pins the divergence for the context-overflow reason", async () => {
		// Live: the attempt was cancelled after it started, so the coordinator recorded a
		// cancelled attempt. Restored: only the prose survives, and the mapper classifies the
		// guard decline. Both sides are asserted so the consumer-switching slice cannot treat a
		// restored verdict as the decision the live session actually made.
		const reason = SUMMARIZATION_CONTEXT_OVERFLOW_REASON;
		expect(compactionVerdictKindForReason(reason)).toBe("declined");

		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({ cancel: true, fallbackReason: reason });
		await beforeCompact(ctx, coordinator);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "cancelled",
			reason,
		});

		const { coordinator: restored } = createCoordinator();
		restored.restoreVerdictFromPersistedReason(reason);
		expect(restored.getLastVerdict()).toMatchObject({
			kind: "declined",
			reason,
		});
	});
});
