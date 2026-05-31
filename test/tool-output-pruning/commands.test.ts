import { describe, expect, it } from "vitest";
import {
	buildPruningOneLineStatus,
	buildPruningStatusDetail,
	formatPruningStatusLines,
} from "../../src/tool-output-pruning/commands.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import type { ToolOutputPruningSettings } from "../../src/tool-output-pruning/types.js";

function makeSettings(
	overrides: Partial<ToolOutputPruningSettings> = {},
): ToolOutputPruningSettings {
	return {
		experimentalToolOutputPruning: false,
		toolOutputPruningMode: "off",
		toolOutputSummaryStrategy: "llm",
		toolOutputPruneStrategy: "stub",
		toolOutputPruneMinChars: 200,
		toolOutputSummaryMaxChars: 800,
		toolOutputQueryMaxChars: 12000,
		toolOutputSummarizerModel: "default",
		toolOutputSummarizerThinking: "default",
		toolOutputPruneExcludedTools: ["read", "read_hashed"],
		toolOutputPruneIncludedTools: [],
		...overrides,
	};
}

describe("buildPruningStatusDetail", () => {
	it("reports disabled when experimental flag is false", () => {
		const state = new ToolOutputPruningState();
		const settings = makeSettings();
		const detail = buildPruningStatusDetail({ state, settings });
		expect(detail.enabled).toBe(false);
		expect(detail.mode).toBe("off");
	});

	it("reports enabled when all conditions are met", () => {
		const state = new ToolOutputPruningState();
		const settings = makeSettings({
			experimentalToolOutputPruning: true,
			toolOutputPruningMode: "agent-message",
		});
		const detail = buildPruningStatusDetail({ state, settings });
		expect(detail.enabled).toBe(true);
		expect(detail.mode).toBe("agent-message");
		expect(detail.strategy).toBe("stub");
		expect(detail.summaryStrategy).toBe("llm");
	});

	it("reflects state counters", () => {
		const state = new ToolOutputPruningState();
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: ["r1"],
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
		state.finalizedRecords.push({
			recordId: "r2",
			entryId: "entry-1",
			toolCallId: "tc2",
			toolName: "read",
			timestamp: Date.now(),
			chars: 200,
			isError: false,
			summary: "summary",
			shortRef: "t2",
			argsPreview: null,
			fallbackSnippets: null,
		});

		const settings = makeSettings({
			experimentalToolOutputPruning: true,
			toolOutputPruningMode: "agent-message",
		});
		const detail = buildPruningStatusDetail({ state, settings });
		expect(detail.pendingBatchCount).toBe(1);
		expect(detail.pendingRecordCount).toBe(1);
		expect(detail.activeRecordCount).toBe(1);
	});
});

describe("formatPruningStatusLines", () => {
	it("formats disabled status concisely", () => {
		const detail = buildPruningStatusDetail({
			state: new ToolOutputPruningState(),
			settings: makeSettings(),
		});
		const lines = formatPruningStatusLines(detail);
		expect(lines[0]).toBe("Tool-output pruning:");
		expect(lines.some((l) => l.includes("off (experimental)"))).toBe(true);
		expect(lines.some((l) => l.includes("Mode: off"))).toBe(true);
		expect(lines.some((l) => l.includes("/reload is safest after edits"))).toBe(
			true,
		);
	});

	it("formats enabled status with all fields", () => {
		const state = new ToolOutputPruningState();
		state.lastSummaryStatus = "ok";
		state.lastSummaryTime = Date.now();
		state.lastPrunedCount = 3;
		const detail = buildPruningStatusDetail({
			state,
			settings: makeSettings({
				experimentalToolOutputPruning: true,
				toolOutputPruningMode: "agent-message",
			}),
		});
		const lines = formatPruningStatusLines(detail);
		expect(lines.some((l) => l.includes("Status: on (experimental)"))).toBe(
			true,
		);
		expect(lines.some((l) => l.includes("agent-message"))).toBe(true);
		expect(lines.some((l) => l.includes("stub"))).toBe(true);
		expect(lines.some((l) => l.includes("Last pruned count: 3"))).toBe(true);
		expect(lines.some((l) => l.includes("/reload is safest after edits"))).toBe(
			true,
		);
		const protectedLine = lines.find((l) => l.includes("Protected exclusions"));
		expect(protectedLine).toContain("read");
		expect(protectedLine).toContain("compact_plus_query_tool_output");
		expect(lines.some((l) => l.includes("User excluded tools:"))).toBe(true);
	});
});

describe("buildPruningOneLineStatus", () => {
	it("returns off when disabled", () => {
		const state = new ToolOutputPruningState();
		const settings = makeSettings();
		expect(buildPruningOneLineStatus(state, settings)).toBe("off");
	});

	it("returns compact status when enabled", () => {
		const state = new ToolOutputPruningState();
		state.finalizedRecords.push({
			recordId: "r1",
			entryId: "e1",
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: "s",
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
		state.pendingRecords.push({
			recordId: "r2",
			entryId: null,
			toolCallId: "tc2",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: null,
			shortRef: "t2",
			argsPreview: null,
			fallbackSnippets: null,
		});
		const settings = makeSettings({
			experimentalToolOutputPruning: true,
			toolOutputPruningMode: "agent-message",
		});
		const status = buildPruningOneLineStatus(state, settings);
		expect(status).toContain("indexed=1");
		expect(status).toContain("pending=1");
	});
});
