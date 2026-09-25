import { describe, expect, it, vi } from "vitest";
import { executeCompaction } from "../src/lifecycle.js";
import { CompactionState } from "../src/state.js";

interface MockCtx {
	hasUI: boolean;
	compact: ReturnType<typeof vi.fn>;
	getContextUsage: ReturnType<typeof vi.fn>;
	ui: {
		notify: ReturnType<typeof vi.fn>;
	};
}

interface MockPi {
	sendUserMessage: ReturnType<typeof vi.fn>;
}

function createMockCtx(options?: {
	contextUsage?: { tokens: number | null; percent: number | null } | undefined;
}): MockCtx {
	return {
		hasUI: true,
		compact: vi.fn(),
		getContextUsage: vi.fn(() =>
			options && "contextUsage" in options
				? options.contextUsage
				: { tokens: 50000, percent: 50 },
		),
		ui: {
			notify: vi.fn(),
		},
	};
}

function createMockPi(): MockPi {
	return {
		sendUserMessage: vi.fn(),
	};
}

describe("executeCompaction", () => {
	it("calls persist callback in onComplete with post-compaction tokens", () => {
		const state = new CompactionState();
		const persist = vi.fn();
		const ctx = createMockCtx({ contextUsage: { tokens: 42000, percent: 42 } });
		const pi = createMockPi();

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onComplete }: { onComplete?: () => void }) => {
				if (onComplete) onComplete();
			},
		);

		executeCompaction(
			"standard",
			{
				objective: "test",
				blockers: [],
				decisions: [],
				activeFiles: [],
				dependencyChain: [],
			},
			state,
			ctx as unknown as Parameters<typeof executeCompaction>[3],
			pi as unknown as Parameters<typeof executeCompaction>[4],
			{ sendContinuation: false, persist },
		);

		expect(state.lastCompactTokens).toBe(42000);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("uses Pi's completion estimate when post-compaction usage is unavailable", () => {
		const state = new CompactionState();
		const ctx = createMockCtx({ contextUsage: undefined });
		const pi = createMockPi();
		ctx.compact.mockImplementation(
			({ onComplete }: { onComplete: (result: unknown) => void }) => {
				onComplete({ estimatedTokensAfter: 42_000 });
			},
		);

		executeCompaction(
			"standard",
			{
				objective: "test",
				blockers: [],
				decisions: [],
				activeFiles: [],
				dependencyChain: [],
			},
			state,
			ctx as unknown as Parameters<typeof executeCompaction>[3],
			pi as unknown as Parameters<typeof executeCompaction>[4],
		);

		expect(state.lastCompactTokens).toBe(42_000);
		expect(state.isRegrowthBelowThreshold(42_999, 1_000)).toBe(true);
		expect(state.isRegrowthBelowThreshold(43_000, 1_000)).toBe(false);
		state.resetOnModelChange("old-model");
		state.resetOnModelChange("new-model");
		expect(state.lastCompactTokens).toBe(0);
	});

	it.each([undefined, null, -1, 0, 42.5, Number.NaN, Infinity])(
		"rejects an invalid completion estimate %s for regrowth",
		(estimate) => {
			const state = new CompactionState();
			state.lastCompactTokens = 80_000;
			const ctx = createMockCtx({ contextUsage: undefined });
			ctx.compact.mockImplementation(
				({ onComplete }: { onComplete: (result: unknown) => void }) => {
					onComplete({ estimatedTokensAfter: estimate });
				},
			);
			executeCompaction(
				"standard",
				{
					objective: "test",
					blockers: [],
					decisions: [],
					activeFiles: [],
					dependencyChain: [],
				},
				state,
				ctx as unknown as Parameters<typeof executeCompaction>[3],
				createMockPi() as unknown as Parameters<typeof executeCompaction>[4],
			);
			expect(state.lastCompactTokens).toBe(0);
		},
	);

	it("leaves lastCompactTokens at default 0 when getContextUsage returns no tokens for fresh state", () => {
		const state = new CompactionState();
		const persist = vi.fn();
		const ctx = createMockCtx({ contextUsage: undefined });
		const pi = createMockPi();

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onComplete }: { onComplete?: () => void }) => {
				if (onComplete) onComplete();
			},
		);

		executeCompaction(
			"standard",
			{
				objective: "test",
				blockers: [],
				decisions: [],
				activeFiles: [],
				dependencyChain: [],
			},
			state,
			ctx as unknown as Parameters<typeof executeCompaction>[3],
			pi as unknown as Parameters<typeof executeCompaction>[4],
			{ sendContinuation: false, persist },
		);

		expect(state.lastCompactTokens).toBe(0);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("clears stale regrowth baseline when completion has no valid estimate", () => {
		const state = new CompactionState();
		state.lastCompactTokens = 42000;
		const persist = vi.fn();
		const ctx = createMockCtx({ contextUsage: undefined });
		const pi = createMockPi();

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onComplete }: { onComplete?: () => void }) => {
				if (onComplete) onComplete();
			},
		);

		executeCompaction(
			"standard",
			{
				objective: "test",
				blockers: [],
				decisions: [],
				activeFiles: [],
				dependencyChain: [],
			},
			state,
			ctx as unknown as Parameters<typeof executeCompaction>[3],
			pi as unknown as Parameters<typeof executeCompaction>[4],
			{ sendContinuation: false, persist },
		);

		expect(state.lastCompactTokens).toBe(0);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("calls persist callback in onError with lastCompactTokens reset to 0", () => {
		const state = new CompactionState();
		state.lastCompactTokens = 99999;
		const persist = vi.fn();
		const ctx = createMockCtx();
		const pi = createMockPi();

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onError }: { onError?: (error: Error) => void }) => {
				if (onError) onError(new Error("test error"));
			},
		);

		executeCompaction(
			"hard",
			{
				objective: "test",
				blockers: [],
				decisions: [],
				activeFiles: [],
				dependencyChain: [],
			},
			state,
			ctx as unknown as Parameters<typeof executeCompaction>[3],
			pi as unknown as Parameters<typeof executeCompaction>[4],
			{ sendContinuation: false, persist },
		);

		expect(state.lastCompactTokens).toBe(0);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("sends continuation prompt when sendContinuation is true", () => {
		const state = new CompactionState();
		const persist = vi.fn();
		const ctx = createMockCtx();
		const pi = createMockPi();

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onComplete }: { onComplete?: () => void }) => {
				if (onComplete) onComplete();
			},
		);

		executeCompaction(
			"standard",
			{
				objective: "test",
				blockers: [],
				decisions: [],
				activeFiles: [],
				dependencyChain: [],
			},
			state,
			ctx as unknown as Parameters<typeof executeCompaction>[3],
			pi as unknown as Parameters<typeof executeCompaction>[4],
			{ sendContinuation: true, persist },
		);

		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"Continue with the current task.",
			{ deliverAs: "followUp" },
		);
	});

	it("uses lastCompaction timestamp for lastCompactTime when available", () => {
		const state = new CompactionState();
		const pastTimestamp = Date.now() - 60_000;
		state.lastCompaction = {
			mode: "standard",
			triggerSource: "command",
			triggerReason: "manual",
			timestamp: pastTimestamp,
			focusTags: [],
			previousSummaryPresent: false,
			splitTurn: false,
			usageSource: "native",
			messagesSummarizedCount: 0,
			executionPath: "custom",
			fromExtension: true,
		};
		const persist = vi.fn();
		const ctx = createMockCtx();
		const pi = createMockPi();

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onComplete }: { onComplete?: () => void }) => {
				if (onComplete) onComplete();
			},
		);

		executeCompaction(
			"standard",
			{
				objective: "test",
				blockers: [],
				decisions: [],
				activeFiles: [],
				dependencyChain: [],
			},
			state,
			ctx as unknown as Parameters<typeof executeCompaction>[3],
			pi as unknown as Parameters<typeof executeCompaction>[4],
			{ sendContinuation: false, persist },
		);

		expect(state.lastCompactTime).toBe(pastTimestamp);
	});

	it("notifies error via UI when onError fires and hasUI is true", () => {
		const state = new CompactionState();
		const persist = vi.fn();
		const ctx = createMockCtx();
		const pi = createMockPi();

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onError }: { onError?: (error: Error) => void }) => {
				if (onError) onError(new Error("compaction crashed"));
			},
		);

		executeCompaction(
			"hard",
			{
				objective: "test",
				blockers: [],
				decisions: [],
				activeFiles: [],
				dependencyChain: [],
			},
			state,
			ctx as unknown as Parameters<typeof executeCompaction>[3],
			pi as unknown as Parameters<typeof executeCompaction>[4],
			{ sendContinuation: false, persist },
		);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("compaction crashed"),
			"error",
		);
	});
});

