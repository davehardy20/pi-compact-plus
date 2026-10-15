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
import type { CompactionVerdict } from "../src/compaction-verdict.js";
import { NATIVE_FALLBACK_REASON } from "../src/compatibility.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import type { EffectiveUsage } from "../src/types.js";

/**
 * Interface contract for the typed compaction verdict.
 *
 * Two guarantees are pinned here. First: what Pi sees is unchanged. The Pi-owned
 * handlers still return exactly `undefined | { cancel: true } | { compaction }` for
 * `session_before_compact` and `BoundaryResult | undefined` for `turn_end`, and the
 * verdict travels only through `getLastVerdict()`. Second: the Compact+-owned entry
 * points return the verdict that call recorded, and return null when it recorded
 * none, so a caller can never mistake an earlier decision for this one's.
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

afterEach(() => {
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

describe("Compact+-owned entry points return their own verdict", () => {
	it("returns null when the trigger stopped at a guard that records no reason", async () => {
		const ctx = createCtx();
		const { coordinator } = createCoordinator({ usage: null });

		const verdict = await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(verdict).toBeNull();
		expect(coordinator.getLastVerdict()).toBeNull();
	});

	it("returns null when a manual command is refused before any decision", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.isCompacting = true;

		const verdict = await coordinator.handleManualCommand("standard", ctx);

		expect(verdict).toBeNull();
		expect(coordinator.getLastVerdict()).toBeNull();
	});

	it("does not report an earlier decision as this call's verdict", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({ cancel: true });
		await beforeCompact(ctx, coordinator);
		const recorded = coordinator.getLastVerdict() as CompactionVerdict;
		expect(recorded.kind).toBe("cancelled");

		const verdict = await coordinator.maybeAutoCompact(ctx, "turn_end", 9);

		expect(verdict).toBeNull();
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
		runCustom.mockResolvedValue({ cancel: true });
		await beforeCompact(ctx, coordinator);
		state.selectedMode = "standard";

		state.resetOnModelChange("other-model");

		expect(coordinator.getLastVerdict()).toBeNull();
	});
});

describe("verdict travels with the compaction it describes", () => {
	it("records a completed compaction with no reason", async () => {
		const ctx = createCtx();
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		runCustom.mockResolvedValue({
			result: SUMMARY,
			classifiedCounts: { totalMessages: 2 },
		});

		const result = await beforeCompact(ctx, coordinator);

		expect(result).toMatchObject({ compaction: expect.anything() });
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "completed",
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

		expect(result).toMatchObject({ compaction: expect.anything() });
		expect(coordinator.getLastVerdict()).toMatchObject({
			kind: "trimmed",
			reason: "intent evidence was trimmed to fit the summary request",
			evidenceTrimmedTurns: 3,
		});
	});
});
