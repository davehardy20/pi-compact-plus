import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
	completeSimple: vi.fn(),
}));

import { completeSimple } from "@earendil-works/pi-ai";

const mockCompleteSimple = vi.mocked(completeSimple);

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSummarizerInputs,
	captureTurnEndBatch,
	flushPendingBatches,
	isFinalAssistantMessageForToolPrune,
	shouldFlushOnMessageEnd,
} from "../../src/tool-output-pruning/lifecycle.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import type { ToolOutputRecord } from "../../src/tool-output-pruning/types.js";
import {
	MAX_FINALIZED_RECORDS,
	MAX_SUMMARIZER_INPUTS_PER_BATCH,
} from "../../src/tool-output-pruning/types.js";
import {
	DISABLED_TOOL_OUTPUT_PRUNING_SETTINGS,
	makeAssistantMessage,
	makeToolOutputPruningSettings,
	makeToolOutputRecord,
	makeToolResult,
} from "../fixtures/tool-output-pruning.js";

const ENABLED_SETTINGS = makeToolOutputPruningSettings({
	toolOutputPruneMinChars: 10,
});

const DISABLED_SETTINGS = makeToolOutputPruningSettings({
	...DISABLED_TOOL_OUTPUT_PRUNING_SETTINGS,
	toolOutputPruneMinChars: 10,
});

function makeMockContext() {
	return {
		model: {
			id: "test-model",
			name: "test-model",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		},
		modelRegistry: {
			find: vi.fn(),
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true as const,
				apiKey: "test-key",
				headers: {},
			})),
		},
		hasUI: false,
		ui: { notify: vi.fn() },
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}

describe("isFinalAssistantMessageForToolPrune", () => {
	it("returns true for final assistant text responses", () => {
		expect(
			isFinalAssistantMessageForToolPrune({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
			} as unknown as AgentMessage),
		).toBe(true);
	});

	it("returns false for assistant tool-use responses", () => {
		expect(
			isFinalAssistantMessageForToolPrune({
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "bash" }],
				stopReason: "toolUse",
			} as unknown as AgentMessage),
		).toBe(false);
	});

	it("returns false for idless assistant tool-call blocks", () => {
		expect(
			isFinalAssistantMessageForToolPrune({
				role: "assistant",
				content: [{ type: "toolCall", name: "bash" }],
				stopReason: "stop",
			} as unknown as AgentMessage),
		).toBe(false);
	});

	it("returns false for error or aborted assistant responses", () => {
		expect(
			isFinalAssistantMessageForToolPrune({
				role: "assistant",
				content: [{ type: "text", text: "failed" }],
				stopReason: "error",
			} as unknown as AgentMessage),
		).toBe(false);
		expect(
			isFinalAssistantMessageForToolPrune({
				role: "assistant",
				content: [{ type: "text", text: "aborted" }],
				stopReason: "aborted",
			} as unknown as AgentMessage),
		).toBe(false);
	});
});

describe("shouldFlushOnMessageEnd", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it("returns false when pruning is disabled", () => {
		expect(shouldFlushOnMessageEnd(state, DISABLED_SETTINGS, false)).toBe(
			false,
		);
	});

	it("returns false when auto-compaction is in progress", () => {
		expect(shouldFlushOnMessageEnd(state, ENABLED_SETTINGS, true)).toBe(false);
	});

	it("returns false when a flush is already in progress", () => {
		state.isFlushing = true;
		expect(shouldFlushOnMessageEnd(state, ENABLED_SETTINGS, false)).toBe(false);
	});

	it("returns false when there are no pending batches", () => {
		expect(shouldFlushOnMessageEnd(state, ENABLED_SETTINGS, false)).toBe(false);
	});

	it("returns true when all conditions are met", () => {
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: ["r1"],
		});
		expect(shouldFlushOnMessageEnd(state, ENABLED_SETTINGS, false)).toBe(true);
	});
});

