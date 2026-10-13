import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PI_OUTPUT_CAP_FAILURE,
	STRATA_CONTEXT_OVERFLOW,
} from "./fixtures/summarization-errors.js";

const { compactMock } = vi.hoisted(() => ({ compactMock: vi.fn() }));

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

import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import {
	SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
} from "../src/summarization-overflow.js";
import type { EffectiveUsage } from "../src/types.js";

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
	options?: { guardNativeCompaction?: boolean },
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
			tokens: 250_000,
			contextWindow: 262_144,
			source: "native",
		}),
		persistTelemetrySnapshot: vi.fn(),
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
	options?: { prefix?: AgentMessage[]; splitTurn?: boolean },
) {
	return {
		preparation: preparation(messages, options),
		branchEntries: [],
		reason: "threshold",
		willRetry: false,
		signal: ctx.signal ?? new AbortController().signal,
		streamFn: async () => ({ result: async () => ({}) }),
	} as never;
}

afterEach(() => {
	compactMock.mockReset();
	fetchSpy.mockClear();
	vi.restoreAllMocks();
});

describe("CompactionCoordinator summarisation overflow handling", () => {
	it("declines native fallback when the custom request itself overflowed", async () => {
		const state = new CompactionState();
		const ctx = createCtx();
		const coordinator = createCoordinator(state);
		state.selectedMode = "standard";
		compactMock.mockRejectedValueOnce(new Error(STRATA_CONTEXT_OVERFLOW));

		const result = await coordinator.onSessionBeforeCompact(
			event(ctx, [user("Task: repair login.")]),
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.selectedMode).toBeNull();
		expect(state.isCompacting).toBe(false);
		expect(state.pendingCompaction).toBeNull();
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
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
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
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
		expect(state.lastFallbackReason).toBe(
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
		expect(state.lastFallbackReason).toBe(SUMMARIZATION_OUTPUT_CAP_REASON);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("no room for the summary"),
			"warning",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			expect.stringContaining("cannot fit"),
			"warning",
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
		expect(state.lastFallbackReason).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
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
		expect(state.lastFallbackReason).toBeNull();
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
		expect(state.lastFallbackReason).toBeNull();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
