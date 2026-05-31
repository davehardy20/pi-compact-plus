import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	PendingToolOutputBatch,
	ToolOutputPruningSettings,
	ToolOutputRecord,
} from "../../src/tool-output-pruning/types.js";
import { QUERY_TOOL_OUTPUT_TOOL_NAME } from "../../src/types.js";

export const ENABLED_TOOL_OUTPUT_PRUNING_SETTINGS: ToolOutputPruningSettings = {
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
		QUERY_TOOL_OUTPUT_TOOL_NAME,
	],
	toolOutputPruneIncludedTools: [],
};

export const DISABLED_TOOL_OUTPUT_PRUNING_SETTINGS: ToolOutputPruningSettings =
	{
		...ENABLED_TOOL_OUTPUT_PRUNING_SETTINGS,
		experimentalToolOutputPruning: false,
	};

export function makeToolOutputPruningSettings(
	overrides?: Partial<ToolOutputPruningSettings>,
): ToolOutputPruningSettings {
	return {
		...ENABLED_TOOL_OUTPUT_PRUNING_SETTINGS,
		toolOutputPruneExcludedTools: [
			...ENABLED_TOOL_OUTPUT_PRUNING_SETTINGS.toolOutputPruneExcludedTools,
		],
		toolOutputPruneIncludedTools: [
			...ENABLED_TOOL_OUTPUT_PRUNING_SETTINGS.toolOutputPruneIncludedTools,
		],
		...overrides,
	};
}

export function makeAssistantMessage(
	toolCalls?: Array<{ id: string; name: string }>,
): AgentMessage {
	return {
		role: "assistant" as const,
		content: toolCalls
			? toolCalls.map((toolCall) => ({
					type: "toolCall" as const,
					...toolCall,
				}))
			: [{ type: "text" as const, text: "hello" }],
	} as unknown as AgentMessage;
}

export function makeToolResult(options: {
	toolCallId?: string;
	toolName?: string;
	text?: string;
	image?: boolean;
	mixed?: boolean;
	isError?: boolean;
	details?: unknown;
}): AgentMessage {
	const content: Array<{ type: string; text?: string; source?: unknown }> = [];
	if (options.text !== undefined) {
		content.push({ type: "text", text: options.text });
	}
	if (options.image) {
		content.push({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "abc" },
		});
	}
	if (options.mixed) {
		content.push({ type: "text", text: options.text ?? "" });
		content.push({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "abc" },
		});
	}
	return {
		role: "toolResult" as const,
		toolCallId: options.toolCallId ?? "tc1",
		toolName: options.toolName ?? "bash",
		content,
		isError: options.isError ?? false,
		details: options.details,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

export function makeToolOutputRecord(
	overrides?: Partial<ToolOutputRecord>,
): ToolOutputRecord {
	return {
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
		...overrides,
	};
}

export function makePendingBatch(
	overrides?: Partial<PendingToolOutputBatch>,
): PendingToolOutputBatch {
	const recordIds = overrides?.recordIds ?? ["r1"];
	return {
		batchId: "b1",
		turnIndex: 1,
		timestamp: Date.now(),
		recordIds,
		...overrides,
	};
}
