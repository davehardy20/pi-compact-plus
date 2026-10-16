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
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import { type EffectiveUsage, REGROWTH_TOKENS } from "../src/types.js";

/**
 * Characterization tests for the `maybeAutoCompactAtBoundary` guard cascade
 * (`maybeAutoCompactAtBoundary`, src/compaction-coordinator.ts). Pi 0.87's post-tool
 * transaction must never abort an active run, so every declined arm has to return no
 * boundary result and leave no attempt state behind.
 *
 * Both downstream collaborators are stubbed with a *succeeding* attempt, so each
 * guard is mutation-sensitive: deleting a guard lets execution reach boundary
 * preparation and the attempt, which these tests detect by asserting preparation
 * was never called. A stub that only ever returned `undefined` would let every
 * early guard survive deletion because the later `if (!preparation)` arm produces
 * the same outcome.
 */

type ExtensionEventContext = Parameters<
	Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["on"]>[1]
>[1];

const SUMMARY = {
	summary:
		"Compaction Summary — Compact+ memory\n## Current Objective\nRepair login.",
	firstKeptEntryId: "entry-kept",
};

const HIGH_TOKENS = 160_000;
const HIGH_USAGE: EffectiveUsage = {
	percent: 80,
	tokens: HIGH_TOKENS,
	contextWindow: 200_000,
	source: "native",
};

const DEFAULT_SESSION_FILE = "/tmp/session.jsonl";

function createCtx(options?: {
	mode?: string;
	sessionFile?: string | undefined;
	streamRoute?: "registry" | "none";
}): ExtensionEventContext {
	// An explicitly passed `undefined` must stay undefined: it is the condition the
	// ephemeral-headless-child guard names.
	const sessionFile =
		options && "sessionFile" in options
			? options.sessionFile
			: DEFAULT_SESSION_FILE;
	const ctx = {
		cwd: "/tmp/compact-plus-boundary-guard-test",
		mode: (options?.mode ?? "tui") as ExtensionEventContext["mode"],
		hasUI: true,
		ui: { notify: vi.fn() },
		compact: vi.fn(),
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		model: {
			provider: "test",
			id: "model",
			contextWindow: 200_000,
			api: "openai-completions",
			maxTokens: 4096,
		},
		getContextUsage: vi.fn(() => ({
			tokens: HIGH_TOKENS,
			contextWindow: 200_000,
			percent: 80,
		})),
		sessionManager: {
			getSessionFile: vi.fn(() => sessionFile),
			getSessionId: vi.fn(() => "test-session"),
			getLeafId: vi.fn(() => "test-leaf"),
			getBranch: vi.fn(() => []),
			getEntry: vi.fn(() => undefined),
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

function createEvent(overrides?: Record<string, unknown>) {
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
		...overrides,
	} as never;
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

function createCoordinator(options?: {
	disableAutoCompaction?: boolean;
	usage?: EffectiveUsage | null;
}) {
	const state = new CompactionState();
	const usage: EffectiveUsage | null =
		options?.usage === undefined ? HIGH_USAGE : options.usage;
	const coordinator = new CompactionCoordinator({
		state,
		pi: { sendUserMessage: vi.fn() } as never,
		thresholdSettings: {
			...DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
			thresholdMode: "percent",
		},
		getEffectiveUsage: () => usage,
		persistTelemetrySnapshot: vi.fn(),
		disableAutoCompaction: options?.disableAutoCompaction ?? false,
	});
	return { coordinator, state };
}

/**
 * A declined arm must produce no Pi compaction request, no notice, no attempt
 * state, and must never reach boundary preparation. The preparation assertion is
 * what makes each guard individually detectable.
 */
function expectDeclined(
	coordinator: CompactionCoordinator,
	result: unknown,
	ctx: ExtensionEventContext,
	state: CompactionState,
) {
	expect(result).toBeUndefined();
	expect(prepareBoundaryCompaction).not.toHaveBeenCalled();
	expect(ctx.compact).not.toHaveBeenCalled();
	expect(ctx.ui.notify).not.toHaveBeenCalled();
	// A guard that records no decision leaves no verdict behind.
	expect(coordinator.getLastVerdict()).toBeNull();
	expect(state.selectedMode).toBeNull();
	expect(state.isCompacting).toBe(false);
	expect(state.lastTriggerAuto).toBe(false);
	expect(state.pendingBoundaryMarker).toBeNull();
}

/** Today's boundary entry is a Pi `SessionBoundaryDraft`; only the Compact+ stamped
 * fields are asserted here, so the draft is read through a narrow view. */
function boundaryEntry(result: { entries?: unknown[] } | undefined):
	| {
			type?: string;
			firstKeptEntryId?: string;
			details?: { compactPlusBoundary?: string };
	  }
	| undefined {
	return result?.entries?.[0] as
		| {
				type?: string;
				firstKeptEntryId?: string;
				details?: { compactPlusBoundary?: string };
		  }
		| undefined;
}

beforeEach(() => {
	// Arm the succeeding downstream attempt before every test, so each test stands on
	// its own and the accepted arms do not depend on a previous test having run.
	prepareBoundaryCompaction.mockReturnValue(boundaryPreparation());
	runCustom.mockResolvedValue({ result: SUMMARY });
});

afterEach(() => {
	prepareBoundaryCompaction.mockReset();
	runCustom.mockReset();
});

describe("CompactionCoordinator.maybeAutoCompactAtBoundary declined guard arms", () => {
	it("declines an event with no context snapshot", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent({ context: undefined }),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines a turn that did not complete", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent({ outcome: "aborted" }),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines a non-assistant turn", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent({
				message: { role: "user", stopReason: "stop", content: [] },
			}),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines a turn that ended without a tool call", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent({
				message: { role: "assistant", stopReason: "stop", content: [] },
			}),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines when the kill switch is set", async () => {
		const { coordinator, state } = createCoordinator({
			disableAutoCompaction: true,
		});
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines in an ephemeral headless child with no session file", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx({ mode: "json", sessionFile: undefined });
		expect(ctx.sessionManager.getSessionFile()).toBeUndefined();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines while a compaction is already in flight", async () => {
		const { coordinator, state } = createCoordinator();
		state.isCompacting = true;
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(prepareBoundaryCompaction).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.isCompacting).toBe(true);
		expect(state.pendingBoundaryMarker).toBeNull();
	});

	it("declines while a boundary draft awaits Pi's commit", async () => {
		const { coordinator, state } = createCoordinator();
		state.pendingBoundaryMarker = "uncommitted boundary";
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(prepareBoundaryCompaction).not.toHaveBeenCalled();
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.pendingBoundaryMarker).toBe("uncommitted boundary");
	});

	it("declines while the tool-output pruning flush is in progress", async () => {
		const { coordinator, state } = createCoordinator();
		state.toolOutputPruning.isFlushing = true;
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines a second boundary attempt inside the same turn", async () => {
		const { coordinator, state } = createCoordinator();
		state.lastCompactTurnIndex = 3;
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines while the cooldown window is still open", async () => {
		const { coordinator, state } = createCoordinator();
		state.lastCompactTime = Date.now();
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines when no usage can be resolved", async () => {
		const { coordinator, state } = createCoordinator({ usage: null });
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines when the session has no model", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();
		ctx.model = undefined;

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines a checkpoint-band turn", async () => {
		const { coordinator, state } = createCoordinator({
			usage: {
				percent: 66,
				tokens: 132_000,
				contextWindow: 200_000,
				source: "native",
			},
		});
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines when token regrowth since the last compaction is below the threshold", async () => {
		const { coordinator, state } = createCoordinator();
		state.lastCompactTokens = HIGH_TOKENS - (REGROWTH_TOKENS - 1);
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});

	it("declines when the runtime resolves to native fallback instead of a custom cut", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx({ streamRoute: "none" });

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(coordinator, result, ctx, state);
	});
});

