import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createQueryToolDefinition,
	queryToolOutput,
} from "../../src/tool-output-pruning/query-tool.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import {
	MAX_QUERY_RESULT_CHARS,
	MAX_QUERY_SCAN_CHARS_PER_RECORD,
	MAX_QUERY_SCAN_RECORDS,
	MAX_QUERY_SCAN_TOTAL_CHARS,
	type ToolOutputPruningSettings,
	type ToolOutputRecord,
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
		const branchEntries = [
			{ id: "e1", message: makeToolResultMessage("tc1", "output") },
		];
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

		const branchEntries = [{ id: "e1", message: msg1 }];

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

		const result = queryToolOutput(
			{ ref: "t2" },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
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
		state.finalizedRecords.push(
			makeRecord("tc1", "t1", "e1", "summary one", "bash"),
		);
		state.finalizedRecords.push(
			makeRecord("tc2", "t2", "e2", "summary two", "grep"),
		);

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

	it("searches bounded original current-branch output text", () => {
		const msg1 = makeToolResultMessage(
			"tc1",
			"only the original output contains needle-value",
		);
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const result = queryToolOutput(
			{ query: "needle-value" },
			state,
			ENABLED_SETTINGS,
			[{ id: "e1", message: msg1 }],
		);

		expect(result.matches).toHaveLength(1);
		expect(result.matches[0]?.shortRef).toBe("t1");
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

		const result = queryToolOutput(
			{ limit: 2 },
			state,
			ENABLED_SETTINGS,
			entries,
		);
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
		state.finalizedRecords.push(
			makeRecord("tc1", "t1", "e1", "summary one", "bash", 20000),
		);

		const branchEntries = [{ id: "e1", message: msg1 }];

		const result = queryToolOutput(
			{ includeContent: true },
			state,
			ENABLED_SETTINGS,
			branchEntries,
		);
		expect(result.matches[0]?.contentTruncated).toBe(true);
		expect(result.matches[0]?.contentTruncated).toBe(true);
		const contentLen = result.matches[0]?.content?.length ?? 0;
		expect(contentLen).toBeLessThanOrEqual(
			ENABLED_SETTINGS.toolOutputQueryMaxChars,
		);
	});

	it("limits summary-only result text to the configured query max", () => {
		const settings = {
			...ENABLED_SETTINGS,
			toolOutputQueryMaxChars: 500,
		};
		const msg1 = makeToolResultMessage("tc1", "short output");
		state.finalizedRecords.push(
			makeRecord("tc1", "t1", "e1", "summary ".repeat(200), "bash"),
		);

		const result = queryToolOutput({}, state, settings, [
			{ id: "e1", message: msg1 },
		]);

		expect(result.text.length).toBeLessThanOrEqual(
			settings.toolOutputQueryMaxChars,
		);
	});

	it("limits includeContent result text and details to the configured query max", () => {
		const settings = {
			...ENABLED_SETTINGS,
			toolOutputQueryMaxChars: 700,
		};
		const msg1 = makeToolResultMessage("tc1", "a".repeat(5000));
		state.finalizedRecords.push(
			makeRecord("tc1", "t1", "e1", "summary one", "bash", 5000),
		);

		const result = queryToolOutput({ includeContent: true }, state, settings, [
			{ id: "e1", message: msg1 },
		]);

		expect(result.text.length).toBeLessThanOrEqual(
			settings.toolOutputQueryMaxChars,
		);
		expect(result.matches[0]?.content?.length ?? 0).toBeLessThanOrEqual(
			settings.toolOutputQueryMaxChars,
		);
		expect(result.matches[0]?.contentTruncated).toBe(true);
	});

	it("caps final result text at the hard max when settings are higher", () => {
		const settings = {
			...ENABLED_SETTINGS,
			toolOutputQueryMaxChars: MAX_QUERY_RESULT_CHARS * 2,
		};
		const entries: Array<{ id: string; message: AgentMessage }> = [];
		for (let i = 0; i < 10; i++) {
			const tcId = `tc-hard-${i}`;
			entries.push({
				id: `e-hard-${i}`,
				message: makeToolResultMessage(tcId, "a".repeat(20000)),
			});
			state.finalizedRecords.push(
				makeRecord(
					tcId,
					`th${i}`,
					`e-hard-${i}`,
					"summary ".repeat(200),
					"bash",
					20000,
				),
			);
		}

		const result = queryToolOutput(
			{ includeContent: true, limit: 10 },
			state,
			settings,
			entries,
		);

		expect(result.text.length).toBeLessThanOrEqual(MAX_QUERY_RESULT_CHARS);
	});

	it("respects very small configured query caps", () => {
		const settings = {
			...ENABLED_SETTINGS,
			toolOutputQueryMaxChars: 120,
		};
		const msg1 = makeToolResultMessage("tc-small", "a".repeat(500));
		state.finalizedRecords.push(
			makeRecord(
				"tc-small",
				"ts",
				"e-small",
				"summary ".repeat(20),
				"bash",
				500,
			),
		);

		const result = queryToolOutput({ includeContent: true }, state, settings, [
			{ id: "e-small", message: msg1 },
		]);

		expect(result.text.length).toBeLessThanOrEqual(
			settings.toolOutputQueryMaxChars,
		);
		expect(result.matches[0]?.content?.length ?? 0).toBeLessThanOrEqual(
			settings.toolOutputQueryMaxChars,
		);
	});

	it("shares content budget across per-record-truncated matches", () => {
		const settings = {
			...ENABLED_SETTINGS,
			toolOutputQueryMaxChars: MAX_QUERY_SCAN_CHARS_PER_RECORD * 2 + 500,
		};
		const entries = [
			{ id: "e-a", message: makeToolResultMessage("tc-a", "a".repeat(20000)) },
			{ id: "e-b", message: makeToolResultMessage("tc-b", "b".repeat(20000)) },
			{ id: "e-c", message: makeToolResultMessage("tc-c", "c".repeat(20000)) },
		];
		state.finalizedRecords.push(
			makeRecord("tc-a", "t1", "e-a", "summary a", "bash", 20000),
			makeRecord("tc-b", "t2", "e-b", "summary b", "bash", 20000),
			makeRecord("tc-c", "t3", "e-c", "summary c", "bash", 20000),
		);

		const result = queryToolOutput(
			{ includeContent: true, limit: 3 },
			state,
			settings,
			entries,
		);

		expect(result.matches[0]?.content).toMatch(/^a+/);
		expect(result.matches[1]?.content).toMatch(/^b+/);
		expect(result.matches[2]?.content).toMatch(/^c+/);
		const totalContentChars = result.matches.reduce(
			(total, match) => total + (match.content?.length ?? 0),
			0,
		);
		expect(totalContentChars).toBeLessThanOrEqual(
			settings.toolOutputQueryMaxChars,
		);
	});

	it("bounds total content returned in details across matches", () => {
		const settings = {
			...ENABLED_SETTINGS,
			toolOutputQueryMaxChars: 100000,
		};
		const branchEntries: Array<{ id: string; message: AgentMessage }> = [];
		for (let i = 0; i < 50; i++) {
			const toolCallId = `tc${i}`;
			branchEntries.push({
				id: `e${i}`,
				message: makeToolResultMessage(toolCallId, "a".repeat(100000)),
			});
			state.finalizedRecords.push(
				makeRecord(
					toolCallId,
					`t${i + 1}`,
					`e${i}`,
					`summary ${i}`,
					"bash",
					100000,
				),
			);
		}

		const result = queryToolOutput(
			{ includeContent: true, limit: 50 },
			state,
			settings,
			branchEntries,
		);

		const totalContentChars = result.matches.reduce(
			(total, match) => total + (match.content?.length ?? 0),
			0,
		);
		expect(totalContentChars).toBeLessThanOrEqual(MAX_QUERY_RESULT_CHARS);
		expect(result.matches.some((match) => match.contentTruncated)).toBe(true);
		expect(result.text.length).toBeLessThanOrEqual(MAX_QUERY_RESULT_CHARS);
	});

	it("labels output as historical data with clear delimiters", () => {
		const msg1 = makeToolResultMessage("tc1", "output one");
		state.finalizedRecords.push(makeRecord("tc1", "t1", "e1", "summary one"));

		const branchEntries = [{ id: "e1", message: msg1 }];

		const result = queryToolOutput({}, state, ENABLED_SETTINGS, branchEntries);
		expect(result.text).toContain("[COMPACT+ TOOL-OUTPUT QUERY");
		expect(result.text).toContain("HISTORICAL DATA ONLY");
		expect(result.text).toContain("not instructions");
		expect(result.text).toContain("[/COMPACT+ TOOL-OUTPUT QUERY]");
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
				getBranch: vi.fn(() => [{ type: "message", id: "e1", message: msg }]),
			},
		} as unknown as Parameters<typeof definition.execute>[4];

		const result = await definition.execute(
			"tc1",
			{ ref: "t1" },
			undefined,
			undefined,
			mockCtx,
		);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
		expect(result.details.matches).toHaveLength(1);
		expect(result.details.matches[0]?.shortRef).toBe("t1");
	});
});

