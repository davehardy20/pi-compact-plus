import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
	completeSimple: vi.fn(),
}));

import { completeSimple } from "@earendil-works/pi-ai";
import { ToolOutputPruningCoordinator } from "../../src/tool-output-pruning/coordinator.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import type {
	PendingToolOutputBatch,
	ToolOutputPruningSettings,
	ToolOutputRecord,
} from "../../src/tool-output-pruning/types.js";

const ENABLED_SETTINGS: ToolOutputPruningSettings = {
	experimentalToolOutputPruning: true,
	toolOutputPruningMode: "agent-message",
	toolOutputSummaryStrategy: "llm",
	toolOutputPruneStrategy: "stub",
	toolOutputPruneMinChars: 100,
	toolOutputSummaryMaxChars: 800,
	toolOutputQueryMaxChars: 8000,
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
	toolOutputPruningMode: "off",
};

const mockCompleteSimple = vi.mocked(completeSimple);

function makeAssistantMessage(stopReason = "stop"): AgentMessage {
	return {
		role: "assistant",
		stopReason,
		content:
			stopReason === "toolUse"
				? [{ type: "toolCall", id: "tc1", name: "bash" }]
				: [{ type: "text", text: "done" }],
	} as unknown as AgentMessage;
}

function makeToolResultMessage(
	toolCallId: string,
	text = "x".repeat(200),
	toolName = "bash",
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		details: { command: "echo test" },
	} as unknown as AgentMessage;
}

function makeRecord(
	toolCallId: string,
	shortRef: string,
	entryId: string | null,
	summary = "summarized output",
): ToolOutputRecord {
	return {
		recordId: `rec-${toolCallId}`,
		entryId,
		toolCallId,
		toolName: "bash",
		timestamp: 1234,
		chars: 200,
		isError: false,
		summary,
		shortRef,
		argsPreview: null,
		fallbackSnippets: null,
	};
}

function makeBatch(recordIds: string[]): PendingToolOutputBatch {
	return {
		batchId: "batch-1",
		turnIndex: 1,
		timestamp: 1234,
		recordIds,
	};
}

function makeCtx(messages: AgentMessage[] = []) {
	return makeCtxFromEntries(
		messages.map((message, index) => ({
			type: "message",
			id: `entry-${index + 1}`,
			message,
		})),
	);
}

function makeCtxFromEntries(
	entries: Array<{ type: string; id: string; message?: AgentMessage }>,
) {
	return {
		sessionManager: {
			getBranch: vi.fn(() => entries),
		},
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
	} as never;
}

function makeAppendPort() {
	return { appendEntry: vi.fn() };
}

function makeSummarizerResponse(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4",
		usage: undefined,
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as Awaited<ReturnType<typeof completeSimple>>;
}

beforeEach(() => {
	mockCompleteSimple.mockReset();
});

