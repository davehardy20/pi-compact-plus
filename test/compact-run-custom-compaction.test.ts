import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { compactMock } = vi.hoisted(() => ({ compactMock: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	compact: compactMock,
}));

import { runCustomCompaction } from "../src/compact.js";
import type { CompactionRuntimeCompatibility } from "../src/compatibility.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

function message(role: string, text: string): AgentMessage {
	return {
		role,
		content: [{ type: "text", text }],
	} as AgentMessage;
}

function toolCall(id: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: {} }],
	} as AgentMessage;
}

function toolResult(id: string, text = "ok"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
	} as AgentMessage;
}

function preparation(options?: {
	messages?: AgentMessage[];
	prefix?: AgentMessage[];
	isSplitTurn?: boolean;
	previousSummary?: string;
}) {
	return {
		isSplitTurn: options?.isSplitTurn ?? false,
		messagesToSummarize: options?.messages ?? [],
		turnPrefixMessages: options?.prefix ?? [],
		previousSummary: options?.previousSummary,
	} as never;
}

function compatibility(
	overrides: Partial<CompactionRuntimeCompatibility> = {},
): CompactionRuntimeCompatibility {
	return {
		executionPath: "custom",
		helperArity: 6,
		helperSupportsThinkingLevel: false,
		helperSupportsStreamFn: false,
		reason: null,
		...overrides,
	};
}

function context(options?: {
	model?: ExtensionContext["model"] | null;
	auth?: unknown;
	signal?: AbortSignal;
}): ExtensionContext {
	return {
		model:
			options && "model" in options
				? options.model
				: ({
						id: "test-model",
						provider: "test",
						contextWindow: 100_000,
					} as never),
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () =>
				options && "auth" in options
					? options.auth
					: {
							ok: true,
							apiKey: ["test", "key"].join("-"),
							headers: { "x-test": "header" },
						},
			),
		},
		signal: options?.signal,
	} as unknown as ExtensionContext;
}

function successfulResult(summary = VALID_STRUCTURED_SUMMARY) {
	return {
		summary,
		firstKeptEntryId: "entry-1",
		tokensBefore: 123,
		details: null,
	};
}

function expectSameMessages(
	actual: AgentMessage[],
	expected: AgentMessage[],
): void {
	expect(actual).toHaveLength(expected.length);
	for (const [index, item] of expected.entries()) {
		expect(actual[index]).toBe(item);
	}
}

