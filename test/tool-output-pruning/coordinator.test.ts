import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolOutputPruningCoordinator } from "../../src/tool-output-pruning/coordinator.js";
import {
	buildToolPruneSummaryData,
	MAX_RECONSTRUCTION_SCAN_ENTRIES,
} from "../../src/tool-output-pruning/metadata.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import {
	MAX_FINALIZED_RECORDS,
	type PendingToolOutputBatch,
	type ToolOutputPruningSettings,
	type ToolOutputRecord,
} from "../../src/tool-output-pruning/types.js";
import { TOOL_PRUNE_SUMMARY_CUSTOM_TYPE } from "../../src/types.js";

const piAiMocks = vi.hoisted(() => ({
	completeSimple: vi.fn(),
}));
const { completeSimple } = piAiMocks;

vi.mock("@earendil-works/pi-ai", () => piAiMocks);

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
	entries: Array<{
		type: string;
		id: string;
		message?: AgentMessage;
		customType?: string;
		data?: unknown;
	}>,
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
		expect(state.pendingSnapshot().pendingBatches).toHaveLength(1);
		expect(state.pendingSnapshot().pendingRecords[0]?.toolCallId).toBe("tc1");
		expect(state.pendingSnapshot().pendingRecords[0]?.shortRef).toBe("t1");
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
		expect(state.pendingSnapshot().pendingBatches).toHaveLength(0);
		expect(() => coordinator.query({}, makeCtx())).toThrow(
			"inactive because tool-output pruning is not enabled",
		);
	});

	it("resets pending state and reconciles finalized records on session tree", () => {
		const state = new ToolOutputPruningState();
		state.addPendingBatch(makeBatch(["rec-tc1"]), [
			makeRecord("tc1", "t1", "entry-1"),
		]);
		state.replaceFinalizedRecords([
			makeRecord("tc1", "t1", "entry-1"),
			makeRecord("tc2", "t2", "missing-entry"),
		]);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});

		coordinator.onSessionTree(makeCtx([makeToolResultMessage("tc1")]));

		expect(state.pendingSnapshot().pendingBatches).toHaveLength(0);
		expect(state.pendingSnapshot().pendingRecords).toHaveLength(0);
		expect(
			state.finalizedSnapshot().map((record) => record.toolCallId),
		).toEqual(["tc1"]);
	});

	it("drops finalized records when a branch entry id remains but no matching tool result does", () => {
		const state = new ToolOutputPruningState();
		state.addFinalizedRecord(makeRecord("tc1", "t1", "entry-1"));
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

		expect(state.finalizedSnapshot()).toHaveLength(0);
	});

	it("reconstructs finalized records from current-branch metadata on session tree", () => {
		const toolResult = makeToolResultMessage("tc1", "original output");
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});
		const record = makeRecord("tc1", "t1", "entry-1");
		const summaryData = buildToolPruneSummaryData({
			allRecords: [record],
			metadataRecords: [record],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});

		coordinator.onSessionTree(
			makeCtxFromEntries([
				{ type: "message", id: "entry-1", message: toolResult },
				{
					type: "custom",
					id: "summary-1",
					customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
					data: summaryData,
				},
			]),
		);

		expect(state.finalizedSnapshot()).toHaveLength(1);
		expect(state.finalizedSnapshot()[0]?.toolCallId).toBe("tc1");
		expect(state.finalizedSnapshot()[0]?.fallbackSnippets).toBeNull();
		expect(state.statusSnapshot().lastReconstructionStatus).toBe("ok");
		expect(state.statusSnapshot().lastReconstructedCount).toBe(1);
	});

	it("restores all indexed records across A to B to A navigation", () => {
		const shared = makeRecord("shared", "t1", "entry-1");
		const specific = makeRecord("specific", "t2", "entry-2");
		const summaryA = buildToolPruneSummaryData({
			allRecords: [shared],
			metadataRecords: [shared],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});
		const summaryB = buildToolPruneSummaryData({
			allRecords: [shared, specific],
			metadataRecords: [specific],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 556,
		});
		const sharedMessage = makeToolResultMessage("shared", "shared output");
		const specificMessage = makeToolResultMessage(
			"specific",
			"specific output",
		);
		const entriesA = [
			{ type: "message", id: "entry-1", message: sharedMessage },
			{
				type: "custom",
				id: "summary-A",
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data: summaryA,
			},
		];
		const branchA = makeCtxFromEntries(entriesA);
		const branchB = makeCtxFromEntries([
			...entriesA,
			{ type: "message", id: "entry-2", message: specificMessage },
			{
				type: "custom",
				id: "summary-B",
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data: summaryB,
			},
		]);
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});

		coordinator.onSessionTree(branchA);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
		]);
		coordinator.onSessionTree(branchB);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
			"t2",
		]);
		expect(coordinator.query({ ref: "t2" }, branchB).matches).toHaveLength(1);
		expect(
			coordinator.transformContext([sharedMessage, specificMessage], branchB)
				?.prunedCount,
		).toBe(2);
		coordinator.onSessionTree(branchA);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
		]);
		expect(coordinator.query({ ref: "t2" }, branchA).matches).toHaveLength(0);
		coordinator.onSessionTree(branchB);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
			"t2",
		]);
		expect(state.generateShortRef()).toBe("t3");
	});

	it("preserves live fallback search for a matching durable record", () => {
		const record = {
			...makeRecord("tc1", "t1", "entry-1"),
			fallbackSnippets: "needle beyond scan limit",
		};
		const data = buildToolPruneSummaryData({
			allRecords: [record],
			metadataRecords: [record],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});
		const ctx = makeCtxFromEntries([
			{
				type: "message",
				id: "entry-1",
				message: makeToolResultMessage(
					"tc1",
					`${"x".repeat(13_000)}needle beyond scan limit`,
				),
			},
			{
				type: "custom",
				id: "summary-1",
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data,
			},
		]);
		const state = new ToolOutputPruningState();
		state.addFinalizedRecord(record);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});
		expect(
			coordinator.query({ query: "needle beyond scan limit" }, ctx).matches,
		).toHaveLength(1);

		coordinator.onSessionTree(ctx);
		expect(state.finalizedSnapshot()[0]?.fallbackSnippets).toBe(
			"needle beyond scan limit",
		);
		expect(
			coordinator.query({ query: "needle beyond scan limit" }, ctx).matches,
		).toHaveLength(1);
	});

	it("keeps allowed records and new flushes usable after a policy change", async () => {
		const bash = makeRecord("tc1", "t2", "entry-1");
		const python = {
			...makeRecord("tc2", "t1", "entry-2"),
			toolName: "python",
		};
		const data = buildToolPruneSummaryData({
			allRecords: [bash, python],
			metadataRecords: [bash, python],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});
		const entries: Parameters<typeof makeCtxFromEntries>[0] = [
			{
				type: "message",
				id: "entry-1",
				message: makeToolResultMessage("tc1"),
			},
			{
				type: "message",
				id: "entry-2",
				message: makeToolResultMessage("tc2", undefined, "python"),
			},
			{
				type: "custom",
				id: "summary-1",
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data,
			},
		];
		const ctx = makeCtxFromEntries(entries);
		let settings = ENABLED_SETTINGS;
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => settings,
		});
		coordinator.onSessionTree(ctx);
		expect(state.finalizedSnapshot()).toHaveLength(2);

		settings = {
			...ENABLED_SETTINGS,
			toolOutputPruneExcludedTools: [
				...ENABLED_SETTINGS.toolOutputPruneExcludedTools,
				"bash",
			],
		};
		coordinator.onSessionTree(ctx);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
		]);
		expect(state.statusSnapshot().lastReconstructionStatus).toBe("ok");
		expect(coordinator.query({ ref: "t2" }, ctx).matches).toHaveLength(0);
		state.reset(); // Simulate reload after the excluded record owned t2.
		coordinator.onSessionTree(ctx);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
		]);
		expect(state.generateShortRef()).toBe("t3");

		entries.push({
			type: "message",
			id: "entry-3",
			message: makeToolResultMessage("tc3", undefined, "python"),
		});
		state.addPendingBatch(makeBatch(["rec-tc3"]), [
			{ ...makeRecord("tc3", "t3", null), toolName: "python" },
		]);
		mockCompleteSimple.mockResolvedValueOnce(
			makeSummarizerResponse("## t3\nPython summary."),
		);
		const pi = makeAppendPort();
		const flush = await coordinator.manualFlush(ctx, pi);
		expect(flush.ok).toBe(true);
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
			"t3",
		]);
	});

	it("retains branch-safe in-memory legacy records alongside current metadata", () => {
		const legacy = makeRecord("legacy", "t1", "entry-1");
		const current = makeRecord("current", "t2", "entry-2");
		const summaryData = buildToolPruneSummaryData({
			allRecords: [current],
			metadataRecords: [current],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});
		const entriesA = [
			{
				type: "message",
				id: "entry-1",
				message: makeToolResultMessage("legacy"),
			},
			{
				type: "custom",
				id: "legacy-summary",
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data: {
					timestamp: 1,
					refs: "t1: bash",
					summaryChars: 10,
					recordCount: 1,
				},
			},
		];
		const branchA = makeCtxFromEntries(entriesA);
		const branchB = makeCtxFromEntries([
			...entriesA,
			{
				type: "message",
				id: "entry-2",
				message: makeToolResultMessage("current"),
			},
			{
				type: "custom",
				id: "current-summary",
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data: summaryData,
			},
		]);
		const state = new ToolOutputPruningState();
		state.addFinalizedRecord(legacy);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});

		coordinator.onSessionTree(branchB);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
			"t2",
		]);
		expect(coordinator.query({ ref: "t1" }, branchB).matches).toHaveLength(1);
		coordinator.onSessionTree(branchA);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
		]);
		coordinator.onSessionTree(branchB);
		expect(state.finalizedSnapshot().map((record) => record.shortRef)).toEqual([
			"t1",
			"t2",
		]);
		expect(state.generateShortRef()).toBe("t3");
	});

	it("prefers durable metadata over conflicting in-memory legacy identities", () => {
		const current = makeRecord("current", "t2", "entry-2");
		const conflicting = makeRecord("legacy", "t2", "entry-1");
		const state = new ToolOutputPruningState();
		state.addFinalizedRecord(conflicting);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});
		const summaryData = buildToolPruneSummaryData({
			allRecords: [current],
			metadataRecords: [current],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});

		coordinator.onSessionTree(
			makeCtxFromEntries([
				{
					type: "message",
					id: "entry-1",
					message: makeToolResultMessage("legacy"),
				},
				{
					type: "message",
					id: "entry-2",
					message: makeToolResultMessage("current"),
				},
				{
					type: "custom",
					id: "current-summary",
					customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
					data: summaryData,
				},
			]),
		);
		expect(state.finalizedSnapshot().map((record) => record.recordId)).toEqual([
			"rec-current",
		]);
	});

	it("bounds a mixed legacy and durable index by branch recency", () => {
		const legacy = makeRecord("legacy", "t1", "entry-1");
		const durable = Array.from({ length: MAX_FINALIZED_RECORDS }, (_, index) =>
			makeRecord(`tc${index + 2}`, `t${index + 2}`, `entry-${index + 2}`),
		);
		const summaryData = buildToolPruneSummaryData({
			allRecords: durable,
			metadataRecords: durable,
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});
		const entries = [
			{
				type: "message",
				id: "entry-1",
				message: makeToolResultMessage("legacy"),
			},
			...durable.map((record) => ({
				type: "message",
				id: record.entryId ?? "",
				message: makeToolResultMessage(record.toolCallId),
			})),
			{
				type: "custom",
				id: "durable-summary",
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data: summaryData,
			},
		];
		const state = new ToolOutputPruningState();
		state.addFinalizedRecord(legacy);
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});

		coordinator.onSessionTree(makeCtxFromEntries(entries));
		const restored = state.finalizedSnapshot();
		expect(restored).toHaveLength(MAX_FINALIZED_RECORDS);
		expect(restored[0]?.shortRef).toBe("t2");
		expect(restored.at(-1)?.shortRef).toBe(`t${MAX_FINALIZED_RECORDS + 1}`);
		expect(state.generateShortRef()).toBe(`t${MAX_FINALIZED_RECORDS + 2}`);
	});

	it("fails atomically when new branch metadata is invalid despite a shared survivor", () => {
		const shared = makeRecord("shared", "t1", "entry-1");
		const specific = makeRecord("specific", "t1", "entry-2");
		const summaryA = buildToolPruneSummaryData({
			allRecords: [shared],
			metadataRecords: [shared],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});
		const summaryB = buildToolPruneSummaryData({
			allRecords: [shared, specific],
			metadataRecords: [specific],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 556,
		});
		const entriesA = [
			{
				type: "message",
				id: "entry-1",
				message: makeToolResultMessage("shared"),
			},
			{
				type: "custom",
				id: "summary-A",
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data: summaryA,
			},
		];
		const branchA = makeCtxFromEntries(entriesA);
		const branchB = makeCtxFromEntries([
			...entriesA,
			{
				type: "message",
				id: "entry-2",
				message: makeToolResultMessage("specific"),
			},
			{
				type: "custom",
				id: "summary-B",
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data: summaryB,
			},
		]);
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});

		coordinator.onSessionTree(branchA);
		expect(state.finalizedSnapshot()).toHaveLength(1);
		coordinator.onSessionTree(branchB);
		expect(state.finalizedSnapshot()).toHaveLength(0);
		expect(state.statusSnapshot().lastReconstructionStatus).toBe("error");
		expect(state.statusSnapshot().lastReconstructionError).toContain(
			"duplicate",
		);
	});

	it("advances short refs after reconstruction to avoid duplicate refs", () => {
		const toolResult = makeToolResultMessage("tc1", "original output");
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
			now: () => 1234,
		});
		const record = makeRecord("tc1", "t3", "entry-1");
		const summaryData = buildToolPruneSummaryData({
			allRecords: [record],
			metadataRecords: [record],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});

		coordinator.onSessionTree(
			makeCtxFromEntries([
				{ type: "message", id: "entry-1", message: toolResult },
				{
					type: "custom",
					id: "summary-1",
					customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
					data: summaryData,
				},
			]),
		);
		const capture = coordinator.onTurnEnd({
			message: makeAssistantMessage("toolUse"),
			toolResults: [makeToolResultMessage("tc2")],
			turnIndex: 2,
		});

		expect(capture?.records[0]?.shortRef).toBe("t4");
	});

	it("does not reconstruct or expose records when pruning is disabled", () => {
		const toolResult = makeToolResultMessage("tc1", "original output");
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => DISABLED_SETTINGS,
		});
		const record = makeRecord("tc1", "t1", "entry-1");
		const summaryData = buildToolPruneSummaryData({
			allRecords: [record],
			metadataRecords: [record],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});

		coordinator.onSessionTree(
			makeCtxFromEntries([
				{ type: "message", id: "entry-1", message: toolResult },
				{
					type: "custom",
					id: "summary-1",
					customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
					data: summaryData,
				},
			]),
		);

		expect(state.finalizedSnapshot()).toHaveLength(0);
		expect(state.statusSnapshot().lastReconstructionStatus).toBeNull();
		expect(
			coordinator.transformContext([toolResult], makeCtx([toolResult])),
		).toBe(undefined);
		expect(() => coordinator.query({}, makeCtx([toolResult]))).toThrow(
			"inactive because tool-output pruning is not enabled",
		);
	});

	it("fails metadata reconstruction atomically for stale branches", () => {
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});
		const record = makeRecord("tc1", "t1", "entry-1");
		const summaryData = buildToolPruneSummaryData({
			allRecords: [record],
			metadataRecords: [record],
			settings: ENABLED_SETTINGS,
			summaryChars: 10,
			timestamp: 555,
		});

		coordinator.onSessionTree(
			makeCtxFromEntries([
				{
					type: "message",
					id: "other-entry",
					message: makeToolResultMessage("tc1", "original output"),
				},
				{
					type: "custom",
					id: "summary-1",
					customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
					data: summaryData,
				},
			]),
		);

		expect(state.finalizedSnapshot()).toHaveLength(0);
		expect(state.statusSnapshot().lastReconstructionStatus).toBe("error");
		expect(state.statusSnapshot().lastReconstructionError).toContain(
			"current branch",
		);
	});

	it("stubs current-branch tool results during context transforms", () => {
		const toolResult = makeToolResultMessage("tc1", "original output");
		const state = new ToolOutputPruningState();
		state.addFinalizedRecord(makeRecord("tc1", "t1", "entry-1"));
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
		expect(state.statusSnapshot().lastPrunedCount).toBe(1);
	});

	it("queries recoverable records through the current branch", () => {
		const toolResult = makeToolResultMessage("tc1", "original output needle");
		const state = new ToolOutputPruningState();
		state.addFinalizedRecord(makeRecord("tc1", "t1", "entry-1"));
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
		expect(state.finalizedSnapshot()).toHaveLength(1);
		expect(state.finalizedSnapshot()[0]?.entryId).toBe("entry-1");
		expect(state.pendingSnapshot().pendingBatches).toHaveLength(0);
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
		expect(state.pendingSnapshot().pendingBatches).toHaveLength(1);
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
		expect(state.finalizedSnapshot()).toHaveLength(0);
		expect(state.pendingSnapshot().pendingBatches).toHaveLength(0);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("admits the last metadata slot but refuses a flush that would erase the index", async () => {
		const entries: Parameters<typeof makeCtxFromEntries>[0] = Array.from(
			{ length: MAX_RECONSTRUCTION_SCAN_ENTRIES - 1 },
			(_, index) => {
				const ref = index + 1;
				const record = makeRecord(`tc${ref}`, `t${ref}`, `entry-${ref}`);
				return [
					{
						type: "message",
						id: `entry-${ref}`,
						message: makeToolResultMessage(`tc${ref}`),
					},
					{
						type: "custom",
						id: `summary-${ref}`,
						customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
						data: buildToolPruneSummaryData({
							allRecords: [record],
							metadataRecords: [record],
							settings: ENABLED_SETTINGS,
							summaryChars: 10,
							timestamp: ref,
						}),
					},
				];
			},
		).flat();
		const ctx = makeCtxFromEntries(entries);
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => ENABLED_SETTINGS,
		});
		const pi = {
			appendEntry: vi.fn((customType: string, data?: unknown) => {
				entries.push({
					type: "custom",
					id: `summary-${entries.length}`,
					customType,
					data,
				});
			}),
		};
		coordinator.onSessionTree(ctx);
		expect(state.finalizedSnapshot()).toHaveLength(
			MAX_RECONSTRUCTION_SCAN_ENTRIES - 1,
		);

		for (const ref of [
			MAX_RECONSTRUCTION_SCAN_ENTRIES,
			MAX_RECONSTRUCTION_SCAN_ENTRIES + 1,
		]) {
			entries.push({
				type: "message",
				id: `entry-${ref}`,
				message: makeToolResultMessage(`tc${ref}`),
			});
			state.addPendingBatch(makeBatch([`rec-tc${ref}`]), [
				makeRecord(`tc${ref}`, `t${ref}`, null),
			]);
			mockCompleteSimple.mockResolvedValueOnce(
				makeSummarizerResponse(`## t${ref}\nSummary ${ref}.`),
			);
			const result = await coordinator.manualFlush(ctx, pi);
			if (ref === MAX_RECONSTRUCTION_SCAN_ENTRIES) {
				expect(result.ok).toBe(true);
				expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			} else {
				expect(result.ok).toBe(false);
				expect(result.message).toContain("too many metadata entries");
				expect(pi.appendEntry).toHaveBeenCalledTimes(1);
			}
			coordinator.onSessionTree(ctx);
			expect(state.finalizedSnapshot()).toHaveLength(
				MAX_RECONSTRUCTION_SCAN_ENTRIES,
			);
		}
		expect(coordinator.query({ ref: "t1" }, ctx).matches).toHaveLength(1);
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
		expect(state.finalizedSnapshot()[0]?.entryId).toBe("entry-1");
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});
});
