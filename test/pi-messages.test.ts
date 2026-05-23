import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	cloneWithSingleTextBlock,
	createUserTextMessage,
	extractMessageText,
	extractTextFromContent,
	extractUserOrAssistantText,
	getAssistantIdBearingToolCallBlocks,
	getAssistantToolCallBlocks,
	getDetails,
	getIsError,
	getTextContentBlocks,
	getToolCallId,
	getToolName,
	isAssistantMessage,
	isBashExecutionMessage,
	isSessionMessageEntry,
	isTextContentBlock,
	isTextOnlyContent,
	isToolCallArgumentsObject,
	isToolResultMessage,
	isUserMessage,
	jsonClone,
} from "../src/pi-messages.js";

describe("pi message helpers", () => {
	it("guards roles", () => {
		expect(isUserMessage({ role: "user", content: "hi" } as AgentMessage)).toBe(
			true,
		);
		expect(
			isAssistantMessage({
				role: "assistant",
				content: [],
			} as unknown as AgentMessage),
		).toBe(true);
		expect(
			isToolResultMessage({
				role: "toolResult",
				content: [],
			} as unknown as AgentMessage),
		).toBe(true);
		expect(
			isBashExecutionMessage({ role: "bashExecution" } as AgentMessage),
		).toBe(true);
	});

	it("extracts text from string and array content", () => {
		expect(extractTextFromContent("plain")).toBe("plain");
		expect(
			extractTextFromContent([
				{ type: "text", text: "a" },
				{ type: "image", source: {} },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
		expect(
			extractTextFromContent(
				[
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
				"",
			),
		).toBe("ab");
		expect(extractTextFromContent([{ type: "text" }, null])).toBe("");
	});

	it("extractMessageText matches extract.ts separators and bash formatting", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
		} as AgentMessage;
		expect(extractMessageText(msg)).toBe("one\ntwo");
		expect(extractMessageText(msg, " | ")).toBe("one | two");
		expect(
			extractMessageText({
				role: "bashExecution",
				command: "npm test",
				output: "ok",
			} as unknown as AgentMessage),
		).toBe("Command: npm test\nOutput: ok");
	});

	it("extracts user-or-assistant text only", () => {
		expect(
			extractUserOrAssistantText({
				role: "toolResult",
				content: [{ type: "text", text: "do not scan" }],
			} as AgentMessage),
		).toBe("");
		expect(
			extractUserOrAssistantText({
				role: "user",
				content: "scan",
			} as AgentMessage),
		).toBe("scan");
	});

	it("guards content blocks and text-only content", () => {
		expect(isTextContentBlock({ type: "text", text: "x" })).toBe(true);
		expect(
			getTextContentBlocks([{ type: "text", text: "x" }, { type: "x" }]),
		).toEqual([{ type: "text", text: "x" }]);
		expect(
			isTextOnlyContent([{ type: "text" }, { type: "text", text: "x" }]),
		).toBe(true);
		expect(isTextOnlyContent([])).toBe(false);
		expect(isTextOnlyContent([{ type: "text" }, { type: "image" }])).toBe(
			false,
		);
	});

	it("extracts tool metadata and assistant tool calls", () => {
		const result = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			isError: true,
			details: { path: "src/a.ts" },
			content: [],
		} as unknown as AgentMessage;
		expect(getToolCallId(result)).toBe("call-1");
		expect(getToolName(result)).toBe("read");
		expect(getIsError(result)).toBe(true);
		expect(getDetails(result)).toEqual({ path: "src/a.ts" });

		const assistant = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "x" },
				},
				{ type: "toolCall", name: "bad" },
			],
		} as unknown as AgentMessage;
		expect(getAssistantToolCallBlocks(assistant)).toHaveLength(2);
		expect(getAssistantIdBearingToolCallBlocks(assistant)).toHaveLength(1);
		expect(isToolCallArgumentsObject({ path: "x" })).toBe(true);
		expect(isToolCallArgumentsObject(null)).toBe(false);
		expect(isToolCallArgumentsObject([])).toBe(false);
	});

	it("guards session message entries", () => {
		expect(
			isSessionMessageEntry({ type: "message", id: "e1", message: {} }),
		).toBe(true);
		expect(isSessionMessageEntry({ type: "custom" })).toBe(false);
		expect(isSessionMessageEntry(null)).toBe(false);
	});

	it("clones with JSON semantics and replaces content with one text block", () => {
		const message = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			isError: false,
			timestamp: 123,
			details: { nested: { value: 1 } },
			content: [{ type: "text", text: "original" }],
		} as unknown as AgentMessage;

		const cloned = cloneWithSingleTextBlock(message, "stub") as unknown as {
			role: string;
			toolCallId: string;
			toolName: string;
			isError: boolean;
			timestamp: number;
			details: unknown;
			content: unknown;
		};

		expect(cloned).toMatchObject({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			isError: false,
			timestamp: 123,
			details: { nested: { value: 1 } },
		});
		expect(cloned.content).toEqual([{ type: "text", text: "stub" }]);
		expect(cloned).not.toBe(message);

		const copied = jsonClone({ a: 1, b: undefined });
		expect(copied).toEqual({ a: 1 });
	});

	it("creates user text messages", () => {
		expect(createUserTextMessage("hello")).toEqual({
			role: "user",
			content: [{ type: "text", text: "hello" }],
		});
	});
});
