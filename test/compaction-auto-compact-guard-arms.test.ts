import { describe, expect, it, vi } from "vitest";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import {
	type CompactPlusThresholdSettings,
	DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
} from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import { type EffectiveUsage, REGROWTH_TOKENS } from "../src/types.js";

/**
 * Characterization tests for the `maybeAutoCompact` guard cascade
 * (src/compaction-coordinator.ts:569). Pins today's behaviour: each guard arm is
 * driven through the public method and asserted through caller-visible effects
 * (whether Pi was asked to compact, whether the user was notified), with the
 * current `CompactionState` fields recorded only as the interim equivalence
 * contract for the later verdict-interface work.
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

function createMockCtx(options?: {
	mode?: string;
	sessionFile?: string | undefined;
}): ExtensionEventContext {
	// An explicitly passed `undefined` must stay undefined: it is the condition the
	// ephemeral-headless-child guard names.
	const sessionFile =
		options && "sessionFile" in options
			? options.sessionFile
			: "/tmp/session.jsonl";
	return {
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
			getSessionFile: vi.fn(() => sessionFile),
			getSessionId: vi.fn(() => "test-session"),
			getLeafId: vi.fn(() => "test-leaf"),
			getBranch: vi.fn(() => []),
			buildSessionProjection: vi.fn(() => ({ messages: [] })),
		},
	} as unknown as ExtensionEventContext;
}

function createCoordinator(options?: {
	disableAutoCompaction?: boolean;
	usage?: EffectiveUsage | null;
	thresholdSettings?: CompactPlusThresholdSettings;
}) {
	const state = new CompactionState();
	const usage: EffectiveUsage | null =
		options?.usage === undefined ? HIGH_USAGE : options.usage;
	const coordinator = new CompactionCoordinator({
		state,
		pi: { sendUserMessage: vi.fn() } as never,
		thresholdSettings: options?.thresholdSettings ?? {
			...DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
			thresholdMode: "percent",
		},
		getEffectiveUsage: () => usage,
		persistTelemetrySnapshot: vi.fn(),
		disableAutoCompaction: options?.disableAutoCompaction ?? false,
	});
	return { coordinator, state };
}

/** Every declined arm must leave no Pi compaction request and no user notice. */
function expectDeclined(ctx: ExtensionEventContext, state: CompactionState) {
	expect(ctx.compact).not.toHaveBeenCalled();
	expect(ctx.ui.notify).not.toHaveBeenCalled();
	// Interim equivalence contract: today's state shape, pinned only so the later
	// interface change can prove equivalence.
	expect(state.isCompacting).toBe(false);
	expect(state.selectedMode).toBeNull();
	expect(state.lastTriggerAuto).toBe(false);
}

