import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export type TextContentBlock = { type: "text"; text: string };
export type ToolCallContentBlock = {
	type: "toolCall";
	id?: unknown;
	name?: string;
	arguments?: unknown;
};

export type IdBearingToolCallContentBlock = ToolCallContentBlock & {
	id: string;
};

export function isUserMessage(message: AgentMessage): boolean {
	return message.role === "user";
}

export function isAssistantMessage(message: AgentMessage): boolean {
	return message.role === "assistant";
}

export function isToolResultMessage(message: AgentMessage): boolean {
	return message.role === "toolResult";
}

export function isBashExecutionMessage(message: AgentMessage): boolean {
	return message.role === "bashExecution";
}

export function isTextContentBlock(block: unknown): block is TextContentBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "text" &&
		typeof (block as { text?: unknown }).text === "string"
	);
}

export function isToolCallContentBlock(
	block: unknown,
): block is ToolCallContentBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "toolCall"
	);
}

export function isIdBearingToolCallContentBlock(
	block: unknown,
): block is IdBearingToolCallContentBlock {
	return (
		isToolCallContentBlock(block) &&
		typeof (block as { id?: unknown }).id === "string"
	);
}

export function getTextContentBlocks(content: unknown): TextContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter(isTextContentBlock);
}

export function extractTextFromContent(
	content: unknown,
	separator = "\n",
): string {
	if (typeof content === "string") return content;
	return getTextContentBlocks(content)
		.map((block) => block.text)
		.join(separator);
}

export function extractMessageText(
	message: AgentMessage,
	separator = "\n",
): string {
	if (isBashExecutionMessage(message)) {
		return `Command: ${(message as { command: string }).command}\nOutput: ${(message as { output: string }).output}`;
	}
	return extractTextFromContent(
		(message as { content?: unknown }).content,
		separator,
	);
}

export function extractUserOrAssistantText(
	message: AgentMessage,
	separator = "\n",
): string {
	if (!isUserMessage(message) && !isAssistantMessage(message)) return "";
	return extractTextFromContent(
		(message as { content?: unknown }).content,
		separator,
	);
}

export function getAssistantToolCallBlocks(
	message: AgentMessage,
): ToolCallContentBlock[] {
	if (!isAssistantMessage(message)) return [];
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content.filter(isToolCallContentBlock);
}

export function getAssistantIdBearingToolCallBlocks(
	message: AgentMessage,
): IdBearingToolCallContentBlock[] {
	if (!isAssistantMessage(message)) return [];
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content.filter(isIdBearingToolCallContentBlock);
}

export function getToolCallId(message: AgentMessage): string | undefined {
	const id = (message as { toolCallId?: unknown }).toolCallId;
	return typeof id === "string" ? id : undefined;
}

export function getToolName(message: AgentMessage): string | undefined {
	const name = (message as { toolName?: unknown }).toolName;
	return typeof name === "string" ? name : undefined;
}

export function getIsError(message: AgentMessage): boolean {
	return (message as { isError?: boolean }).isError ?? false;
}

export function getDetails(message: AgentMessage): unknown {
	return (message as { details?: unknown }).details;
}

export function isToolCallArgumentsObject(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTextOnlyContent(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		content.every(
			(block) =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text",
		)
	);
}

export function isTextOnlyMessageContent(message: AgentMessage): boolean {
	return isTextOnlyContent((message as { content?: unknown }).content);
}

export function isSessionMessageEntry(
	entry: { type?: unknown } | unknown,
): entry is SessionMessageEntry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		(entry as { type?: unknown }).type === "message"
	);
}

export function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneWithSingleTextBlock(
	message: AgentMessage,
	text: string,
): AgentMessage {
	const cloned = jsonClone(message) as AgentMessage;
	(cloned as { content: unknown }).content = [{ type: "text", text }];
	return cloned;
}

export function createUserTextMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
	} as AgentMessage;
}
