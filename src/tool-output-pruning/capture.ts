import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	extractMessageText,
	getDetails,
	getIsError,
	getToolCallId,
	getToolName,
	isTextOnlyMessageContent,
} from "../pi-messages.js";
import { QUERY_TOOL_OUTPUT_TOOL_NAME } from "../types.js";
import type { ToolOutputPruningState } from "./state.js";
import {
	MAX_RECORDS_PER_BATCH,
	type PendingToolOutputBatch,
	type ToolOutputPruningSettings,
	type ToolOutputRecord,
} from "./types.js";

/**
 * Protected tool exclusions that cannot be overridden by user settings.
 * These tools are critical for exact-output workflows and must never be pruned.
 */
export const PROTECTED_EXCLUDED_TOOLS: readonly string[] = [
	"read",
	"read_hashed",
	"hashline_edit",
	QUERY_TOOL_OUTPUT_TOOL_NAME,
];

export interface CaptureBatchResult {
	batch: PendingToolOutputBatch;
	records: ToolOutputRecord[];
}

const FALLBACK_SNIPPETS_MAX_CHARS = 400;
const ARGS_PREVIEW_MAX_CHARS = 200;

/**
 * Extract plain text from a toolResult message content array.
 * Returns empty string for non-toolResult or non-text content.
 */
export function extractToolResultText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return extractMessageText(message, "");
}

/**
 * Determine whether a toolResult message contains only text blocks.
 * Returns false for image, binary, mixed, or empty content.
 */
export function isTextOnlyToolResult(message: AgentMessage): boolean {
	if (message.role !== "toolResult") return false;
	return isTextOnlyMessageContent(message);
}

/**
 * Detect whether a tool name belongs to Compact+ internal tooling.
 * Prevents recursive indexing of Compact+ query, summary, index, or stats.
 */
export function isCompactPlusInternalTool(toolName: string): boolean {
	return (
		toolName === QUERY_TOOL_OUTPUT_TOOL_NAME ||
		toolName.startsWith("compact_plus")
	);
}

/**
 * Check whether a tool name is excluded from pruning.
 * Checks protected exclusions (non-overridable), internal tools, and
 * user-configured exclusions.
 */
export function isExcludedTool(
	toolName: string,
	settings: ToolOutputPruningSettings,
): boolean {
	if (PROTECTED_EXCLUDED_TOOLS.includes(toolName)) return true;
	if (isCompactPlusInternalTool(toolName)) return true;
	if (settings.toolOutputPruneExcludedTools.includes(toolName)) return true;
	return false;
}

/**
 * Check whether a toolResult message is eligible for pruning capture.
 *
 * Eligibility rules:
 * - Must be a toolResult with text-only content
 * - Must not be from a Compact+ internal tool
 * - Must not be in the protected or user-configured excluded-tools list
 * - If included-tools is non-empty, must be in that list
 * - Total text length must meet the minimum threshold
 */
export function isEligibleToolResult(
	message: AgentMessage,
	settings: ToolOutputPruningSettings,
): boolean {
	if (message.role !== "toolResult") return false;

	const toolName = getToolName(message) ?? "";
	if (isExcludedTool(toolName, settings)) return false;
	if (
		settings.toolOutputPruneIncludedTools.length > 0 &&
		!settings.toolOutputPruneIncludedTools.includes(toolName)
	) {
		return false;
	}
	if (!isTextOnlyToolResult(message)) return false;

	const text = extractToolResultText(message);
	if (text.length < settings.toolOutputPruneMinChars) return false;

	return true;
}

/**
 * Build a bounded preview of tool arguments from the result details field.
 */
export function buildArgsPreview(
	message: AgentMessage,
	maxChars = ARGS_PREVIEW_MAX_CHARS,
): string | null {
	if (message.role !== "toolResult") return null;
	const details = getDetails(message);
	if (details === undefined || details === null) return null;

	let preview: string;
	try {
		preview = JSON.stringify(details);
	} catch {
		return null;
	}

	if (preview.length > maxChars) {
		return `${preview.slice(0, Math.max(0, maxChars - 1))}…`;
	}
	return preview;
}

