import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prepareBoundaryCompaction, runCustom } = vi.hoisted(() => ({
	prepareBoundaryCompaction: vi.fn(),
	runCustom: vi.fn(),
}));

vi.mock("../src/boundary-preparation.js", () => ({
	prepareBoundaryCompaction,
}));
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
import {
	type CompactionVerdict,
	compactionVerdictKindForReason,
} from "../src/compaction-verdict.js";
import { NATIVE_FALLBACK_REASON } from "../src/compatibility.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import {
	SUMMARIZATION_INTENT_EVIDENCE_REASON,
	SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
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

		expect(coordinator.getLastVerdict()).toBe(recorded);
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

	it("records no verdict when the persisted telemetry recorded no reason", () => {
		const { coordinator } = createCoordinator();

		coordinator.restoreVerdictFromPersistedReason(null);

		expect(coordinator.getLastVerdict()).toBeNull();
	});
});

describe("live verdict kinds agree with the reason mapping", () => {
	it("maps every single-path reason to the kind its writer records", () => {
		const singlePath: Array<[string, string]> = [
			["compaction aborted", "cancelled"],
			["compaction context changed", "cancelled"],
			["custom compaction cancelled", "cancelled"],
			["custom summarization unavailable", "deferred"],
			["safe turn-boundary compaction unavailable", "declined"],
			["compact returned undefined", "deferred"],
			["auth unavailable", "deferred"],
			["model unavailable", "deferred"],
			["compact error: provider request failed", "deferred"],
			["compaction summary invalid: summary is empty", "deferred"],
			[NATIVE_FALLBACK_REASON, "deferred"],
			[SUMMARIZATION_SUSPECT_ESTIMATE_REASON, "deferred"],
		];
		for (const [reason, kind] of singlePath) {
			expect(compactionVerdictKindForReason(reason), reason).toBe(kind);
		}
	});

	it("pins the documented override for a reason written on two paths", async () => {
		// The mapper sees the guard path; the coordinator sees the cancelled attempt.
		expect(
			compactionVerdictKindForReason(SUMMARIZATION_INTENT_EVIDENCE_REASON),
		).toBe("declined");
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			cancel: true,
			fallbackReason: SUMMARIZATION_INTENT_EVIDENCE_REASON,
		});

		await beforeCompact(ctx, coordinator);

		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "cancelled",
			reason: SUMMARIZATION_INTENT_EVIDENCE_REASON,
		});
	});
});