describe("captureTurnEndBatch", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it("returns null and does not mutate state when pruning is disabled", () => {
		const assistant = makeAssistantMessage([{ id: "tc1", name: "bash" }]);
		const toolResults = [
			makeToolResult({
				toolCallId: "tc1",
				toolName: "bash",
				text: "a".repeat(100),
			}),
		];

		const result = captureTurnEndBatch(
			assistant,
			toolResults,
			0,
			Date.now(),
			DISABLED_SETTINGS,
			state,
		);

		expect(result).toBeNull();
		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
	});

	it("captures eligible tool results into pending state", () => {
		const assistant = makeAssistantMessage([{ id: "tc1", name: "bash" }]);
		const toolResults = [
			makeToolResult({
				toolCallId: "tc1",
				toolName: "bash",
				text: "a".repeat(100),
			}),
		];

		const result = captureTurnEndBatch(
			assistant,
			toolResults,
			0,
			Date.now(),
			ENABLED_SETTINGS,
			state,
		);

		expect(result).not.toBeNull();
		expect(state.pendingBatches).toHaveLength(1);
		expect(state.pendingRecords).toHaveLength(1);
		expect(state.pendingRecords[0].toolCallId).toBe("tc1");
	});

	it("returns null when no tool results are eligible", () => {
		const assistant = makeAssistantMessage();
		const toolResults: AgentMessage[] = [];

		const result = captureTurnEndBatch(
			assistant,
			toolResults,
			0,
			Date.now(),
			ENABLED_SETTINGS,
			state,
		);

		expect(result).toBeNull();
	});
});

