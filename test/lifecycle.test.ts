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

	it("preserves existing lastCompactTokens when getContextUsage returns no tokens", () => {
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

		expect(state.lastCompactTokens).toBe(42000);
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