/**
 * Build bounded first/last fallback snippets from tool output text.
 * Useful for recovery/search when the full original is needed.
 */
export function buildFallbackSnippets(
	text: string,
	maxChars = FALLBACK_SNIPPETS_MAX_CHARS,
): string | null {
	if (text.length === 0) return null;
	if (text.length <= maxChars) return text;

	const headSize = Math.floor(maxChars * 0.4);
	const tailSize = Math.floor(maxChars * 0.4);
	const separator = "\n…\n";

	return `${text.slice(0, headSize)}${separator}${text.slice(-tailSize)}`;
}

/**
 * Capture a batch of eligible tool results for later summarization.
 *
 * Returns `null` if none of the provided tool results are eligible.
 * Generates stable record IDs and short refs via the provided state.
 *
 * Adapted from pi-context-prune (MIT-licensed prior art) into Compact+.
 */
export function captureBatch(
	assistantMessage: AgentMessage,
	toolResults: AgentMessage[],
	turnIndex: number,
	timestamp: number,
	settings: ToolOutputPruningSettings,
	state: ToolOutputPruningState,
): CaptureBatchResult | null {
	if (assistantMessage.role !== "assistant") return null;

	let eligibleResults = toolResults.filter((tr) =>
		isEligibleToolResult(tr, settings),
	);
	if (eligibleResults.length === 0) return null;
	if (eligibleResults.length > MAX_RECORDS_PER_BATCH) {
		eligibleResults = eligibleResults.slice(0, MAX_RECORDS_PER_BATCH);
	}

	const batchId = `batch-${turnIndex}-${timestamp}`;
	const records: ToolOutputRecord[] = [];
	const recordIds: string[] = [];

	for (const result of eligibleResults) {
		const toolCallId = getToolCallId(result) ?? "";
		const toolName = getToolName(result) ?? "";
		const text = extractToolResultText(result);
		const isError = getIsError(result);

		const recordId = `rec-${toolCallId}-${timestamp}`;
		const shortRef = state.generateShortRef();

		const record: ToolOutputRecord = {
			recordId,
			entryId: null,
			toolCallId,
			toolName,
			timestamp,
			chars: text.length,
			isError,
			summary: null,
			shortRef,
			argsPreview: buildArgsPreview(result),
			fallbackSnippets: buildFallbackSnippets(text),
		};

		records.push(record);
		recordIds.push(recordId);
	}

	const batch: PendingToolOutputBatch = {
		batchId,
		turnIndex,
		timestamp,
		recordIds,
	};

	return { batch, records };
}

/**
 * Serialize captured records and their associated tool results into a
 * bounded string suitable for LLM summarization.
 *
 * Each record is rendered with its short ref, tool name, bounded args
 * preview, and bounded output text.
 */
export function serializeBatchForSummarizer(
	records: ToolOutputRecord[],
	toolResults: AgentMessage[],
	settings: ToolOutputPruningSettings,
): string {
	const maxChars = settings.toolOutputSummaryMaxChars;
	const parts: string[] = [];

	for (const record of records) {
		const toolResult = toolResults.find(
			(tr) => getToolCallId(tr) === record.toolCallId,
		);
		if (!toolResult) continue;

		const text = extractToolResultText(toolResult);
		const boundedText =
			text.length > maxChars
				? `${text.slice(0, Math.max(0, maxChars - 1))}…`
				: text;

		const header = `[${record.shortRef}] ${record.toolName} (toolCallId: ${record.toolCallId})`;
		parts.push(header);

		if (record.argsPreview) {
			parts.push(`args: ${record.argsPreview}`);
		}

		parts.push(boundedText);
		parts.push("");
	}

	return parts.join("\n").trim();
}