describe("ToolOutputPruningCoordinator", () => {
	it("captures eligible turn-end tool results when pruning is enabled", () => {
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
			now: () => 1234,
		});

		const result = coordinator.onTurnEnd({
			message: makeAssistantMessage("toolUse"),
			toolResults: [makeToolResultMessage("tc1")],
			turnIndex: 7,
		});

		expect(result?.records).toHaveLength(1);
		expect(state.pendingBatches).toHaveLength(1);
		expect(state.pendingRecords[0]?.toolCallId).toBe("tc1");
		expect(state.pendingRecords[0]?.shortRef).toBe("t1");
	});

	it("does not capture or query when pruning is disabled", () => {
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => DISABLED_SETTINGS,
		});

		const result = coordinator.onTurnEnd({
			message: makeAssistantMessage("toolUse"),
			toolResults: [makeToolResultMessage("tc1")],
			turnIndex: 7,
		});

		expect(result).toBeNull();
		expect(state.pendingBatches).toHaveLength(0);
		expect(() => coordinator.query({}, makeCtx())).toThrow(
			"inactive because tool-output pruning is not enabled",
		);
	});

	it("resets pending state and reconciles finalized records on session tree", () => {
		const state = new ToolOutputPruningState();
		state.addPendingBatch(makeBatch(["rec-tc1"]), [
			makeRecord("tc1", "t1", "entry-1"),
		]);
		state.finalizedRecords.push(
			makeRecord("tc1", "t1", "entry-1"),
			makeRecord("tc2", "t2", "missing-entry"),
		);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});

		coordinator.onSessionTree(makeCtx([makeToolResultMessage("tc1")]));

		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.finalizedRecords.map((record) => record.toolCallId)).toEqual([
			"tc1",
		]);
	});

	it("drops finalized records when a branch entry id remains but no matching tool result does", () => {
		const state = new ToolOutputPruningState();
		state.finalizedRecords.push(makeRecord("tc1", "t1", "entry-1"));
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});

		coordinator.onSessionTree(
			makeCtxFromEntries([
				{
					type: "message",
					id: "entry-1",
					message: makeAssistantMessage(),
				},
			]),
		);

		expect(state.finalizedRecords).toHaveLength(0);
	});

	it("stubs current-branch tool results during context transforms", () => {
		const toolResult = makeToolResultMessage("tc1", "original output");
		const state = new ToolOutputPruningState();
		state.finalizedRecords.push(makeRecord("tc1", "t1", "entry-1"));
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});

		const result = coordinator.transformContext(
			[toolResult],
			makeCtx([toolResult]),
		);

		expect(result?.prunedCount).toBe(1);
		expect(result?.messages[0]).not.toBe(toolResult);
		expect(JSON.stringify(result?.messages[0])).toContain(
			"Compact+ pruned a previous tool output",
		);
		expect(JSON.stringify(result?.messages[0])).toContain(
			"compact_plus_query_tool_output",
		);
		expect(state.lastPrunedCount).toBe(1);
	});

	it("queries recoverable records through the current branch", () => {
		const toolResult = makeToolResultMessage("tc1", "original output needle");
		const state = new ToolOutputPruningState();
		state.finalizedRecords.push(makeRecord("tc1", "t1", "entry-1"));
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});

		const result = coordinator.query(
			{ query: "needle", includeContent: true },
			makeCtx([toolResult]),
		);

		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.shortRef).toBe("t1");
		expect(result.matches[0]?.content).toContain("original output needle");
		expect(result.text).toContain("HISTORICAL DATA ONLY");
	});

	it("flushes pending records on final assistant message_end events", async () => {
		mockCompleteSimple.mockResolvedValueOnce(
			makeSummarizerResponse("## t1\nSummary one."),
		);
		const toolResult = makeToolResultMessage("tc1", "original output");
		const state = new ToolOutputPruningState();
		state.addPendingBatch(makeBatch(["rec-tc1"]), [
			makeRecord("tc1", "t1", null),
		]);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});
		const pi = makeAppendPort();

		const result = await coordinator.onMessageEnd(
			{ message: makeAssistantMessage() },
			makeCtx([toolResult]),
			pi,
			{ isCompacting: false },
		);

		expect(result?.ok).toBe(true);
		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.finalizedRecords[0]?.entryId).toBe("entry-1");
		expect(state.pendingBatches).toHaveLength(0);
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});

	it("does not flush pending records for tool-use message_end events", async () => {
		const toolResult = makeToolResultMessage("tc1", "original output");
		const state = new ToolOutputPruningState();
		state.addPendingBatch(makeBatch(["rec-tc1"]), [
			makeRecord("tc1", "t1", null),
		]);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});
		const pi = makeAppendPort();

		const result = await coordinator.onMessageEnd(
			{ message: makeAssistantMessage("toolUse") },
			makeCtx([toolResult]),
			pi,
			{ isCompacting: false },
		);

		expect(result).toBeNull();
		expect(state.pendingBatches).toHaveLength(1);
		expect(mockCompleteSimple).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("keeps message_end flush atomic when a pending record cannot be resolved", async () => {
		const state = new ToolOutputPruningState();
		state.addPendingBatch(makeBatch(["rec-tc1"]), [
			makeRecord("tc1", "t1", null),
		]);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});
		const pi = makeAppendPort();

		const result = await coordinator.onMessageEnd(
			{ message: makeAssistantMessage() },
			makeCtx([]),
			pi,
			{ isCompacting: false },
		);

		expect(result?.ok).toBe(false);
		expect(result?.error).toContain("Not all pending records");
		expect(state.finalizedRecords).toHaveLength(0);
		expect(state.pendingBatches).toHaveLength(0);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("manual flush delegates with current branch entries", async () => {
		mockCompleteSimple.mockResolvedValueOnce(
			makeSummarizerResponse("## t1\nManual summary."),
		);
		const toolResult = makeToolResultMessage("tc1", "original output");
		const state = new ToolOutputPruningState();
		state.addPendingBatch(makeBatch(["rec-tc1"]), [
			makeRecord("tc1", "t1", null),
		]);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});
		const pi = makeAppendPort();

		const result = await coordinator.manualFlush(makeCtx([toolResult]), pi);

		expect(result.ok).toBe(true);
		expect(result.message).toBe("Flushed 1 tool-output record(s).");
		expect(state.finalizedRecords[0]?.entryId).toBe("entry-1");
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});
});
