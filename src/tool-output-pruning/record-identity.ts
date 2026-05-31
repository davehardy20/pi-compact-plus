import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	extractMessageText,
	getDetails,
	getIsError,
	getTextContentBlocks,
	getToolCallId,
	getToolName,
	isTextOnlyMessageContent,
	isToolResultMessage,
} from "../pi-messages.js";
import { QUERY_TOOL_OUTPUT_TOOL_NAME } from "../types.js";
import type { ToolOutputPruningSettings, ToolOutputRecord } from "./types.js";

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

export interface ToolOutputBranchEntry {
	type?: unknown;
	id: string;
	message: AgentMessage;
}

export interface PrunableToolResult {
	message: AgentMessage;
	toolCallId: string;
	toolName: string;
	text: string;
	chars: number;
	isError: boolean;
	details: unknown;
}

export interface BoundedBranchEntryText {
	text: string;
	truncated: boolean;
}

/** Extract plain text from a toolResult message content array. */
export function extractToolResultText(message: AgentMessage): string {
	if (!isToolResultMessage(message)) return "";
	return extractMessageText(message, "");
}

/** Determine whether a toolResult message contains only text blocks. */
export function isTextOnlyToolResult(message: AgentMessage): boolean {
	if (!isToolResultMessage(message)) return false;
	if (!isTextOnlyMessageContent(message)) return false;
	const content = (message as { content?: unknown }).content;
	return (
		Array.isArray(content) &&
		getTextContentBlocks(content).length === content.length
	);
}

/** Detect whether a tool name belongs to Compact+ internal tooling. */
export function isCompactPlusInternalTool(toolName: string): boolean {
	return (
		toolName === QUERY_TOOL_OUTPUT_TOOL_NAME ||
		toolName.startsWith("compact_plus")
	);
}

/** Check whether a tool name is excluded from pruning. */
export function isExcludedTool(
	toolName: string,
	settings: ToolOutputPruningSettings,
): boolean {
	if (PROTECTED_EXCLUDED_TOOLS.includes(toolName)) return true;
	if (isCompactPlusInternalTool(toolName)) return true;
	if (settings.toolOutputPruneExcludedTools.includes(toolName)) return true;
	return false;
}

function isIncludedTool(
	toolName: string,
	settings: ToolOutputPruningSettings,
): boolean {
	return (
		settings.toolOutputPruneIncludedTools.length === 0 ||
		settings.toolOutputPruneIncludedTools.includes(toolName)
	);
}

/**
 * Classify and extract a toolResult that is eligible for pruning capture.
 *
 * This is the shared identity gate for prunable output: role, text-only shape,
 * protected/internal/user exclusions, include-list membership, and size floor.
 */
export function getPrunableToolResult(
	message: AgentMessage,
	settings: ToolOutputPruningSettings,
): PrunableToolResult | null {
	if (!isToolResultMessage(message)) return null;

	const toolCallId = getToolCallId(message) ?? "";
	const toolName = getToolName(message) ?? "";
	if (!toolCallId || !toolName) return null;
	if (isExcludedTool(toolName, settings)) return null;
	if (!isIncludedTool(toolName, settings)) return null;
	if (!isTextOnlyToolResult(message)) return null;

	const text = extractToolResultText(message);
	if (text.length < settings.toolOutputPruneMinChars) return null;

	return {
		message,
		toolCallId,
		toolName,
		text,
		chars: text.length,
		isError: getIsError(message),
		details: getDetails(message),
	};
}

/**
 * Safely match a pruning record to one current-branch entry.
 *
 * A match requires entryId, message entry type, toolResult role, toolCallId,
 * toolName, text-only content, and the same exclusion/include policy used at
 * capture time. It fails closed for stale, non-message, non-toolResult, mixed,
 * excluded, or include-list-missing entries.
 */
export function recordMatchesBranchEntry(
	entry: ToolOutputBranchEntry,
	record: Pick<ToolOutputRecord, "entryId" | "toolCallId" | "toolName">,
	settings: ToolOutputPruningSettings,
): boolean {
	if (record.entryId === null) return false;
	if (!record.toolCallId || !record.toolName) return false;
	if (entry.id !== record.entryId) return false;
	if ("type" in entry && entry.type !== "message") return false;
	if (!isToolResultMessage(entry.message)) return false;
	if (getToolCallId(entry.message) !== record.toolCallId) return false;
	if (getToolName(entry.message) !== record.toolName) return false;
	if (!isTextOnlyToolResult(entry.message)) return false;
	if (isExcludedTool(record.toolName, settings)) return false;
	if (!isIncludedTool(record.toolName, settings)) return false;
	return true;
}

/**
 * Read bounded text from a current-branch tool result entry.
 *
 * The caller is responsible for pairing this with recordMatchesBranchEntry when
 * record identity matters. This reader still requires message entry type,
 * toolResult role, text-only content, and a positive limit before returning
 * text, so content recovery fails closed for invalid branch entries.
 */
export function readBranchEntryText(
	entry: ToolOutputBranchEntry,
	limit: number,
): BoundedBranchEntryText | null {
	if (limit <= 0) return null;
	if ("type" in entry && entry.type !== "message") return null;
	if (!isTextOnlyToolResult(entry.message)) return null;

	let remaining = limit;
	let text = "";
	let truncated = false;
	const textBlocks = getTextContentBlocks(
		(entry.message as { content?: unknown }).content,
	);

	for (let index = 0; index < textBlocks.length; index++) {
		const blockText = textBlocks[index].text;
		if (blockText.length > remaining) {
			text += blockText.slice(0, remaining);
			truncated = true;
			break;
		}
		text += blockText;
		remaining -= blockText.length;
		if (remaining === 0) {
			truncated = textBlocks
				.slice(index + 1)
				.some((remainingBlock) => remainingBlock.text.length > 0);
			break;
		}
	}

	return { text, truncated };
}
