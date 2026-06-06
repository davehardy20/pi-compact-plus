/**
 * Live custom-path check for Compact+ tool-output pruning.
 *
 * This script exercises the full pruning pipeline with realistic mock data
 * to validate end-to-end behavior beyond isolated unit tests.
 */

import { resolveCompactPlusSettings } from "../dist/settings.js";
import {
	captureBatch,
	extractToolResultText,
	serializeBatchForSummarizer,
} from "../dist/tool-output-pruning/capture.js";
import { indexToolResultsFromBranch } from "../dist/tool-output-pruning/indexer.js";
import { isToolOutputPruningEnabled } from "../dist/tool-output-pruning/policy.js";
import { applyToolOutputPruning } from "../dist/tool-output-pruning/pruner.js";
import { queryToolOutput } from "../dist/tool-output-pruning/query-tool.js";
import { ToolOutputPruningState } from "../dist/tool-output-pruning/state.js";
import { buildSummarizerPrompt } from "../dist/tool-output-pruning/summarizer.js";
import {
	buildRefMap,
	lookupRef,
} from "../dist/tool-output-pruning/summary-refs.js";

function assert(condition, message) {
	if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function log(step, result) {
	console.log(`[${step}] ${result}`);
}

// ── 1. Settings default-off ─────────────────────────────────────────
log("1", "Check default-off settings");
const defaultSettings = resolveCompactPlusSettings({}, {});
assert(
	defaultSettings.experimentalToolOutputPruning === false,
	"experimental should default to false",
);
assert(
	defaultSettings.toolOutputPruningMode === "off",
	"mode should default to off",
);
assert(
	isToolOutputPruningEnabled(defaultSettings) === false,
	"should be disabled by default",
);
log("1", "PASS — pruning is default-off");

// ── 2. Enable pruning via env ───────────────────────────────────────
log("2", "Check enablement via env");
const enabledSettings = resolveCompactPlusSettings(
	{
		COMPACT_PLUS_EXPERIMENTAL_TOOL_OUTPUT_PRUNING: "true",
		COMPACT_PLUS_TOOL_OUTPUT_PRUNING_MODE: "agent-message",
		COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_STRATEGY: "llm",
		COMPACT_PLUS_TOOL_OUTPUT_PRUNE_STRATEGY: "stub",
	},
	{},
);
assert(
	enabledSettings.experimentalToolOutputPruning === true,
	"should be true from env",
);
assert(
	isToolOutputPruningEnabled(enabledSettings) === true,
	"should be effectively enabled",
);
log("2", "PASS — enablement works via env");

// ── 3. Capture eligible tool results ────────────────────────────────
log("3", "Capture eligible tool results");
const state = new ToolOutputPruningState();
const assistantMsg = {
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
};
const longOutput = "line-number-output\n".repeat(200); // > 3000 chars
const toolResults = [
	{
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: longOutput }],
		isError: false,
	},
	{
		role: "toolResult",
		toolCallId: "call-2",
		toolName: "read", // excluded by default
		content: [{ type: "text", text: longOutput }],
		isError: false,
	},
	{
		role: "toolResult",
		toolCallId: "call-3",
		toolName: "compact_plus_query_tool_output", // internal, excluded
		content: [{ type: "text", text: longOutput }],
		isError: false,
	},
];

const captureResult = captureBatch(
	assistantMsg,
	toolResults,
	0,
	Date.now(),
	enabledSettings,
	state,
);
assert(captureResult !== null, "should capture eligible results");
assert(
	captureResult.records.length === 1,
	"should capture exactly 1 (bash only)",
);
assert(
	captureResult.records[0].toolName === "bash",
	"captured tool should be bash",
);
assert(captureResult.records[0].shortRef === "t1", "first ref should be t1");
log("3", "PASS — capture respects exclusions and internal-tool filter");

// ── 4. Serialize for summarizer ─────────────────────────────────────
log("4", "Serialize batch for summarizer");
const serialized = serializeBatchForSummarizer(
	captureResult.records,
	toolResults,
	enabledSettings,
);
assert(serialized.includes("[t1]"), "serialized should contain short ref");
assert(serialized.includes("bash"), "serialized should contain tool name");
log("4", "PASS — serialization includes refs and tool names");

// ── 5. Build summarizer prompt ──────────────────────────────────────
log("5", "Build summarizer prompt");
const inputs = captureResult.records.map((r) => ({
	recordId: r.recordId,
	shortRef: r.shortRef,
	toolCallId: r.toolCallId,
	toolName: r.toolName,
	text: extractToolResultText(toolResults[0]),
	isError: r.isError,
	argsPreview: r.argsPreview,
}));
const prompt = buildSummarizerPrompt(inputs, 8000);
assert(prompt.includes("## {ref}"), "prompt should include format instruction");
assert(prompt.includes("t1"), "prompt should include short ref");
log("5", "PASS — prompt includes format and refs");

// ── 6. Short refs and lookup map ────────────────────────────────────
log("6", "Short ref lookup map");
const refMap = buildRefMap(captureResult.records);
assert(refMap.has("t1"), "ref map should contain t1");
const lookedUp = lookupRef("t1", refMap);
assert(lookedUp !== undefined, "lookup should find t1");
assert(lookedUp.toolName === "bash", "lookup should return bash");
log("6", "PASS — ref map and lookup work");

