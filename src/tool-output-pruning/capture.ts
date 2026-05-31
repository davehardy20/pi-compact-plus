import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getDetails, getToolCallId } from "../pi-messages.js";
import {
	extractToolResultText,
	getPrunableToolResult,
	isCompactPlusInternalTool,
	isExcludedTool,
	isTextOnlyToolResult,
	PROTECTED_EXCLUDED_TOOLS,
} from "./record-identity.js";
import type { ToolOutputPruningState } from "./state.js";
import {
	MAX_RECORDS_PER_BATCH,
	type PendingToolOutputBatch,
	type ToolOutputPruningSettings,
	type ToolOutputRecord,
} from "./types.js";

export {
	extractToolResultText,
	isCompactPlusInternalTool,
	isExcludedTool,
	isTextOnlyToolResult,
	PROTECTED_EXCLUDED_TOOLS,
} from "./record-identity.js";

export interface CaptureBatchResult {
	batch: PendingToolOutputBatch;
	records: ToolOutputRecord[];
}

const FALLBACK_SNIPPETS_MAX_CHARS = 400;
const ARGS_PREVIEW_MAX_CHARS = 200;

/**
 * Check whether a toolResult message is eligible for pruning capture.
 *
 * Eligibility rules are owned by the shared record identity seam; this wrapper
 * preserves the existing capture module API.
 */
export function isEligibleToolResult(
	message: AgentMessage,
	settings: ToolOutputPruningSettings,
): boolean {
	return getPrunableToolResult(message, settings) !== null;
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

	let eligibleResults = toolResults
		.map((tr) => getPrunableToolResult(tr, settings))
		.filter((result) => result !== null);
	if (eligibleResults.length === 0) return null;
	if (eligibleResults.length > MAX_RECORDS_PER_BATCH) {
		eligibleResults = eligibleResults.slice(0, MAX_RECORDS_PER_BATCH);
	}

	const batchId = `batch-${turnIndex}-${timestamp}`;
	const records: ToolOutputRecord[] = [];
	const recordIds: string[] = [];

	for (const result of eligibleResults) {
		const { message, toolCallId, toolName, text, chars, isError } = result;

		const recordId = `rec-${toolCallId}-${timestamp}`;
		const shortRef = state.generateShortRef();

		const record: ToolOutputRecord = {
			recordId,
			entryId: null,
			toolCallId,
			toolName,
			timestamp,
			chars,
			isError,
			summary: null,
			shortRef,
			argsPreview: buildArgsPreview(message),
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