describe("CompactionCoordinator.maybeAutoCompactAtBoundary accepted arms", () => {
	it("runs the boundary attempt and stamps the boundary marker on the produced entry", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expect(prepareBoundaryCompaction).toHaveBeenCalledTimes(1);
		expect(prepareBoundaryCompaction).toHaveBeenCalledWith(
			expect.anything(),
			ctx,
			HIGH_TOKENS,
		);
		expect(ctx.compact).not.toHaveBeenCalled();
		const entry = boundaryEntry(result);
		expect(entry?.type).toBe("compaction");
		expect(entry?.firstKeptEntryId).toBe(SUMMARY.firstKeptEntryId);
		const marker = entry?.details?.compactPlusBoundary;
		expect(typeof marker).toBe("string");
		expect(state.pendingBoundaryMarker).toBe(marker);
		expect(state.lastCompactTurnIndex).toBe(3);
		// Interim equivalence contract: the attempt's transient flags are cleared in all
		// cases by the `finally` block; only the pending marker survives for Pi to commit.
		expect(state.isCompacting).toBe(false);
		expect(state.lastTriggerAuto).toBe(false);
		expect(state.selectedMode).toBeNull();
	});

	it("proceeds on percent usage when token regrowth cannot be measured", async () => {
		const { coordinator, state } = createCoordinator({
			usage: {
				percent: 80,
				tokens: null,
				contextWindow: 200_000,
				source: "native",
			},
		});
		state.lastCompactTokens = 10_000;
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		// An unmeasurable token count must not disable the boundary path: the percent
		// trigger still decides, and preparation receives the documented zero fallback.
		expect(prepareBoundaryCompaction).toHaveBeenCalledWith(
			expect.anything(),
			ctx,
			0,
		);
		expect(boundaryEntry(result)?.type).toBe("compaction");
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.pendingBoundaryMarker).not.toBeNull();
	});

	it("returns no boundary result when Pi's cut preparation is unavailable", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();
		prepareBoundaryCompaction.mockReturnValue(undefined);

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expect(prepareBoundaryCompaction).toHaveBeenCalledTimes(1);
		expect(result).toBeUndefined();
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.pendingBoundaryMarker).toBeNull();
		expect(coordinator.getLastVerdict()).toBeNull();
		// Interim equivalence contract: the attempt flags are cleared whether or not
		// preparation succeeded, so a missing preparation is invisible in state.
		expect(state.selectedMode).toBeNull();
		expect(state.lastTriggerAuto).toBe(false);
		expect(state.isCompacting).toBe(false);
	});

	it("reports safe turn-boundary compaction unavailable when the attempt throws", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();
		const manager = ctx.sessionManager as unknown as {
			getBranch: ReturnType<typeof vi.fn>;
		};
		manager.getBranch.mockImplementation(() => {
			throw new Error("session manager failed mid-attempt");
		});

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(prepareBoundaryCompaction).toHaveBeenCalledTimes(1);
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.pendingBoundaryMarker).toBeNull();
		expect(state.isCompacting).toBe(false);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "declined",
			reason: "safe turn-boundary compaction unavailable",
		});
	});
});
