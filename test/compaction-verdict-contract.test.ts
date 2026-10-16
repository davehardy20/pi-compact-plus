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
import type { EffectiveUsage } from "../src/types.js";

/**
 * Characterization tests for the compaction verdict contract
 * (`onSessionBeforeCompact` and `onSessionCompact`, src/compaction-coordinator.ts).
 * Each verdict is asserted as the typed verdict the coordinator records, because the
 * return value says only `cancel`, `compaction` or nothing, and the attempt flags are
 * asserted separately because the verdict does not describe them.
 *
 * Scope is deliberately the five verdict reasons no other suite names at this
 * interface: `custom compaction cancelled`, `custom summarization unavailable`,
 * `compaction context changed`, `compaction aborted`, and the compatibility
 * deferral reason. Overflow, output-cap and suspect-estimate verdicts are already
 * pinned at greater depth, with a real SessionManager and real SDK measurement, by
 * test/compaction-overflow-recovery.test.ts, and are not restated here with mocks.
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
		// A cancel is silent today: no Pi compaction request and no user notice, only the
		// reason in shared state.
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(notices(ctx)).toHaveLength(0);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "cancelled",
			reason: "custom compaction cancelled",
		});
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
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(
			notices(ctx).some((text) =>
				text.includes(
					"Compact+ custom summarization unavailable; falling back to default compaction.",
				),
			),
		).toBe(true);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason: "custom summarization unavailable",
		});
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
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(notices(ctx)).toHaveLength(0);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "cancelled",
			reason: "compaction context changed",
		});
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
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(notices(ctx)).toHaveLength(0);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "cancelled",
			reason: "compaction aborted",
		});
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
		expect(ctx.compact).not.toHaveBeenCalled();
		expect(
			notices(ctx).some((text) =>
				text.includes("deferring to native Pi compaction"),
			),
		).toBe(true);
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "deferred",
			reason: NATIVE_FALLBACK_REASON,
		});
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
		expect(state.isCompacting).toBe(false);
	});
});
