import { describe, expect, it, vi } from "vitest";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import type { EffectiveUsage } from "../src/types.js";

type ExtensionEventContext = Parameters<
	Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["on"]>[1]
>[1];

const HIGH_USAGE: EffectiveUsage = {
	percent: 80,
	tokens: 160_000,
	contextWindow: 200_000,
	source: "native",
};

function createMockCtx(options?: {
	mode?: string;
	sessionFile?: string | undefined;
}): ExtensionEventContext {
	return {
		mode: (options?.mode ?? "tui") as ExtensionEventContext["mode"],
		hasUI: true,
		ui: { notify: vi.fn() },
		compact: vi.fn(),
		model: { provider: "test", id: "model", contextWindow: 200_000 },
		getContextUsage: vi.fn(() => ({
			tokens: 160_000,
			contextWindow: 200_000,
			percent: 80,
		})),
		sessionManager: {
			getSessionFile: vi.fn(() => options?.sessionFile),
			getBranch: vi.fn(() => []),
		},
	} as unknown as ExtensionEventContext;
}

function createMockPi() {
	return { sendUserMessage: vi.fn() } as never;
}

function createCoordinator(options?: {
	disableAutoCompaction?: boolean;
	state?: CompactionState;
}) {
	const state = options?.state ?? new CompactionState();
	const coordinator = new CompactionCoordinator({
		state,
		pi: createMockPi(),
		thresholdSettings: {
			...DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
			thresholdMode: "percent",
		},
		getEffectiveUsage: () => HIGH_USAGE,
		persistTelemetrySnapshot: vi.fn(),
		disableAutoCompaction: options?.disableAutoCompaction ?? false,
	});
	return { coordinator, state };
}

describe("CompactionCoordinator.maybeAutoCompact runtime guards", () => {
	it("skips auto-compaction in an ephemeral json child with no session file", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx({ mode: "json", sessionFile: undefined });

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.isCompacting).toBe(false);
	});

	it("auto-compacts in json mode when a session file exists", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx({
			mode: "json",
			sessionFile: "/tmp/session.jsonl",
		});

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(ctx.compact).toHaveBeenCalledOnce();
		expect(state.isCompacting).toBe(true);
	});

	it("auto-compacts in a normal tui session", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx({
			mode: "tui",
			sessionFile: "/tmp/session.jsonl",
		});

		await coordinator.maybeAutoCompact(ctx, "message_end");

		expect(ctx.compact).toHaveBeenCalledOnce();
		expect(state.isCompacting).toBe(true);
	});

	it("skips auto-compaction when the kill switch is enabled", async () => {
		const { coordinator, state } = createCoordinator({
			disableAutoCompaction: true,
		});
		const ctx = createMockCtx({
			mode: "tui",
			sessionFile: "/tmp/session.jsonl",
		});

		await coordinator.maybeAutoCompact(ctx, "message_end");

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.isCompacting).toBe(false);
	});

	it("still allows manual compaction in an ephemeral json child", async () => {
		const { coordinator } = createCoordinator();
		const ctx = createMockCtx({ mode: "json", sessionFile: undefined });

		await coordinator.handleManualCommand("standard", ctx);

		expect(ctx.compact).toHaveBeenCalledOnce();
	});
});
