import { afterEach, describe, expect, it, vi } from "vitest";

const { prepareBoundaryCompaction } = vi.hoisted(() => ({
	prepareBoundaryCompaction: vi.fn(),
}));

vi.mock("../src/boundary-preparation.js", () => ({
	prepareBoundaryCompaction,
}));

import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import { type EffectiveUsage, REGROWTH_TOKENS } from "../src/types.js";

/**
 * Characterization tests for the `maybeAutoCompactAtBoundary` guard cascade
 * (src/compaction-coordinator.ts:637). Pi 0.87's post-tool transaction must never
 * abort an active run, so every declined arm has to return no boundary result and
 * leave no attempt state behind. Boundary preparation is stubbed so each arm is
 * reached deliberately; the arms themselves run through the real coordinator.
 */

type ExtensionEventContext = Parameters<
	Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["on"]>[1]
>[1];

const HIGH_TOKENS = 160_000;
const HIGH_USAGE: EffectiveUsage = {
	percent: 80,
	tokens: HIGH_TOKENS,
	contextWindow: 200_000,
	source: "native",
};

function createCtx(options?: {
	mode?: string;
	sessionFile?: string | undefined;
	streamRoute?: "registry" | "none";
}): ExtensionEventContext {
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
			tokens: 160_000,
			contextWindow: 200_000,
			percent: 80,
		})),
		sessionManager: {
			getSessionFile: vi.fn(() => options?.sessionFile ?? "/tmp/session.jsonl"),
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

/** A declined boundary arm must produce no Pi compaction request, no notice, and no attempt state. */
function expectDeclined(
	result: unknown,
	ctx: ExtensionEventContext,
	state: CompactionState,
) {
	expect(result).toBeUndefined();
	expect(ctx.compact).not.toHaveBeenCalled();
	expect(ctx.ui.notify).not.toHaveBeenCalled();
	// Interim equivalence contract: today's state shape, pinned only so the later
	// interface change can prove equivalence.
	expect(state.selectedMode).toBeNull();
	expect(state.isCompacting).toBe(false);
	expect(state.lastTriggerAuto).toBe(false);
	expect(state.pendingBoundaryMarker).toBeNull();
	expect(state.lastFallbackReason).toBeNull();
}

afterEach(() => {
	prepareBoundaryCompaction.mockReset();
	vi.restoreAllMocks();
});

describe("CompactionCoordinator.maybeAutoCompactAtBoundary declined guard arms", () => {
	it("declines an event with no context snapshot", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent({ context: undefined }),
			ctx,
		);

		expectDeclined(result, ctx, state);
	});

	it("declines a turn that did not complete", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent({ outcome: "aborted" }),
			ctx,
		);

		expectDeclined(result, ctx, state);
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

		expectDeclined(result, ctx, state);
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

		expectDeclined(result, ctx, state);
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

		expectDeclined(result, ctx, state);
	});

	it("declines in an ephemeral headless child with no session file", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx({ mode: "json", sessionFile: undefined });

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(result, ctx, state);
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
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.isCompacting).toBe(true);
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

		expectDeclined(result, ctx, state);
	});

	it("declines a second boundary attempt inside the same turn", async () => {
		const { coordinator, state } = createCoordinator();
		state.lastCompactTurnIndex = 3;
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(result, ctx, state);
	});

	it("declines while the cooldown window is still open", async () => {
		const { coordinator, state } = createCoordinator();
		state.lastCompactTime = Date.now();
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(result, ctx, state);
	});

	it("declines when no usage can be resolved", async () => {
		const { coordinator, state } = createCoordinator({ usage: null });
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(result, ctx, state);
	});

	it("declines when the session has no model", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();
		ctx.model = undefined;

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(result, ctx, state);
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

		expectDeclined(result, ctx, state);
	});

	it("declines when token regrowth since the last compaction is below the threshold", async () => {
		const { coordinator, state } = createCoordinator();
		state.lastCompactTokens = HIGH_TOKENS - (REGROWTH_TOKENS - 1);
		const ctx = createCtx();

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(result, ctx, state);
	});

	it("declines when the runtime resolves to native fallback instead of a custom cut", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx({ streamRoute: "none" });

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expectDeclined(result, ctx, state);
		expect(prepareBoundaryCompaction).not.toHaveBeenCalled();
	});
});

describe("CompactionCoordinator.maybeAutoCompactAtBoundary attempt failures", () => {
	it("returns no boundary result when Pi's cut preparation is unavailable", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();
		prepareBoundaryCompaction.mockReturnValue(undefined);

		const result = await coordinator.maybeAutoCompactAtBoundary(
			createEvent(),
			ctx,
		);

		expect(result).toBeUndefined();
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.pendingBoundaryMarker).toBeNull();
		expect(state.lastFallbackReason).toBeNull();
		expect(state.selectedMode).toBeNull();
		expect(state.isCompacting).toBe(false);
	});

	it("reports safe turn-boundary compaction unavailable when the attempt throws", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createCtx();
		prepareBoundaryCompaction.mockReturnValue({
			isSplitTurn: false,
			messagesToSummarize: [
				{ role: "user", content: "Task: repair login." },
				{ role: "assistant", content: [] },
			],
			turnPrefixMessages: [],
			settings: { enabled: true, keepRecentTokens: 100, reserveTokens: 4096 },
		});
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
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.pendingBoundaryMarker).toBeNull();
		expect(state.selectedMode).toBeNull();
		expect(state.isCompacting).toBe(false);
		expect(state.lastTriggerAuto).toBe(false);
		// Interim equivalence contract: today the only signal of this failure is the
		// reason string in shared state.
		expect(state.lastFallbackReason).toBe(
			"safe turn-boundary compaction unavailable",
		);
	});
});
