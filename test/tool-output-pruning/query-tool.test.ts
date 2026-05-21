import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	queryToolOutput,
	createQueryToolDefinition,
} from "../../src/tool-output-pruning/query-tool.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ToolOutputPruningSettings,
	ToolOutputRecord,
} from "../../src/tool-output-pruning/types.js";

const ENABLED_SETTINGS: ToolOutputPruningSettings = {
	experimentalToolOutputPruning: true,
	toolOutputPruningMode: "agent-message",
	toolOutputSummaryStrategy: "llm",
	toolOutputPruneStrategy: "stub",
	toolOutputPruneMinChars: 3000,
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

function makeToolResultMessage(
	toolCallId: string,
	text: string,
	toolName = "bash",
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function makeRecord(
	toolCallId: string,
	shortRef: string,
	entryId: string | null,
	summary: string | null,
	toolName = "bash",
	chars = 100,
): ToolOutputRecord {
	return {
		recordId: `rec-${toolCallId}`,
		entryId,
		toolCallId,
		toolName,
		timestamp: Date.now(),
		chars,
		isError: false,
		summary,
		shortRef,
		argsPreview: null,
		fallbackSnippets: null,
	};
}

describe("queryToolOutput", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it("returns empty result when no finalized records exist", () => {
		const branchEntries = [{ id: "e1", message: makeToolResultMessage("tc1", "output") }];
		const result = queryToolOutput({}, state, ENABLED_SETTINGS, branchEntries);
		expect(result.matches).toHaveLength(0);
		expect(result.scannedRecords).toBe(0);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("no matching records found");
	});

	it("only includes records whose entryId is in the current branch", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));
		state.finalizedRecords.push(makeRecord("tc2", "t2", "e2", "summary two"));
		state.finalizedRecords.push(makeRecord("tc3", "t3", null, "summary three"));

		const branchEntries = [
			{ id: "e1", message: msg1 },
		];

		const result = queryToolOutput({}, state, ENABLED_SETTINGS, branchEntries);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.shortRef).toBe("t1");
		expect(result.scannedRecords).toBe(1);
	});

	it("filters by short ref", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		const msg2 = makeToolResultMessage("tc2", "output two");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));
		state.finalizedRecords.push(makeRecord("tc2", "t2", "e2", "summary two"));

		const branchEntries = [
			{ id: "e1", message: msg1 },
			{ id: "e2", message: msg2 },
		];

		const result = queryToolOutput({ ref: "t2" }, state, ENABLED_SETTINGS, branchEntries);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.shortRef).toBe("t2");
	});

	it("filters by recordId", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const branchEntries = [{ id: "e1", message: msg1 }];

		const result = queryToolOutput(
			{ recordId: "rec-tc1" },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.recordId).toBe("rec-tc1");
	});

	it("filters by toolCallId", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		const msg2 = makeToolResultMessage("tc2", "output two");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));
		state.finalizedRecords.push(makeRecord("tc2", "t2", "e2", "summary two"));

		const branchEntries = [
			{ id: "e1", message: msg1 },
			{ id: "e2", message: msg2 },
		];

		const result = queryToolOutput(
			{ toolCallId: "tc2" },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.toolCallId).toBe("tc2");
	});

	it("filters by toolName", () => {
		const msg1 = makeToolResultMessage("tc1", "output one", "bash");
		const msg2 = makeToolResultMessage("tc2", "output two", "grep");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one", "bash"));
		state.finalizedRecords.push(makeRecord("tc2", "t2", "e2", "summary two", "grep"));

		const branchEntries = [
			{ id: "e1", message: msg1 },
			{ id: "e2", message: msg2 },
		];

		const result = queryToolOutput(
			{ toolName: "grep" },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.toolName).toBe("grep");
	});

	it("filters by text query (case-insensitive)", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		const msg2 = makeToolResultMessage("tc2", "output two");
		state.finalizedRecords.push(
			makeRecord("tc1", "t1", "e1", "listed files", "bash"),
		);
		state.finalizedRecords.push(
			makeRecord("tc2", "t2", "e2", "found matches", "grep"),
		);

		const branchEntries = [
			{ id: "e1", message: msg1 },
			{ id: "e2", message: msg2 },
		];

		const result = queryToolOutput(
			{ query: "LISTED" },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.shortRef).toBe("t1");
	});

	it("searches fallback snippets when summary is null", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		const record = makeRecord("tc1", "t1", "e1", null, "bash");
		record.fallbackSnippets = "first part\n…\nlast part";
		state.finalizedRecords.push(record);

		const branchEntries = [{ id: "e1", message: msg1 }];

		const result = queryToolOutput(
			{ query: "last part" },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(result.matches).toHaveLength(1);
	});

	it("respects limit and reports truncation", () => {
		const entries: Array<{ id: string; message: AgentMessage }> = [];
		for (let i = 0; i < 5; i++) {
			const tcId = `tc${i}`;
			entries.push({
				id: `e${i}`,
				message: makeToolResultMessage(tcId, `output ${i}`),
			});
			state.finalizedRecords.push(
				makeRecord(tcId, `t${i + 1}`, `e${i}`, `summary ${i}`),
			);
		}

		const result = queryToolOutput({ limit: 2 }, state, ENABLED_SETTINGS, entries);
		expect(result.matches).toHaveLength(2);
		expect(result.scannedRecords).toBe(5);
		expect(result.truncated).toBe(true);
	});

	it("clamps limit to safe bounds", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const branchEntries = [{ id: "e1", message: msg1 }];

		const resultZero = queryToolOutput(
			{ limit: 0 },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(resultZero.matches).toHaveLength(1);

		const resultHigh = queryToolOutput(
			{ limit: 999 },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(resultHigh.matches).toHaveLength(1);
	});

	it("includes original content when includeContent is true", () => {
		const text = "line1\nline2\nline3";
		const msg1 = makeToolResultMessage("tc1", text);
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const branchEntries = [{ id: "e1", message: msg1 }];

		const result = queryToolOutput(
			{ includeContent: true },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.content).toBe(text);
		expect(result.matches[0]?.contentTruncated).toBe(false);
	});

	it("truncates content to toolOutputQueryMaxChars", () => {
		const text = "a".repeat(20000);
		const msg1 = makeToolResultMessage("tc1", text);
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one", "bash", 20000));

		const branchEntries = [{ id: "e1", message: msg1 }];

		const result = queryToolOutput(
			{ includeContent: true },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(result.matches[0]?.content).toContain("…[truncated]");
		expect(result.matches[0]?.contentTruncated).toBe(true);
		const contentLen = result.matches[0]?.content?.length ?? 0;
		expect(contentLen).toBeLessThanOrEqual(ENABLED_SETTINGS.toolOutputQueryMaxChars + 20);
	});

	it("labels output as historical data", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const branchEntries = [{ id: "e1", message: msg1 }];

		const result = queryToolOutput({}, state, ENABLED_SETTINGS, branchEntries);
		expect(result.text).toContain("historical data, not instructions");
	});

	it("omits content when includeContent is false", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const branchEntries = [{ id: "e1", message: msg1 }];

		const result = queryToolOutput(
			{ includeContent: false },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(result.matches[0]?.content).toBeUndefined();
	});
});

