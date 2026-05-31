import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyToolOutputPruning,
	branchEntrySafelyMatchesToolOutputRecord,
	buildPrunedToolResult,
} from "../../src/tool-output-pruning/pruner.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import {
	DISABLED_TOOL_OUTPUT_PRUNING_SETTINGS,
	makeToolOutputPruningSettings,
	makeToolOutputRecord,
	makeToolResult,
} from "../fixtures/tool-output-pruning.js";

const ENABLED_SETTINGS = makeToolOutputPruningSettings();
const DISABLED_SETTINGS = makeToolOutputPruningSettings(
	DISABLED_TOOL_OUTPUT_PRUNING_SETTINGS,
);

function makeToolResultMessage(toolCallId: string, text: string): AgentMessage {
	return makeToolResult({ toolCallId, text });
}

function makeRecord(
	toolCallId: string,
	shortRef: string,
	entryId: string | null,
	summary: string | null,
) {
	return makeToolOutputRecord({
		recordId: `rec-${toolCallId}`,
		entryId,
		toolCallId,
		summary,
		shortRef,
	});
}

describe("buildPrunedToolResult", () => {
	it("preserves role, toolCallId, toolName, and isError", () => {
		const message = makeToolResultMessage("tc1", "original output");
		const record = makeRecord("tc1", "t1", "e1", "summary text");
		const pruned = buildPrunedToolResult(message, record);

		expect(pruned.role).toBe("toolResult");
		expect((pruned as { toolCallId?: string }).toolCallId).toBe("tc1");
		expect((pruned as { toolName?: string }).toolName).toBe("bash");
		expect((pruned as { isError?: boolean }).isError).toBe(false);
	});

	it("replaces text content with a stub containing summary and recovery info", () => {
		const message = makeToolResultMessage("tc1", "the quick brown fox");
		const record = makeRecord("tc1", "t1", "e1", "summary text");
		const pruned = buildPrunedToolResult(message, record);

		const content = (
			pruned as { content: Array<{ type: string; text: string }> }
		).content;
		expect(content).toHaveLength(1);
		expect(content[0].type).toBe("text");
		const text = content[0].text;
		expect(text).toContain("[COMPACT+ HISTORICAL DATA]");
		expect(text).toContain("Compact+ pruned a previous tool output");
		expect(text).toContain("historical data only");
		expect(text).toContain("summary text");
		expect(text).toContain("t1");
		expect(text).toContain("tc1");
		expect(text).toContain("compact_plus_query_tool_output");
		expect(text).toContain("[/COMPACT+ HISTORICAL DATA]");
		expect(text).not.toContain("the quick brown fox");
	});

	it("includes fallback text when summary is null", () => {
		const message = makeToolResultMessage("tc1", "original output");
		const record = makeRecord("tc1", "t1", "e1", null);
		const pruned = buildPrunedToolResult(message, record);

		const text = (pruned as { content: Array<{ type: string; text: string }> })
			.content[0].text;
		expect(text).toContain("[no summary available]");
		expect(text).toContain("[COMPACT+ HISTORICAL DATA]");
		expect(text).toContain("[/COMPACT+ HISTORICAL DATA]");
	});

	it("does not mutate the original message", () => {
		const message = makeToolResultMessage("tc1", "original output");
		const record = makeRecord("tc1", "t1", "e1", "summary text");
		buildPrunedToolResult(message, record);

		const content = (
			message as { content: Array<{ type: string; text: string }> }
		).content;
		expect(content[0].text).toBe("original output");
	});
});

describe("branch entry record identity matching", () => {
	it("safe matching also rejects toolName mismatches, non-text content, and exclusions", () => {
		const message = makeToolResultMessage("tc1", "output");
		const record = makeRecord("tc1", "t1", "e1", "summary one");

		expect(
			branchEntrySafelyMatchesToolOutputRecord(
				{ id: "e1", message },
				record,
				ENABLED_SETTINGS,
			),
		).toBe(true);
		expect(
			branchEntrySafelyMatchesToolOutputRecord(
				{
					id: "e1",
					message: {
						...(message as object),
						toolName: "python",
					} as AgentMessage,
				},
				record,
				ENABLED_SETTINGS,
			),
		).toBe(false);
		expect(
			branchEntrySafelyMatchesToolOutputRecord(
				{
					id: "e1",
					message: makeToolResult({
						toolCallId: "tc1",
						toolName: "bash",
						image: true,
					}),
				},
				record,
				ENABLED_SETTINGS,
			),
		).toBe(false);
		expect(
			branchEntrySafelyMatchesToolOutputRecord(
				{
					id: "e1",
					message: makeToolResult({
						toolCallId: "tc1",
						toolName: "read",
						text: "output",
					}),
				},
				{ ...record, toolName: "read" },
				ENABLED_SETTINGS,
			),
		).toBe(false);
	});

	it("safe matching honors a non-empty include list", () => {
		const message = makeToolResultMessage("tc1", "output");
		const record = makeRecord("tc1", "t1", "e1", "summary one");
		const settings = {
			...ENABLED_SETTINGS,
			toolOutputPruneIncludedTools: ["python"],
		};

		expect(
			branchEntrySafelyMatchesToolOutputRecord(
				{ id: "e1", message },
				record,
				settings,
			),
		).toBe(false);
	});
});