describe("flushPendingBatches", () => {
	let state: ToolOutputPruningState;
	let pi: { appendEntry: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		state = new ToolOutputPruningState();
		pi = { appendEntry: vi.fn() };
		mockCompleteSimple.mockReset();
	});

	it("returns not-enabled when pruning is disabled", async () => {
		const ctx = makeMockContext();
		const result = await flushPendingBatches(
			state,
			DISABLED_SETTINGS,
			ctx,
			[],
			pi,
		);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("not enabled");
	});

	it("returns empty success when no pending batches", async () => {
		const ctx = makeMockContext();
		const result = await flushPendingBatches(
			state,
			ENABLED_SETTINGS,
			ctx,
			[],
			pi,
		);
		expect(result.ok).toBe(true);
		expect(result.indexedCount).toBe(0);
	});

	it("atomically summarizes, indexes, and appends on success", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [
				{
					type: "text",
					text: "## t1\nSummary one.",
				},
			],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: {
				input: 10,
				output: 5,
				totalTokens: 15,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		state.pendingRecords.push({
			recordId: "r1",
			entryId: null,
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: null,
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: ["r1"],
		});

		const branchEntries = [
			{
				id: "e1",
				message: makeToolResult({
					toolCallId: "tc1",
					toolName: "bash",
					text: "original",
				}),
			},
		];

		const ctx = makeMockContext();
		const result = await flushPendingBatches(
			state,
			ENABLED_SETTINGS,
			ctx,
			branchEntries,
			pi,
		);

		expect(result.ok).toBe(true);
		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.finalizedRecords[0].entryId).toBe("e1");
		expect(state.finalizedRecords[0].summary).toBe("Summary one.");
		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.lastSummaryStatus).toBe("ok");
		expect(state.lastSummaryTime).not.toBeNull();
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		const appendCall = pi.appendEntry.mock.calls[0];
		expect(appendCall?.[0]).toBe("compact-plus-tool-prune-summary");
		expect(appendCall?.[1]).toMatchObject({
			recordCount: 1,
			refs: "t1: bash",
			metadata: {
				recordCount: 1,
				records: [
					{
						recordId: "r1",
						entryId: "e1",
						toolCallId: "tc1",
						toolName: "bash",
						fallbackSnippets: null,
					},
				],
			},
		});
		expect(JSON.stringify(appendCall?.[1])).not.toContain("original");
		expect(state.isFlushing).toBe(false);
	});

	it("clears pending and sets error status on summarization failure", async () => {
		mockCompleteSimple.mockRejectedValueOnce(new Error("Network failure"));

		state.pendingRecords.push({
			recordId: "r1",
			entryId: null,
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: null,
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: ["r1"],
		});

		const branchEntries = [
			{
				id: "e1",
				message: makeToolResult({
					toolCallId: "tc1",
					toolName: "bash",
					text: "original",
				}),
			},
		];

		const ctx = makeMockContext();
		const result = await flushPendingBatches(
			state,
			ENABLED_SETTINGS,
			ctx,
			branchEntries,
			pi,
		);

		expect(result.ok).toBe(false);
		expect(state.finalizedRecords).toHaveLength(0);
		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.lastSummaryStatus).toBe("error");
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(state.isFlushing).toBe(false);
	});

	it("clears pending and sets error status on empty LLM response", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "   " }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: {
				input: 10,
				output: 1,
				totalTokens: 11,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		state.pendingRecords.push({
			recordId: "r1",
			entryId: null,
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: null,
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: ["r1"],
		});

		const branchEntries = [
			{
				id: "e1",
				message: makeToolResult({
					toolCallId: "tc1",
					toolName: "bash",
					text: "original",
				}),
			},
		];

		const ctx = makeMockContext();
		const result = await flushPendingBatches(
			state,
			ENABLED_SETTINGS,
			ctx,
			branchEntries,
			pi,
		);

		expect(result.ok).toBe(false);
		expect(state.pendingBatches).toHaveLength(0);
		expect(state.lastSummaryStatus).toBe("error");
		expect(state.isFlushing).toBe(false);
	});

	it("fails atomically when branch entry is missing", async () => {
		state.pendingRecords.push({
			recordId: "r1",
			entryId: null,
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: null,
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: ["r1"],
		});

		// Branch is empty — no matching tool result
		const ctx = makeMockContext();
		const result = await flushPendingBatches(
			state,
			ENABLED_SETTINGS,
			ctx,
			[],
			pi,
		);

		expect(result.ok).toBe(false);
		expect(state.finalizedRecords).toHaveLength(0);
		expect(state.pendingBatches).toHaveLength(0);
		expect(state.lastSummaryStatus).toBe("error");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("restores the full finalized-record snapshot when appendEntry fails after trimming", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [
				{
					type: "text",
					text: `## t${MAX_FINALIZED_RECORDS + 1}\nNew summary.`,
				},
			],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: {
				input: 10,
				output: 5,
				totalTokens: 15,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		for (let i = 0; i < MAX_FINALIZED_RECORDS; i++) {
			state.finalizedRecords.push(
				makeToolOutputRecord({
					recordId: `old-${i}`,
					entryId: `old-entry-${i}`,
					toolCallId: `old-tc-${i}`,
					shortRef: `t${i + 1}`,
					summary: `old summary ${i}`,
				}),
			);
		}
		const beforeRecordIds = state.finalizedRecords.map((r) => r.recordId);

		state.pendingRecords.push(
			makeToolOutputRecord({
				recordId: "new-record",
				entryId: null,
				toolCallId: "new-tc",
				shortRef: `t${MAX_FINALIZED_RECORDS + 1}`,
			}),
		);
		state.pendingBatches.push({
			batchId: "new-batch",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: ["new-record"],
		});
		pi.appendEntry.mockImplementationOnce(() => {
			throw new Error("append failed after indexing");
		});

		const result = await flushPendingBatches(
			state,
			ENABLED_SETTINGS,
			makeMockContext(),
			[
				{
					id: "new-entry",
					message: makeToolResult({
						toolCallId: "new-tc",
						toolName: "bash",
						text: "new original output",
					}),
				},
			],
			pi,
		);

		expect(result.ok).toBe(false);
		expect(state.finalizedRecords.map((r) => r.recordId)).toEqual(
			beforeRecordIds,
		);
		expect(
			state.finalizedRecords.some((r) => r.recordId === "new-record"),
		).toBe(false);
		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.lastSummaryStatus).toBe("error");
		expect(state.isFlushing).toBe(false);
	});

	it("sets flushing flag during operation and clears after", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "## t1\nOK" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: {
				input: 10,
				output: 1,
				totalTokens: 11,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		state.pendingRecords.push({
			recordId: "r1",
			entryId: null,
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: null,
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: ["r1"],
		});

		const branchEntries = [
			{
				id: "e1",
				message: makeToolResult({
					toolCallId: "tc1",
					toolName: "bash",
					text: "original",
				}),
			},
		];

		const ctx = makeMockContext();
		const flushPromise = flushPendingBatches(
			state,
			ENABLED_SETTINGS,
			ctx,
			branchEntries,
			pi,
		);
		expect(state.isFlushing).toBe(true);

		await flushPromise;
		expect(state.isFlushing).toBe(false);
	});
});

