import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import { indexToolResultsFromBranch } from "../../src/tool-output-pruning/indexer.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import type {
	PendingToolOutputBatch,
	ToolOutputRecord,
} from "../../src/tool-output-pruning/types.js";
import { ENABLED_TOOL_OUTPUT_PRUNING_SETTINGS as DEFAULT_SETTINGS } from "../fixtures/tool-output-pruning.js";

function makeBranchEntry(
	id: string,
	message: unknown,
): { id: string; message: AgentMessage } {
	return { id, message: message as AgentMessage };
}

function makeToolResultMessage(
	toolCallId: string,
	options: { toolName?: string; mixed?: boolean } = {},
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: options.toolName ?? "bash",
		content: options.mixed
			? [
					{ type: "text", text: "out" },
					{ type: "image", source: { type: "base64", data: "abc" } },
				]
			: [{ type: "text", text: "out" }],
		isError: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function makeRecord(toolCallId: string, recordId: string): ToolOutputRecord {
	return {
		recordId,
		entryId: null,
		toolCallId,
		toolName: "bash",
		timestamp: Date.now(),
		chars: 10,
		isError: false,
		summary: null,
		shortRef: "t1",
		argsPreview: null,
		fallbackSnippets: null,
	};
}

describe("indexToolResultsFromBranch", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it("reconciles records with branch entries and finalizes them", () => {
		const entries = [makeBranchEntry("e1", makeToolResultMessage("tc1"))];
		const records = [makeRecord("tc1", "r1")];
		const summaries = new Map<string, string>([["r1", "summary text"]]);

		indexToolResultsFromBranch(
			entries,
			[
				{
					batch: {
						batchId: "b1",
						turnIndex: 0,
						timestamp: 1000,
						recordIds: ["r1"],
					},
					records,
					summaries,
				},
			],
			state,
			DEFAULT_SETTINGS,
		);

		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.finalizedRecords[0].entryId).toBe("e1");
		expect(state.finalizedRecords[0].summary).toBe("summary text");
	});

	it("skips records whose toolCallId is not in the branch", () => {
		const entries = [makeBranchEntry("e1", makeToolResultMessage("tc1"))];
		const records = [makeRecord("tc1", "r1"), makeRecord("tc2", "r2")];
		const summaries = new Map<string, string>();

		indexToolResultsFromBranch(
			entries,
			[
				{
					batch: {
						batchId: "b1",
						turnIndex: 0,
						timestamp: 1000,
						recordIds: ["r1", "r2"],
					},
					records,
					summaries,
				},
			],
			state,
			DEFAULT_SETTINGS,
		);

		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.finalizedRecords[0].recordId).toBe("r1");
	});

	it("uses the identity seam when resolving branch entries", () => {
		const entries = [
			makeBranchEntry(
				"wrong-tool",
				makeToolResultMessage("tc1", { toolName: "python" }),
			),
			makeBranchEntry("mixed", makeToolResultMessage("tc1", { mixed: true })),
			makeBranchEntry(
				"read",
				makeToolResultMessage("tc1", { toolName: "read" }),
			),
			makeBranchEntry("match", makeToolResultMessage("tc1")),
		];
		const records = [makeRecord("tc1", "r1")];

		indexToolResultsFromBranch(
			entries,
			[
				{
					batch: {
						batchId: "b1",
						turnIndex: 0,
						timestamp: 1000,
						recordIds: ["r1"],
					},
					records,
					summaries: new Map<string, string>(),
				},
			],
			state,
			DEFAULT_SETTINGS,
		);

		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.finalizedRecords[0].entryId).toBe("match");
	});

	it("does not duplicate finalized records", () => {
		const entries = [makeBranchEntry("e1", makeToolResultMessage("tc1"))];
		const records = [makeRecord("tc1", "r1")];
		const summaries = new Map<string, string>();

		indexToolResultsFromBranch(
			entries,
			[
				{
					batch: {
						batchId: "b1",
						turnIndex: 0,
						timestamp: 1000,
						recordIds: ["r1"],
					},
					records,
					summaries,
				},
			],
			state,
			DEFAULT_SETTINGS,
		);
		indexToolResultsFromBranch(
			entries,
			[
				{
					batch: {
						batchId: "b2",
						turnIndex: 1,
						timestamp: 2000,
						recordIds: ["r1"],
					},
					records,
					summaries,
				},
			],
			state,
			DEFAULT_SETTINGS,
		);

		expect(state.finalizedRecords).toHaveLength(1);
	});

	it("removes indexed batches from pending", () => {
		state.pendingBatches.push(
			{ batchId: "b1", turnIndex: 0, timestamp: 1000, recordIds: ["r1"] },
			{ batchId: "b2", turnIndex: 1, timestamp: 2000, recordIds: ["r2"] },
		);

		const entries = [makeBranchEntry("e1", makeToolResultMessage("tc1"))];
		const records = [makeRecord("tc1", "r1")];
		const summaries = new Map<string, string>();

		indexToolResultsFromBranch(
			entries,
			[
				{
					batch: {
						batchId: "b1",
						turnIndex: 0,
						timestamp: 1000,
						recordIds: ["r1"],
					},
					records,
					summaries,
				},
			],
			state,
			DEFAULT_SETTINGS,
		);

		expect(state.pendingBatches).toHaveLength(1);
		expect(state.pendingBatches[0].batchId).toBe("b2");
	});

	it("preserves summary as null when not provided in summaries map", () => {
		const entries = [makeBranchEntry("e1", makeToolResultMessage("tc1"))];
		const records = [makeRecord("tc1", "r1")];
		const summaries = new Map<string, string>();

		indexToolResultsFromBranch(
			entries,
			[
				{
					batch: {
						batchId: "b1",
						turnIndex: 0,
						timestamp: 1000,
						recordIds: ["r1"],
					},
					records,
					summaries,
				},
			],
			state,
			DEFAULT_SETTINGS,
		);

		expect(state.finalizedRecords[0].summary).toBeNull();
	});

	it("handles multiple indexed batches in one call", () => {
		const entries = [
			makeBranchEntry("e1", makeToolResultMessage("tc1")),
			makeBranchEntry("e2", makeToolResultMessage("tc2")),
		];
		const batch1 = {
			batch: {
				batchId: "b1",
				turnIndex: 0,
				timestamp: 1000,
				recordIds: ["r1"],
			} as PendingToolOutputBatch,
			records: [makeRecord("tc1", "r1")],
			summaries: new Map<string, string>([["r1", "sum1"]]),
		};
		const batch2 = {
			batch: {
				batchId: "b2",
				turnIndex: 1,
				timestamp: 2000,
				recordIds: ["r2"],
			} as PendingToolOutputBatch,
			records: [makeRecord("tc2", "r2")],
			summaries: new Map<string, string>([["r2", "sum2"]]),
		};

		indexToolResultsFromBranch(
			entries,
			[batch1, batch2],
			state,
			DEFAULT_SETTINGS,
		);

		expect(state.finalizedRecords).toHaveLength(2);
		expect(state.finalizedRecords[0].summary).toBe("sum1");
		expect(state.finalizedRecords[1].summary).toBe("sum2");
	});
});
