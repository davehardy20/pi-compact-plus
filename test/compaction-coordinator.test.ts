import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import {
	type CompactPlusThresholdSettings,
	DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
} from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import type { EffectiveUsage } from "../src/types.js";

const { mutateDuringBudget } = vi.hoisted(() => ({
	mutateDuringBudget: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		generateSummaryWithUsage: (
			...args: Parameters<typeof actual.generateSummaryWithUsage>
		) => {
			mutateDuringBudget();
			return actual.generateSummaryWithUsage(...args);
		},
	};
});

afterEach(() => {
	mutateDuringBudget.mockReset();
	vi.restoreAllMocks();
});

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
	contextWindow?: number;
}): ExtensionEventContext {
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
			contextWindow: options?.contextWindow ?? 200_000,
			api: "openai-completions",
			maxTokens: 4096,
		},
		getContextUsage: vi.fn(() => ({
			tokens: 160_000,
			contextWindow: 200_000,
			percent: 80,
		})),
		sessionManager: {
			getSessionFile: vi.fn(() => options?.sessionFile),
			getSessionId: vi.fn(() => "test-session"),
			getLeafId: vi.fn(() => "test-leaf"),
			getBranch: vi.fn(() => []),
			buildSessionProjection: vi.fn(() => ({ messages: [] })),
		},
	} as unknown as ExtensionEventContext;
}

function createMockPi() {
	return { sendUserMessage: vi.fn() } as never;
}

function createCoordinator(options?: {
	disableAutoCompaction?: boolean;
	state?: CompactionState;
	usage?: EffectiveUsage;
	thresholdSettings?: CompactPlusThresholdSettings;
}) {
	const state = options?.state ?? new CompactionState();
	const coordinator = new CompactionCoordinator({
		state,
		pi: createMockPi(),
		thresholdSettings: options?.thresholdSettings ?? {
			...DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
			thresholdMode: "percent",
		},
		getEffectiveUsage: () => options?.usage ?? HIGH_USAGE,
		persistTelemetrySnapshot: vi.fn(),
		disableAutoCompaction: options?.disableAutoCompaction ?? false,
	});
	return { coordinator, state };
}

function setProjectedUser(ctx: ExtensionEventContext, text: string): void {
	const manager = ctx.sessionManager as unknown as {
		buildSessionProjection: ReturnType<typeof vi.fn>;
	};
	manager.buildSessionProjection.mockReturnValue({
		messages: [{ role: "user", content: [{ type: "text", text }] }],
	});
}