describe("buildSummarizerInputs atomic resolution", () => {
	it(`returns null when inputs exceed MAX_SUMMARIZER_INPUTS_PER_BATCH (${MAX_SUMMARIZER_INPUTS_PER_BATCH})`, () => {
		const branchEntries: Array<{ id: string; message: AgentMessage }> = [];
		const pendingRecords: ToolOutputRecord[] = [];
		for (let i = 0; i < MAX_SUMMARIZER_INPUTS_PER_BATCH + 10; i++) {
			branchEntries.push({
				id: `e${i}`,
				message: makeToolResult({
					toolCallId: `tc${i}`,
					toolName: "bash",
					text: "output",
				}),
			});
			pendingRecords.push(
				makeToolOutputRecord({
					recordId: `r${i}`,
					toolCallId: `tc${i}`,
					shortRef: `t${i + 1}`,
				}),
			);
		}
		const inputs = buildSummarizerInputs(pendingRecords, branchEntries);
		expect(inputs).toBeNull();
	});

	it("returns null when a pending record is missing from the branch", () => {
		const pendingRecords: ToolOutputRecord[] = [
			makeToolOutputRecord(),
			makeToolOutputRecord({
				recordId: "r2",
				toolCallId: "tc2",
				toolName: "read",
				shortRef: "t2",
			}),
		];
		const branchEntries = [
			{
				id: "e1",
				message: makeToolResult({
					toolCallId: "tc1",
					toolName: "bash",
					text: "output1",
				}),
			},
			// tc2 is missing
		];
		const inputs = buildSummarizerInputs(pendingRecords, branchEntries);
		expect(inputs).toBeNull();
	});

	it("returns all inputs when every record is present within limits", () => {
		const pendingRecords: ToolOutputRecord[] = [makeToolOutputRecord()];
		const branchEntries = [
			{
				id: "e1",
				message: makeToolResult({
					toolCallId: "tc1",
					toolName: "bash",
					text: "output1",
				}),
			},
		];
		const inputs = buildSummarizerInputs(pendingRecords, branchEntries);
		expect(inputs).toEqual([expect.objectContaining({ recordId: "r1" })]);
	});
});

describe("flushPendingBatches multi-record atomicity", () => {
	let state: ToolOutputPruningState;
	let pi: { appendEntry: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		state = new ToolOutputPruningState();
		pi = { appendEntry: vi.fn() };
		mockCompleteSimple.mockReset();
	});

	it("fails atomically when LLM returns fewer summaries than records", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "## t1\nSummary one." }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: {
				input: 10,
				output: 5,
				totalTokens: 15,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		state.pendingRecords.push(
			{
				recordId: "r1",
				entryId: null,
				toolCallId: "tc1",
				toolName: "bash",
				timestamp: Date.now(),
				chars: 100,
				isError: false,
				summary: null,
				shortRef: "t1",
				argsPreview: null,
				fallbackSnippets: null,
			},
			{
				recordId: "r2",
				entryId: null,
				toolCallId: "tc2",
				toolName: "read",
				timestamp: Date.now(),
				chars: 100,
				isError: false,
				summary: null,
				shortRef: "t2",
				argsPreview: null,
				fallbackSnippets: null,
			},
		);
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: ["r1", "r2"],
		});

		const branchEntries = [
			{
				id: "e1",
				message: makeToolResult({
					toolCallId: "tc1",
					toolName: "bash",
					text: "original1",
				}),
			},
			{
				id: "e2",
				message: makeToolResult({
					toolCallId: "tc2",
					toolName: "read",
					text: "original2",
				}),
			},
		];

		const ctx = makeMockContext();
		const result = await flushPendingBatches(
			state,
			ENABLED_SETTINGS,
			ctx,
			branchEntries,
			pi,
		);

		expect(result.ok).toBe(false);
		expect(state.finalizedRecords).toHaveLength(0);
		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.lastSummaryStatus).toBe("error");
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
});