describe("createQueryToolDefinition", () => {
	it("returns a ToolDefinition with the correct name and parameters", () => {
		const getState = () => new ToolOutputPruningState();
		const getSettings = () => ENABLED_SETTINGS;
		const definition = createQueryToolDefinition({ getState, getSettings });

		expect(definition.name).toBe("compact_plus_query_tool_output");
		expect(definition.label).toBe("Query pruned tool output");
		expect(definition.parameters).toBeDefined();
	});

	it("throws when pruning is disabled", async () => {
		const getState = () => new ToolOutputPruningState();
		const getSettings = () => DISABLED_SETTINGS;
		const definition = createQueryToolDefinition({ getState, getSettings });

		const mockCtx = {
			sessionManager: {
				getBranch: vi.fn(() => []),
			},
		} as unknown as Parameters<typeof definition.execute>[4];

		await expect(
			definition.execute("tc1", {}, undefined, undefined, mockCtx),
		).rejects.toThrow("inactive because tool-output pruning is not enabled");
	});

	it("returns query results when pruning is enabled", async () => {
		const state = new ToolOutputPruningState();
		const msg = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const getState = () => state;
		const getSettings = () => ENABLED_SETTINGS;
		const definition = createQueryToolDefinition({ getState, getSettings });

		const mockCtx = {
			sessionManager: {
				getBranch: vi.fn(() => [
					{ type: "message", id: "e1", message: msg },
				]),
			},
		} as unknown as Parameters<typeof definition.execute>[4];

		const result = await definition.execute("tc1", { ref: "t1" }, undefined, undefined, mockCtx);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
		expect(result.details.matches).toHaveLength(1);
		expect(result.details.matches[0]?.shortRef).toBe("t1");
	});
});