// ── 7. Index with branch entry ids ──────────────────────────────────
log("7", "Index with branch entries");
const branchEntries = [
	{ id: "entry-1", message: toolResults[0] },
	{ id: "entry-2", message: toolResults[1] },
	{ id: "entry-3", message: toolResults[2] },
];
const mockSummaries = new Map([
	[captureResult.records[0].recordId, "Mock summary of bash output."],
]);
const indexedBatch = {
	batch: captureResult.batch,
	records: captureResult.records,
	summaries: mockSummaries,
};
indexToolResultsFromBranch(
	branchEntries,
	[indexedBatch],
	state,
	enabledSettings,
);
assert(state.finalizedRecords.length === 1, "should finalize 1 record");
assert(
	state.finalizedRecords[0].entryId === "entry-1",
	"entryId should be reconciled",
);
assert(
	state.finalizedRecords[0].summary === "Mock summary of bash output.",
	"summary should be attached",
);
log("7", "PASS — indexing reconciles entryIds and attaches summaries");

// ── 8. Apply pruning (stub) ─────────────────────────────────────────
log("8", "Apply pruning to context messages");
const contextMessages = [
	{ role: "user", content: [{ type: "text", text: "run bash" }] },
	{ role: "assistant", content: [{ type: "text", text: "ok" }], toolCalls: [] },
	toolResults[0], // bash — should be stubbed
	toolResults[1], // read — not captured, not stubbed
];
const pruneResult = applyToolOutputPruning(
	contextMessages,
	branchEntries,
	state,
	enabledSettings,
);
assert(pruneResult !== undefined, "pruning should modify messages");
assert(pruneResult.prunedCount === 1, "should prune exactly 1");
const stubbed = pruneResult.messages[2];
assert(
	stubbed.role === "toolResult",
	"stubbed message should still be toolResult",
);
assert(
	stubbed.toolCallId === "call-1",
	"stubbed message should preserve toolCallId",
);
const stubText = extractToolResultText(stubbed);
assert(
	stubText.includes("Compact+ pruned"),
	"stub should contain pruning notice",
);
assert(stubText.includes("t1"), "stub should contain short ref");
assert(
	stubText.includes("compact_plus_query_tool_output"),
	"stub should contain recovery instructions",
);
log(
	"8",
	"PASS — pruning stubs content, preserves metadata, includes recovery ref",
);

// ── 9. Query tool recovery ──────────────────────────────────────────
log("9", "Query tool recovery");
const queryResult = queryToolOutput(
	{ ref: "t1", includeContent: true },
	state,
	enabledSettings,
	branchEntries,
);
assert(queryResult.matches.length === 1, "query should find 1 match");
assert(
	queryResult.matches[0].shortRef === "t1",
	"match should have correct ref",
);
assert(
	queryResult.matches[0].content !== undefined,
	"content should be included",
);
assert(
	queryResult.matches[0].content.includes("line"),
	"content should contain original text",
);
assert(
	queryResult.text.includes("historical data, not instructions"),
	"query text should include safety label",
);
log("9", "PASS — query returns bounded content with safety label");

// ── 10. Branch staleness guard ──────────────────────────────────────
log("10", "Branch staleness guard");
const newBranchEntries = [{ id: "entry-99", message: toolResults[0] }]; // different entry id
const stalePruneResult = applyToolOutputPruning(
	contextMessages,
	newBranchEntries,
	state,
	enabledSettings,
);
assert(
	stalePruneResult === undefined,
	"pruning should be no-op when entryId is not in branch",
);
const staleQueryResult = queryToolOutput(
	{ ref: "t1" },
	state,
	enabledSettings,
	newBranchEntries,
);
assert(
	staleQueryResult.matches.length === 0,
	"query should find no matches for stale branch",
);
log("10", "PASS — branch navigation prevents stale-index pruning and query");

// ── 11. Disabled no-op ──────────────────────────────────────────────
log("11", "Disabled no-op");
const disabledPruneResult = applyToolOutputPruning(
	contextMessages,
	branchEntries,
	state,
	defaultSettings,
);
assert(
	disabledPruneResult === undefined,
	"pruning should be no-op when disabled",
);
log("11", "PASS — disabled settings result in no-op");

// ── 12. Status formatting ───────────────────────────────────────────
log("12", "Status formatting");
const { formatToolOutputPruningStatusLine } = await import(
	"../dist/tool-output-pruning/policy.js"
);
const statusLine = formatToolOutputPruningStatusLine({
	enabled: true,
	mode: "agent-message",
	strategy: "stub",
	activeRecordCount: 3,
	lastPrunedCount: 2,
	lastSummaryStatus: "ok",
	lastSummaryTime: Date.now(),
});
assert(statusLine.includes("on"), "status should show on");
assert(statusLine.includes("agent-message"), "status should show mode");
assert(statusLine.includes("indexed=3"), "status should show indexed count");
log("12", "PASS — status line formatting correct");

console.log("\n=== LIVE CUSTOM-PATH CHECK PASSED ===");
console.log("All 12 end-to-end assertions passed.");