describe("CompactionCoordinator.maybeAutoCompact runtime guards", () => {
	it("clears boundary drafts and issued prompt ownership together", () => {
		const { state } = createCoordinator();
		state.pendingBoundaryMarker = "uncommitted boundary";
		state.lastIssuedCompactionInstructions = "issued prompt";
		state.clearPendingCompaction();
		expect(state.pendingBoundaryMarker).toBeNull();
		expect(state.lastIssuedCompactionInstructions).toBeNull();
	});

	it("skips auto-compaction in an ephemeral json child with no session file", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx({ mode: "json", sessionFile: undefined });

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.isCompacting).toBe(false);
	});

	it("skips auto-compaction in an ephemeral rpc child with no session file", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx({ mode: "rpc", sessionFile: undefined });

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(ctx.compact).not.toHaveBeenCalled();
		expect(state.isCompacting).toBe(false);
	});

	it("skips auto-compaction in an ephemeral print-mode child with no session file", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx({ mode: "print", sessionFile: undefined });

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

	it("auto-compacts at 180k with complete >8 KiB user evidence on a 1M model", async () => {
		const usage: EffectiveUsage = {
			percent: 18.4,
			tokens: 183_988,
			contextWindow: 1_000_000,
			source: "native",
		};
		const { coordinator, state } = createCoordinator({
			usage,
			thresholdSettings: {
				...DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
				thresholdMode: "effective_cap",
				checkpointThresholdTokens: 150_000,
				standardThresholdTokens: 180_000,
				hardThresholdTokens: 240_000,
			},
		});
		const ctx = createMockCtx({
			mode: "tui",
			sessionFile: "/tmp/session.jsonl",
			contextWindow: 1_000_000,
		});
		const note = `Prior context ${"x".repeat(12_000)}\nI'd like to investigate login instead.`;
		setProjectedUser(ctx, note);

		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(ctx.compact).toHaveBeenCalledOnce();
		const instructions = vi.mocked(ctx.compact).mock.calls[0]?.[0]
			?.customInstructions;
		expect(instructions).not.toContain("x".repeat(12_000));
		const result = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					isSplitTurn: false,
					messagesToSummarize: [],
					turnPrefixMessages: [],
					settings: {
						enabled: true,
						keepRecentTokens: 100,
						reserveTokens: 4096,
					},
				},
				branchEntries: [],
			} as never,
			ctx,
		);
		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
	});

	it("starts manual compaction near full context without rejecting duplicate user evidence before preparation", async () => {
		const { coordinator } = createCoordinator({
			usage: { ...HIGH_USAGE, tokens: 190_000, percent: 95 },
		});
		const ctx = createMockCtx({ sessionFile: "/tmp/session.jsonl" });
		setProjectedUser(ctx, `Task: repair the issue.\n${"x".repeat(12_000)}`);

		await coordinator.handleManualCommand("standard", ctx);

		expect(ctx.compact).toHaveBeenCalledOnce();
	});

	it("accepts large user evidence already included in the summary transcript", async () => {
		const { coordinator, state } = createCoordinator({
			usage: { ...HIGH_USAGE, tokens: 190_000, percent: 95 },
		});
		state.selectedMode = "standard";
		const ctx = createMockCtx({ sessionFile: "/tmp/session.jsonl" });
		const text = `Task: repair the issue.\n${"x".repeat(12_000)}`;
		setProjectedUser(ctx, text);

		const result = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					isSplitTurn: false,
					messagesToSummarize: [
						{ role: "user", content: [{ type: "text", text }] },
					],
					turnPrefixMessages: [],
					settings: {
						enabled: true,
						keepRecentTokens: 100,
						reserveTokens: 4096,
					},
				},
				branchEntries: [],
			} as never,
			ctx,
		);

		expect(result).not.toEqual({ cancel: true });
		expect(state.lastFallbackReason).not.toContain("intent evidence exceeds");
	});

	it("defers evidence budgeting until Pi supplies the actual preparation", async () => {
		const { coordinator, state } = createCoordinator();
		const ctx = createMockCtx({
			mode: "tui",
			sessionFile: "/tmp/session.jsonl",
		});
		setProjectedUser(ctx, `Task: ${"x".repeat(9_000)}`);

		await coordinator.handleManualCommand("standard", ctx);
		await coordinator.maybeAutoCompact(ctx, "turn_end", 1);

		expect(ctx.compact).toHaveBeenCalledOnce();
		expect(state.isCompacting).toBe(true);
		expect(state.selectedMode).toBe("standard");
	});

	it("cancels a compaction if omitted evidence exceeds the actual request budget", async () => {
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		const ctx = createMockCtx({
			mode: "tui",
			sessionFile: "/tmp/session.jsonl",
			contextWindow: 64_000,
		});
		Object.defineProperty(ctx, "modelRegistry", {
			value: { streamSimple: vi.fn() },
		});
		setProjectedUser(ctx, `Task: ${"x".repeat(300_000)}`);
		const result = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					isSplitTurn: false,
					messagesToSummarize: [],
					turnPrefixMessages: [],
					settings: {
						enabled: true,
						keepRecentTokens: 100,
						reserveTokens: 4096,
					},
				},
				branchEntries: [],
			} as never,
			ctx,
		);

		expect(result).toEqual({ cancel: true });
		expect(state.selectedMode).toBeNull();
		expect(state.isCompacting).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("intent evidence exceeds"),
			"warning",
		);
	});

	it.each([
		"queue",
		"session",
		"leaf",
		"model",
		"model capacity",
		"epoch",
		"pruning flush",
	])("cancels %s changes during budgeting before auth", async (kind) => {
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		const ctx = createMockCtx({ sessionFile: "/tmp/session.jsonl" });
		const auth = vi.fn();
		const stream = vi.fn();
		Object.defineProperty(ctx, "modelRegistry", {
			value: { getApiKeyAndHeaders: auth, streamSimple: stream },
		});
		mutateDuringBudget.mockImplementationOnce(() => {
			switch (kind) {
				case "queue":
					vi.spyOn(ctx, "hasPendingMessages").mockReturnValue(true);
					break;
				case "session":
					vi.spyOn(ctx.sessionManager, "getSessionId").mockReturnValue(
						"replacement",
					);
					break;
				case "leaf":
					vi.spyOn(ctx.sessionManager, "getLeafId").mockReturnValue("new-leaf");
					break;
				case "model":
					if (!ctx.model) throw new Error("Missing fixture model");
					ctx.model = { ...ctx.model, id: "replacement" };
					break;
				case "model capacity":
					if (!ctx.model) throw new Error("Missing fixture model");
					ctx.model.maxTokens = 1024;
					break;
				case "epoch":
					state.invalidateCompactionCallbacks();
					state.selectedMode = "hard";
					break;
				case "pruning flush":
					state.toolOutputPruning.isFlushing = true;
					break;
			}
		});
		const result = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					isSplitTurn: false,
					messagesToSummarize: [],
					turnPrefixMessages: [],
					settings: {
						enabled: true,
						keepRecentTokens: 100,
						reserveTokens: 4096,
					},
				},
				branchEntries: [],
			} as never,
			ctx,
		);
		expect(result).toEqual({ cancel: true });
		expect(mutateDuringBudget).toHaveBeenCalledOnce();
		expect(auth).not.toHaveBeenCalled();
		expect(stream).not.toHaveBeenCalled();
		expect(state.lastCompaction).toBeNull();
		expect(state.selectedMode).toBe(kind === "epoch" ? "hard" : null);
	});

	it("waits for idle before manual compaction can interrupt an active run", async () => {
		const { coordinator } = createCoordinator();
		const ctx = createMockCtx({ sessionFile: "/tmp/session.jsonl" });
		let release = () => {};
		const idle = new Promise<void>((resolve) => {
			release = resolve;
		});
		Object.defineProperty(ctx, "waitForIdle", { value: () => idle });
		const command = coordinator.handleManualCommand("standard", ctx);
		expect(ctx.compact).not.toHaveBeenCalled();
		release();
		await command;
		expect(ctx.compact).toHaveBeenCalledOnce();
	});

	it("allows native compatibility fallback even when omitted evidence is oversized", async () => {
		const { coordinator, state } = createCoordinator();
		state.selectedMode = "standard";
		const ctx = createMockCtx({ sessionFile: "/tmp/session.jsonl" });
		setProjectedUser(ctx, "x".repeat(300_000));
		const result = await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					isSplitTurn: false,
					messagesToSummarize: [],
					turnPrefixMessages: [],
					settings: {
						enabled: true,
						keepRecentTokens: 100,
						reserveTokens: 4096,
					},
				},
				branchEntries: [],
			} as never,
			ctx,
		);
		expect(result).toBeUndefined();
		expect(state.pendingCompaction?.executionPath).toBe("native-fallback");
	});

	it("still allows manual compaction in an ephemeral json child", async () => {
		const { coordinator } = createCoordinator();
		const ctx = createMockCtx({ mode: "json", sessionFile: undefined });

		await coordinator.handleManualCommand("standard", ctx);

		expect(ctx.compact).toHaveBeenCalledOnce();
	});
});