describe("CompactionCoordinator.maybeAutoCompact declined guard arms", () => {
	it("declines when no usage can be resolved", async () => {
		const { coordinator, state } = createCoordinator({ usage: null });
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expectDeclined(ctx, state);
	});

	it("declines when the session has no model", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx();
		ctx.model = undefined;

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expectDeclined(ctx, state);
	});

	it("declines when neither usage metric is available", async () => {
		const { coordinator, state } = createCoordinator({
			usage: {
				percent: null,
				tokens: null,
				contextWindow: 200_000,
				source: "estimated",
			},
		});
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		// Characterized as aggregate no-metrics behaviour: deleting the explicit
		// `percent === null && tokens === null` guard leaves the outcome externally
		// identical, because `getModeFromEffectiveUsage` then returns null and the
		// following `!mode` guard declines for the same caller-visible reason. Only the
		// aggregate contract is observable from outside the method.
		expectDeclined(ctx, state);
	});

	it("declines in the checkpoint band and never auto-compacts a checkpoint candidate", async () => {
		const { coordinator, state } = createCoordinator({
			usage: {
				percent: 66,
				tokens: 132_000,
				contextWindow: 200_000,
				source: "native",
			},
		});
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expectDeclined(ctx, state);
	});

	it("declines below the standard band", async () => {
		const { coordinator, state } = createCoordinator({
			usage: {
				percent: 40,
				tokens: 80_000,
				contextWindow: 200_000,
				source: "native",
			},
		});
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expectDeclined(ctx, state);
	});

	it("declines while the cooldown window is still open", async () => {
		const { coordinator, state } = createCoordinator();
		state.lastCompactTime = Date.now();
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expectDeclined(ctx, state);
	});

	it("declines when token regrowth since the last compaction is below the threshold", async () => {
		const { coordinator, state } = createCoordinator();
		state.lastCompactTokens = HIGH_TOKENS - (REGROWTH_TOKENS - 1);
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expectDeclined(ctx, state);
	});

	it("relies on the cooldown guard alone when regrowth cannot be measured", async () => {
		const { coordinator, state } = createCoordinator({
			usage: {
				percent: 80,
				tokens: null,
				contextWindow: 200_000,
				source: "native",
			},
		});
		state.lastCompactTokens = 1;
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(ctx.compact).toHaveBeenCalledOnce();
		expect(state.isCompacting).toBe(true);
	});

	it("declines when a compaction is already in flight", async () => {
		const { coordinator, state } = createCoordinator();
		state.isCompacting = true;
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		// Mutation-sensitive: deleting the guard would reach the accepted path and ask
		// Pi to compact, so the absent request is the oracle, not the preset flag.
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(state.isCompacting).toBe(true);
		expect(state.selectedMode).toBeNull();
		expect(state.lastTriggerAuto).toBe(false);
		expect(state.lastCompactTurnIndex).toBe(-1);
	});

	it("declines while the tool-output pruning flush is in progress", async () => {
		const { coordinator, state } = createCoordinator();
		state.toolOutputPruning.isFlushing = true;
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expectDeclined(ctx, state);
	});

	it("declines a second trigger inside the same turn", async () => {
		const { coordinator, state } = createCoordinator();
		state.lastCompactTurnIndex = 7;
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 7);

		expectDeclined(ctx, state);
	});

	it("declines when the kill switch is set, before any other guard runs", async () => {
		const { coordinator, state } = createCoordinator({
			disableAutoCompaction: true,
		});
		// Kept on a normal persisted session so the ephemeral-child guard cannot mask
		// the kill switch.
		const ctx = createMockCtx();
		expect(ctx.sessionManager.getSessionFile()).toBe("/tmp/session.jsonl");

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expectDeclined(ctx, state);
	});

	it("declines in an ephemeral headless child with no session file", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx({ mode: "json", sessionFile: undefined });
		expect(ctx.sessionManager.getSessionFile()).toBeUndefined();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expectDeclined(ctx, state);
	});
});

describe("CompactionCoordinator.maybeAutoCompact accepted path", () => {
	it("triggers when every guard passes, notifies with the measured usage, and asks Pi to compact", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx();

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(ctx.compact).toHaveBeenCalledOnce();
		const notices = vi.mocked(ctx.ui.notify).mock.calls.map(([text]) => text);
		expect(notices).toHaveLength(1);
		// The notice is today's only caller-visible verdict for an accepted auto trigger:
		// it must name the measured usage, the mode chosen and the trigger source.
		expect(notices[0]).toContain("Compact+ auto-compaction triggered at 80%");
		expect(notices[0]).toContain("(160,000 / 200,000 tokens)");
		expect(notices[0]).toContain("mode: standard");
		expect(notices[0]).toContain("thresholdMode: percent");
		expect(notices[0]).toContain("(turn_end)");
		const request = vi.mocked(ctx.compact).mock.calls[0][0] as {
			customInstructions?: string;
		};
		expect(typeof request.customInstructions).toBe("string");
		expect(request.customInstructions?.trim().length).toBeGreaterThan(0);
		expect(state.lastIssuedCompactionInstructions).toBe(
			request.customInstructions,
		);
		expect(state.isCompacting).toBe(true);
		expect(state.selectedMode).toBe("standard");
		expect(state.lastTriggerAuto).toBe(true);
		expect(state.lastCompactTurnIndex).toBe(1);
	});
});