const STALE_TEST_FOCUS = {
	objective: "test",
	blockers: [],
	decisions: [],
	activeFiles: [],
	dependencyChain: [],
};

function staleExtensionCtxError(): Error {
	return new Error(
		"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
	);
}

describe("executeCompaction stale extension context handling", () => {
	it.each(["onComplete", "onError"] as const)(
		"ignores %s from a previous session after state reset",
		(callbackName) => {
			const state = new CompactionState();
			const persist = vi.fn();
			const ctx = createMockCtx();
			const pi = createMockPi();
			executeCompaction(
				"standard",
				STALE_TEST_FOCUS,
				state,
				ctx as unknown as Parameters<typeof executeCompaction>[3],
				pi as unknown as Parameters<typeof executeCompaction>[4],
				{ sendContinuation: true, persist },
			);
			state.reset();
			state.lastCompactTime = 123;
			state.lastCompactTokens = 456;
			const callbacks = ctx.compact.mock.calls[0]?.[0];
			if (!callbacks) throw new Error("compaction callbacks missing");
			if (callbackName === "onComplete") {
				callbacks.onComplete({ estimatedTokensAfter: 42_000 });
			} else {
				callbacks.onError(new Error("old session failed"));
			}
			expect(state.lastCompactTime).toBe(123);
			expect(state.lastCompactTokens).toBe(456);
			expect(persist).not.toHaveBeenCalled();
			expect(pi.sendUserMessage).not.toHaveBeenCalled();
			expect(ctx.ui.notify).not.toHaveBeenCalled();
		},
	);

	it("keeps state consistent when onComplete observes a stale extension context", () => {
		const state = new CompactionState();
		const persist = vi.fn();
		const ctx = createMockCtx();
		const pi = createMockPi();

		Object.defineProperty(ctx, "getContextUsage", {
			get() {
				throw staleExtensionCtxError();
			},
		});

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onComplete }: { onComplete?: () => void }) => {
				if (onComplete) onComplete();
			},
		);

		expect(() =>
			executeCompaction(
				"standard",
				STALE_TEST_FOCUS,
				state,
				ctx as unknown as Parameters<typeof executeCompaction>[3],
				pi as unknown as Parameters<typeof executeCompaction>[4],
				{ sendContinuation: true, persist },
			),
		).not.toThrow();

		expect(state.isCompacting).toBe(false);
		expect(state.selectedMode).toBeNull();
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("does not throw when onError observes a stale extension context", () => {
		const state = new CompactionState();
		const persist = vi.fn();
		const ctx = createMockCtx();
		const pi = createMockPi();

		Object.defineProperty(ctx, "hasUI", {
			get() {
				throw staleExtensionCtxError();
			},
		});

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onError }: { onError?: (error: Error) => void }) => {
				if (onError) onError(new Error("compaction crashed"));
			},
		);

		expect(() =>
			executeCompaction(
				"hard",
				STALE_TEST_FOCUS,
				state,
				ctx as unknown as Parameters<typeof executeCompaction>[3],
				pi as unknown as Parameters<typeof executeCompaction>[4],
				{ sendContinuation: false, persist },
			),
		).not.toThrow();

		expect(state.isCompacting).toBe(false);
		expect(state.selectedMode).toBeNull();
		expect(state.lastCompactTokens).toBe(0);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("skips the continuation prompt when sendUserMessage observes a stale extension api", () => {
		const state = new CompactionState();
		const persist = vi.fn();
		const ctx = createMockCtx();
		const pi = createMockPi();

		pi.sendUserMessage.mockImplementation(() => {
			throw staleExtensionCtxError();
		});

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onComplete }: { onComplete?: () => void }) => {
				if (onComplete) onComplete();
			},
		);

		expect(() =>
			executeCompaction(
				"standard",
				STALE_TEST_FOCUS,
				state,
				ctx as unknown as Parameters<typeof executeCompaction>[3],
				pi as unknown as Parameters<typeof executeCompaction>[4],
				{ sendContinuation: true, persist },
			),
		).not.toThrow();

		expect(state.isCompacting).toBe(false);
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("propagates non-stale getContextUsage errors from onComplete", () => {
		const state = new CompactionState();
		const persist = vi.fn();
		const ctx = createMockCtx();
		const pi = createMockPi();

		Object.defineProperty(ctx, "getContextUsage", {
			get() {
				throw new Error("usage broke");
			},
		});

		(ctx.compact as ReturnType<typeof vi.fn>).mockImplementation(
			({ onComplete }: { onComplete?: () => void }) => {
				if (onComplete) onComplete();
			},
		);

		expect(() =>
			executeCompaction(
				"standard",
				STALE_TEST_FOCUS,
				state,
				ctx as unknown as Parameters<typeof executeCompaction>[3],
				pi as unknown as Parameters<typeof executeCompaction>[4],
				{ sendContinuation: false, persist },
			),
		).toThrow("usage broke");
	});
});
