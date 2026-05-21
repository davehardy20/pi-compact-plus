import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
	completeSimple: vi.fn(),
}));

import { completeSimple } from "@earendil-works/pi-ai";

const mockCompleteSimple = vi.mocked(completeSimple);

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	captureTurnEndBatch,
	flushPendingBatches,
	isFinalAssistantMessageForToolPrune,
	shouldFlushOnMessageEnd,
} from "../../src/tool-output-pruning/lifecycle.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import type { ToolOutputPruningSettings } from "../../src/tool-output-pruning/types.js";

const ENABLED_SETTINGS: ToolOutputPruningSettings = {
	experimentalToolOutputPruning: true,
	toolOutputPruningMode: "agent-message",
	toolOutputSummaryStrategy: "llm",
	toolOutputPruneStrategy: "stub",
	toolOutputPruneMinChars: 10,
	toolOutputSummaryMaxChars: 1600,
	toolOutputQueryMaxChars: 12000,
	toolOutputSummarizerModel: "default",
	toolOutputSummarizerThinking: "low",
	toolOutputPruneExcludedTools: [
		"read",
		"read_hashed",
		"hashline_edit",
		"compact_plus_query_tool_output",
	],
	toolOutputPruneIncludedTools: [],
};

const DISABLED_SETTINGS: ToolOutputPruningSettings = {
	...ENABLED_SETTINGS,
	experimentalToolOutputPruning: false,
};

function makeAssistantMessage(
	toolCalls?: Array<{ id: string; name: string }>,
): AgentMessage {
	return {
		role: "assistant" as const,
		content: toolCalls
			? toolCalls.map((tc) => ({ type: "toolCall" as const, ...tc }))
			: [{ type: "text" as const, text: "hello" }],
	} as unknown as AgentMessage;
}

function makeToolResult(options: {
	toolCallId: string;
	toolName: string;
	text: string;
}): AgentMessage {
	return {
		role: "toolResult" as const,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
		content: [{ type: "text", text: options.text }],
		isError: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

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

	it("does not finalize records when branch entry is missing", async () => {
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

		expect(result.ok).toBe(true);
		expect(state.finalizedRecords).toHaveLength(0);
		expect(state.pendingBatches).toHaveLength(0);
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