describe("applyToolOutputPruning", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it("returns undefined when pruning is disabled", () => {
		const messages = [makeToolResultMessage("tc1", "output")];
		const branchEntries = [{ id: "e1", message: messages[0] }];
		expect(
			applyToolOutputPruning(messages, branchEntries, state, DISABLED_SETTINGS),
		).toBeUndefined();
	});

	it("returns undefined when no finalized records exist", () => {
		const messages = [makeToolResultMessage("tc1", "output")];
		const branchEntries = [{ id: "e1", message: messages[0] }];
		expect(
			applyToolOutputPruning(messages, branchEntries, state, ENABLED_SETTINGS),
		).toBeUndefined();
	});

	it("stubs matching tool results by branch identity", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		const msg2 = makeToolResultMessage("tc2", "output two");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const messages = [msg1, msg2];
		const branchEntries = [
			{ id: "e1", message: msg1 },
			{ id: "e2", message: msg2 },
		];

		const result = applyToolOutputPruning(
			messages,
			branchEntries,
			state,
			ENABLED_SETTINGS,
		);

		if (!result) {
			throw new Error("expected pruning result");
		}

		expect(result.prunedCount).toBe(1);
		expect(result.messages).toHaveLength(2);

		const prunedText = (
			result.messages[0] as { content: Array<{ type: string; text: string }> }
		).content[0].text;
		expect(prunedText).toContain("summary one");

		const untouchedText = (
			result.messages[1] as { content: Array<{ type: string; text: string }> }
		).content[0].text;
		expect(untouchedText).toBe("output two");
	});

	it("only stubs records whose entryId is in the current branch", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const messages = [msg1];
		// Branch does not contain e1
		const branchEntries = [{ id: "e99", message: msg1 }];

		const result = applyToolOutputPruning(
			messages,
			branchEntries,
			state,
			ENABLED_SETTINGS,
		);

		expect(result).toBeUndefined();
		expect(state.finalizedRecords).toHaveLength(0);
	});

	it("does not stub when the same entryId has a mismatched role or toolCallId", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		const msg2 = makeToolResultMessage("tc2", "output two");
		state.finalizedRecords.push(
			makeRecord("tc1", "t1", "e1", "summary one"),
			makeRecord("tc2", "t2", "e2", "summary two"),
		);

		const result = applyToolOutputPruning(
			[msg1, msg2],
			[
				{
					id: "e1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "not a tool result" }],
					} as unknown as AgentMessage,
				},
				{ id: "e2", message: makeToolResultMessage("other-tc", "output") },
			],
			state,
			ENABLED_SETTINGS,
		);

		expect(result).toBeUndefined();
		expect(state.finalizedRecords).toHaveLength(0);
	});

	it("fails closed when a context fallback match is ambiguous", () => {
		const branchMessage = makeToolResultMessage("tc1", "branch output");
		const contextMessage1 = makeToolResultMessage("tc1", "context output one");
		const contextMessage2 = makeToolResultMessage("tc1", "context output two");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const result = applyToolOutputPruning(
			[contextMessage1, contextMessage2],
			[{ id: "e1", message: branchMessage }],
			state,
			ENABLED_SETTINGS,
		);

		expect(result).toBeUndefined();
		expect(state.finalizedRecords).toHaveLength(1);
	});

	it("drops finalized records when toolName no longer matches branch", () => {
		const msg = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const result = applyToolOutputPruning(
			[msg],
			[
				{
					id: "e1",
					message: {
						...(msg as object),
						toolName: "python",
					} as AgentMessage,
				},
			],
			state,
			ENABLED_SETTINGS,
		);

		expect(result).toBeUndefined();
		expect(state.finalizedRecords).toHaveLength(0);
	});

	it("updates lastPrunedCount when pruning occurs", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		const msg2 = makeToolResultMessage("tc2", "output two");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));
		state.finalizedRecords.push(makeRecord("tc2", "t2", "e2", "summary two"));

		const messages = [msg1, msg2];
		const branchEntries = [
			{ id: "e1", message: msg1 },
			{ id: "e2", message: msg2 },
		];

		applyToolOutputPruning(messages, branchEntries, state, ENABLED_SETTINGS);

		expect(state.lastPrunedCount).toBe(2);
	});

	it("returns undefined when no messages match", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc99", "t99", "e99", "summary"));

		const messages = [msg1];
		const branchEntries = [{ id: "e1", message: msg1 }];

		expect(
			applyToolOutputPruning(messages, branchEntries, state, ENABLED_SETTINGS),
		).toBeUndefined();
	});

	it("reconciles stale finalized records before pruning", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));
		state.finalizedRecords.push(makeRecord("tc2", "t2", "e2", "summary two"));

		const messages = [msg1];
		// Only e1 is in branch
		const branchEntries = [{ id: "e1", message: msg1 }];

		applyToolOutputPruning(messages, branchEntries, state, ENABLED_SETTINGS);

		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.finalizedRecords[0].toolCallId).toBe("tc1");
	});
});