describe("runCustomCompaction characterization", () => {
	beforeEach(() => {
		compactMock.mockReset();
		compactMock.mockResolvedValue(successfulResult());
	});

	it("fails closed when the model is unavailable without requesting auth", async () => {
		const ctx = context({ model: null });

		await expect(
			runCustomCompaction(preparation(), "standard", ctx, compatibility()),
		).resolves.toEqual({
			result: undefined,
			fallbackReason: "model unavailable",
		});
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(compactMock).not.toHaveBeenCalled();
	});

	it.each([
		[{ ok: false, error: "denied" }, "auth unavailable: denied"],
		[{ ok: false }, "auth unavailable: unknown"],
	])(
		"reports authentication failures exactly",
		async (auth, fallbackReason) => {
			const ctx = context({ auth });

			await expect(
				runCustomCompaction(preparation(), "standard", ctx, compatibility()),
			).resolves.toEqual({ result: undefined, fallbackReason });
			expect(compactMock).not.toHaveBeenCalled();
		},
	);

	it("passes standard-mode input and the six base helper arguments unchanged", async () => {
		const history = [
			message("user", "Current objective: characterize compaction"),
			message("assistant", "ack retained outside hard mode"),
		];
		const prefix = [message("user", "prefix excluded when this is not split")];
		const prep = preparation({ messages: history, prefix });
		const ctx = context({
			auth: { ok: true, apiKey: undefined, headers: undefined },
		});

		const attempt = await runCustomCompaction(
			prep,
			"standard",
			ctx,
			compatibility(),
		);

		expect(attempt).toEqual({
			result: successfulResult(),
			fallbackReason: null,
			classifiedCounts: { critical: 1, contextual: 0, ephemeral: 1 },
		});
		expect(compactMock).toHaveBeenCalledTimes(1);
		const args = compactMock.mock.calls[0] ?? [];
		expect(args).toHaveLength(6);
		expect(args[0]).not.toBe(prep);
		expect(args[0]).toMatchObject({
			messagesToSummarize: history,
			turnPrefixMessages: prefix,
			previousSummary: undefined,
		});
		expect(args[1]).toBe(ctx.model);
		expect(args[2]).toBe("");
		expect(args[3]).toBeUndefined();
		expect(args[4]).toContain(
			"Objective: Current objective: characterize compaction",
		);
		expect(args[4]).not.toContain("prefix excluded when this is not split");
		expect(args[5]).toBe(ctx.signal);
	});

	it("uses split-turn focus, normalizes previous context, and appends optional helper arguments", async () => {
		const previousSummary = `## Current Objective\n${"old context ".repeat(800)}`;
		const explicitSignal = new AbortController().signal;
		const contextSignal = new AbortController().signal;
		const streamFn = vi.fn();
		const prep = preparation({
			messages: [message("assistant", "ack")],
			prefix: [message("user", "Current objective: prefix objective")],
			isSplitTurn: true,
			previousSummary,
		});

		const attempt = await runCustomCompaction(
			prep,
			"standard",
			context({ signal: contextSignal }),
			compatibility({
				helperArity: 8,
				helperSupportsThinkingLevel: true,
				helperSupportsStreamFn: true,
				thinkingLevel: "minimal",
				streamFn,
			}),
			explicitSignal,
		);

		const args = compactMock.mock.calls[0] ?? [];
		expect(args).toHaveLength(8);
		expect(args[0].previousSummary).not.toBe(previousSummary);
		expect(args[0].previousSummary.length).toBeLessThan(previousSummary.length);
		expect(args[4]).toContain("Objective: Current objective: prefix objective");
		expect(args[4]).toContain(
			"This compaction includes a split turn with 1 prefix message(s).",
		);
		expect(args[4]).toContain(args[0].previousSummary);
		expect(args[5]).toBe(explicitSignal);
		expect(args[6]).toBe("minimal");
		expect(args[7]).toBe(streamFn);
		expect(attempt.classifiedCounts).toEqual({
			critical: 1,
			contextual: 0,
			ephemeral: 1,
		});
	});

	it("appends undefined thinking level when the runtime supports the argument", async () => {
		await runCustomCompaction(
			preparation(),
			"standard",
			context(),
			compatibility({
				helperArity: 7,
				helperSupportsThinkingLevel: true,
				thinkingLevel: undefined,
			}),
		);

		const args = compactMock.mock.calls[0] ?? [];
		expect(args).toHaveLength(7);
		expect(args[6]).toBeUndefined();
	});

	it("hard mode prunes ephemeral history and prefix while restoring tool pairs in original order", async () => {
		const historyEphemeral = message("assistant", "ack");
		const historyContextual = message("assistant", "error details ".repeat(20));
		const call = toolCall("call-1");
		const result = toolResult("call-1");
		const user = message("user", "keep this request");
		const history = [historyEphemeral, historyContextual, call, result, user];
		const prefixEphemeral = message("assistant", "noted");
		const prefixContextual = message(
			"assistant",
			"error prefix details ".repeat(20),
		);
		const prefixCall = toolCall("prefix-call");
		const prefixResult = toolResult("prefix-call");
		const prefixUser = message("user", "keep prefix request");
		const prefix = [
			prefixEphemeral,
			prefixContextual,
			prefixCall,
			prefixResult,
			prefixUser,
		];

		const attempt = await runCustomCompaction(
			preparation({ messages: history, prefix, isSplitTurn: true }),
			"hard",
			context(),
			compatibility(),
		);

		const compactPreparation = compactMock.mock.calls[0]?.[0];
		expectSameMessages(compactPreparation.messagesToSummarize, [
			historyContextual,
			call,
			result,
			user,
		]);
		expectSameMessages(compactPreparation.turnPrefixMessages, [
			prefixContextual,
			prefixCall,
			prefixResult,
			prefixUser,
		]);
		expect(attempt.classifiedCounts).toEqual({
			critical: 2,
			contextual: 1,
			ephemeral: 1,
		});
		expect(compactMock.mock.calls[0]?.[4]).toContain("Hard-mode constraints");
	});

	it("hard mode retains the original split prefix when pruning would empty it", async () => {
		const prefix = [message("assistant", "ack")];

		await runCustomCompaction(
			preparation({ prefix, isSplitTurn: true }),
			"hard",
			context(),
			compatibility(),
		);

		expectSameMessages(
			compactMock.mock.calls[0]?.[0].turnPrefixMessages,
			prefix,
		);
	});

	it("hard mode does not inspect a non-split prefix", async () => {
		const prefix = [
			message("assistant", "error prefix context ".repeat(20)),
			message("user", "prefix user"),
		];
		await runCustomCompaction(
			preparation({ prefix, isSplitTurn: false }),
			"hard",
			context(),
			compatibility(),
		);

		expect(compactMock.mock.calls[0]?.[0].turnPrefixMessages).toBe(prefix);
	});

	it("treats a missing turn prefix as zero messages", async () => {
		const prep = preparation() as unknown as {
			turnPrefixMessages?: AgentMessage[];
		};
		delete prep.turnPrefixMessages;

		await runCustomCompaction(
			prep as never,
			"standard",
			context(),
			compatibility(),
		);

		expect(compactMock.mock.calls[0]?.[4]).not.toContain(
			"This compaction includes a split turn",
		);
	});

	it("reports undefined and invalid helper results with classified counts", async () => {
		const prep = preparation({ messages: [message("user", "request")] });
		compactMock.mockResolvedValueOnce(undefined);
		await expect(
			runCustomCompaction(prep, "standard", context(), compatibility()),
		).resolves.toEqual({
			result: undefined,
			fallbackReason: "compact returned undefined",
			classifiedCounts: { critical: 1, contextual: 0, ephemeral: 0 },
		});

		compactMock.mockResolvedValueOnce(successfulResult(""));
		await expect(
			runCustomCompaction(prep, "standard", context(), compatibility()),
		).resolves.toEqual({
			result: undefined,
			fallbackReason: "compaction summary invalid: summary is empty",
			classifiedCounts: { critical: 1, contextual: 0, ephemeral: 0 },
		});

		compactMock.mockResolvedValueOnce(successfulResult("x".repeat(101)));
		const invalid = await runCustomCompaction(
			prep,
			"standard",
			context(),
			compatibility(),
		);
		expect(invalid.result).toBeUndefined();
		expect(invalid.fallbackReason).toMatch(/^compaction summary invalid:/);
	});

	it.each([
		"OK",
		"Compaction Summary — Compact+ memory\n\n## Current Objective\nObjective\n\n## Next Best Step\nGo",
		VALID_STRUCTURED_SUMMARY.replace(
			"## Current Task State",
			"## Other Heading",
		),
		VALID_STRUCTURED_SUMMARY.replace("Finish the current repair.", "   "),
		VALID_STRUCTURED_SUMMARY.replace(
			"## Current Errors",
			"## Current Objective",
		),
		VALID_STRUCTURED_SUMMARY.replace("Run focused validation.", " "),
		`\`\`\`md\n${VALID_STRUCTURED_SUMMARY}\n\`\`\``,
	])(
		"rejects malformed structured summary %s before committing",
		async (summary) => {
			compactMock.mockResolvedValueOnce(successfulResult(summary));
			const attempt = await runCustomCompaction(
				preparation(),
				"standard",
				context(),
				compatibility(),
			);
			expect(attempt.result).toBeUndefined();
			expect(attempt.fallbackReason).toMatch(/^compaction summary invalid:/);
		},
	);

	it("rejects a critical section containing only a fenced example", async () => {
		compactMock.mockResolvedValueOnce(
			successfulResult(
				VALID_STRUCTURED_SUMMARY.replace(
					"Finish the current repair.",
					"```md\nAn example, not the current objective.\n```",
				),
			),
		);
		const attempt = await runCustomCompaction(
			preparation(),
			"standard",
			context(),
			compatibility(),
		);
		expect(attempt.result).toBeUndefined();
		expect(attempt.fallbackReason).toContain(
			"empty critical section: ## Current Objective",
		);
	});

	it("rejects an unbounded raw summary before normalization", async () => {
		compactMock.mockResolvedValueOnce(
			successfulResult(
				VALID_STRUCTURED_SUMMARY.replace(
					"Finish the current repair.",
					"x".repeat(128_001),
				),
			),
		);
		const attempt = await runCustomCompaction(
			preparation(),
			"standard",
			context(),
			compatibility(),
		);
		expect(attempt.result).toBeUndefined();
		expect(attempt.fallbackReason).toContain("raw summary too large");
	});

	it("accepts the full canonical schema with explicit None markers", async () => {
		const attempt = await runCustomCompaction(
			preparation(),
			"standard",
			context(),
			compatibility(),
		);
		expect(attempt.result?.summary).toBe(VALID_STRUCTURED_SUMMARY);
		expect(attempt.fallbackReason).toBeNull();
	});

	it("normalizes an oversized valid result while retaining result metadata", async () => {
		const summary = [
			VALID_STRUCTURED_SUMMARY,
			...Array.from(
				{ length: 500 },
				(_, index) => `- objective ${index} ${"x".repeat(50)}`,
			),
		].join("\n");
		compactMock.mockResolvedValueOnce({
			...successfulResult(summary),
			details: { marker: "retained" },
		});

		const attempt = await runCustomCompaction(
			preparation(),
			"standard",
			context(),
			compatibility(),
		);

		expect(attempt.fallbackReason).toBeNull();
		expect(attempt.result).toMatchObject({
			firstKeptEntryId: "entry-1",
			tokensBefore: 123,
			details: { marker: "retained" },
		});
		expect(attempt.result?.summary).not.toBe(summary);
		expect(attempt.result?.summary.length).toBeLessThan(summary.length);
		expect(attempt.result?.summary).toContain("## Current Objective");
		expect(attempt.result?.summary).toContain("## Active File Set");
		expect(attempt.result?.summary).toMatch(
			/^Compaction Summary — Compact\+ memory\n/,
		);
		expect(attempt.result?.summary).toContain("## Dependency Chain");
	});

	it("normalizes a fenced heading example without turning it into a duplicate section", async () => {
		const summary = VALID_STRUCTURED_SUMMARY.replace(
			"Finish the current repair.",
			[
				"Finish the current repair.",
				"```md",
				"## Current Task State",
				"This is only an example.",
				"```",
				...Array.from({ length: 400 }, () => `- ${"x".repeat(60)}`),
			].join("\n"),
		);
		compactMock.mockResolvedValueOnce(successfulResult(summary));
		const attempt = await runCustomCompaction(
			preparation(),
			"standard",
			context(),
			compatibility(),
		);
		expect(attempt.fallbackReason).toBeNull();
		expect(attempt.result?.summary).toContain("## Dependency Chain");
		expect(
			attempt.result?.summary.match(/## Current Task State/g),
		).toHaveLength(1);
	});

	it.each([
		[new Error("aborted"), "compact error: aborted"],
		["non-error rejection", "compact error: non-error rejection"],
	])("normalizes thrown helper failures", async (error, fallbackReason) => {
		compactMock.mockRejectedValueOnce(error);

		await expect(
			runCustomCompaction(
				preparation(),
				"standard",
				context(),
				compatibility(),
			),
		).resolves.toEqual({ result: undefined, fallbackReason });
	});
});