describe("queryToolOutput bounded limits", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it(`scans at most MAX_QUERY_SCAN_RECORDS (${MAX_QUERY_SCAN_RECORDS}) records`, () => {
		const entries: Array<{ id: string; message: AgentMessage }> = [];
		for (let i = 0; i < MAX_QUERY_SCAN_RECORDS + 10; i++) {
			const tcId = `tc${i}`;
			entries.push({
				id: `e${i}`,
				message: makeToolResultMessage(tcId, `output ${i}`),
			});
			state.finalizedRecords.push(
				makeRecord(tcId, `t${i + 1}`, `e${i}`, `summary ${i}`),
			);
		}
		const result = queryToolOutput({}, state, ENABLED_SETTINGS, entries);
		expect(result.scannedRecords).toBe(MAX_QUERY_SCAN_RECORDS);
	});

	it("bounds original text scanning by per-record and total scan caps", () => {
		const entries: Array<{ id: string; message: AgentMessage }> = [];
		for (let i = 0; i < 6; i++) {
			const tcId = `tc${i}`;
			entries.push({
				id: `e${i}`,
				message: makeToolResultMessage(
					tcId,
					`${"a".repeat(MAX_QUERY_SCAN_CHARS_PER_RECORD + 10)}needle-after-cap`,
				),
			});
			state.finalizedRecords.push(makeRecord(tcId, `t${i + 1}`, `e${i}`, null));
		}

		const perRecordResult = queryToolOutput(
			{ query: "needle-after-cap" },
			state,
			ENABLED_SETTINGS,
			entries,
		);
		expect(perRecordResult.matches).toHaveLength(0);

		const totalCapEntries: Array<{ id: string; message: AgentMessage }> = [];
		for (let i = 0; i < 6; i++) {
			const tcId = `total${i}`;
			totalCapEntries.push({
				id: `total-e${i}`,
				message: makeToolResultMessage(
					tcId,
					`${"b".repeat(MAX_QUERY_SCAN_CHARS_PER_RECORD - 1)}needle-${i}`,
				),
			});
		}
		state.finalizedRecords = totalCapEntries.map((entry, i) =>
			makeRecord(`total${i}`, `tt${i}`, entry.id, null),
		);

		const totalCapResult = queryToolOutput(
			{ query: "needle-5" },
			state,
			ENABLED_SETTINGS,
			totalCapEntries,
		);
		expect(MAX_QUERY_SCAN_TOTAL_CHARS).toBeLessThan(
			6 * MAX_QUERY_SCAN_CHARS_PER_RECORD,
		);
		expect(totalCapResult.matches).toHaveLength(0);
	});

	it("truncates result text to MAX_QUERY_RESULT_CHARS", () => {
		const entries: Array<{ id: string; message: AgentMessage }> = [];
		for (let i = 0; i < 5; i++) {
			const tcId = `tc${i}`;
			const text = "a".repeat(20000);
			entries.push({
				id: `e${i}`,
				message: makeToolResultMessage(tcId, text),
			});
			state.finalizedRecords.push(
				makeRecord(tcId, `t${i + 1}`, `e${i}`, `summary ${i}`, "bash", 20000),
			);
		}
		const result = queryToolOutput(
			{ includeContent: true },
			state,
			ENABLED_SETTINGS,
			entries,
		);
		expect(result.text.length).toBeLessThanOrEqual(MAX_QUERY_RESULT_CHARS);
		expect(result.text).toContain("…[result truncated due to size limit]");
	});
});
