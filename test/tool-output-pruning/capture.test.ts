import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	buildArgsPreview,
	buildFallbackSnippets,
	captureBatch,
	extractToolResultText,
	isCompactPlusInternalTool,
	isEligibleToolResult,
	isExcludedTool,
	isTextOnlyToolResult,
	PROTECTED_EXCLUDED_TOOLS,
	serializeBatchForSummarizer,
} from "../../src/tool-output-pruning/capture.js";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import type { ToolOutputPruningSettings } from "../../src/tool-output-pruning/types.js";
import { MAX_RECORDS_PER_BATCH } from "../../src/tool-output-pruning/types.js";
import { QUERY_TOOL_OUTPUT_TOOL_NAME } from "../../src/types.js";

const DEFAULT_SETTINGS: ToolOutputPruningSettings = {
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

function makeAssistantMessage(
	toolCalls?: Array<{ id: string; name: string }>,
): AgentMessage {
	return {
		role: "assistant" as const,
		content: toolCalls
			? toolCalls.map((tc) => ({ type: "toolCall" as const, ...tc }))
			: [{ type: "text" as const, text: "hello" }],
	} as unknown as AgentMessage;
}

function makeToolResult(options: {
	toolCallId: string;
	toolName: string;
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
		toolCallId: options.toolCallId,
		toolName: options.toolName,
		content,
		isError: options.isError ?? false,
		details: options.details,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

describe("extractToolResultText", () => {
	it("extracts text from a text-only tool result", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "hello world",
		});
		expect(extractToolResultText(msg)).toBe("hello world");
	});

	it("concatenates multiple text blocks", () => {
		const msg = {
			role: "toolResult" as const,
			toolCallId: "tc1",
			toolName: "bash",
			content: [
				{ type: "text" as const, text: "a" },
				{ type: "text" as const, text: "b" },
			],
			isError: false,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		expect(extractToolResultText(msg)).toBe("ab");
	});

	it("returns empty string for non-toolResult", () => {
		const msg = {
			role: "user" as const,
			content: "hello",
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		expect(extractToolResultText(msg)).toBe("");
	});

	it("returns empty string for missing content", () => {
		const msg = {
			role: "toolResult" as const,
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		expect(extractToolResultText(msg)).toBe("");
	});

	it("ignores image blocks", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			image: true,
		});
		expect(extractToolResultText(msg)).toBe("");
	});
});

describe("isTextOnlyToolResult", () => {
	it("returns true for text-only", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "hello",
		});
		expect(isTextOnlyToolResult(msg)).toBe(true);
	});

	it("returns false for image content", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			image: true,
		});
		expect(isTextOnlyToolResult(msg)).toBe(false);
	});

	it("returns false for mixed content", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "hello",
			mixed: true,
		});
		expect(isTextOnlyToolResult(msg)).toBe(false);
	});

	it("returns true for text-only even when text is empty", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "",
		});
		expect(isTextOnlyToolResult(msg)).toBe(true);
	});

	it("returns false for truly empty content array", () => {
		const msg = {
			role: "toolResult" as const,
			toolCallId: "tc1",
			toolName: "bash",
			content: [] as unknown[],
			isError: false,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		expect(isTextOnlyToolResult(msg)).toBe(false);
	});

	it("returns false for non-toolResult", () => {
		expect(
			isTextOnlyToolResult({
				role: "user" as const,
				content: "hello",
				timestamp: Date.now(),
			} as unknown as AgentMessage),
		).toBe(false);
	});
});

describe("isCompactPlusInternalTool", () => {
	it("detects query tool", () => {
		expect(isCompactPlusInternalTool(QUERY_TOOL_OUTPUT_TOOL_NAME)).toBe(true);
		expect(PROTECTED_EXCLUDED_TOOLS).toContain(QUERY_TOOL_OUTPUT_TOOL_NAME);
	});

	it("detects compact_plus prefix", () => {
		expect(isCompactPlusInternalTool("compact_plus_internal")).toBe(true);
	});

	it("returns false for ordinary tools", () => {
		expect(isCompactPlusInternalTool("bash")).toBe(false);
		expect(isCompactPlusInternalTool("read")).toBe(false);
	});
});

describe("isExcludedTool", () => {
	it("returns true for protected excluded tools", () => {
		for (const toolName of PROTECTED_EXCLUDED_TOOLS) {
			expect(isExcludedTool(toolName, DEFAULT_SETTINGS)).toBe(true);
		}
	});

	it("returns true for internal tools", () => {
		expect(
			isExcludedTool("compact_plus_query_tool_output", DEFAULT_SETTINGS),
		).toBe(true);
		expect(isExcludedTool("compact_plus_internal", DEFAULT_SETTINGS)).toBe(
			true,
		);
	});

	it("returns true for user-configured excluded tools", () => {
		expect(isExcludedTool("bash", DEFAULT_SETTINGS)).toBe(false);
		const settings: ToolOutputPruningSettings = {
			...DEFAULT_SETTINGS,
			toolOutputPruneExcludedTools: ["bash"],
		};
		expect(isExcludedTool("bash", settings)).toBe(true);
	});

	it("returns false for non-excluded tools", () => {
		expect(isExcludedTool("bash", DEFAULT_SETTINGS)).toBe(false);
		expect(isExcludedTool("web_search", DEFAULT_SETTINGS)).toBe(false);
	});

	it("protected exclusions cannot be overridden by user settings", () => {
		const settings: ToolOutputPruningSettings = {
			...DEFAULT_SETTINGS,
			toolOutputPruneExcludedTools: [],
		};
		for (const toolName of PROTECTED_EXCLUDED_TOOLS) {
			expect(isExcludedTool(toolName, settings)).toBe(true);
		}
	});
});

describe("isEligibleToolResult", () => {
	it("accepts eligible text-only results above min chars", () => {
		const text = "x".repeat(3000);
		const msg = makeToolResult({ toolCallId: "tc1", toolName: "bash", text });
		expect(isEligibleToolResult(msg, DEFAULT_SETTINGS)).toBe(true);
	});

	it("rejects excluded tools", () => {
		const text = "x".repeat(3000);
		const msg = makeToolResult({ toolCallId: "tc1", toolName: "read", text });
		expect(isEligibleToolResult(msg, DEFAULT_SETTINGS)).toBe(false);
	});

	it("rejects Compact+ internal tools", () => {
		const text = "x".repeat(3000);
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: QUERY_TOOL_OUTPUT_TOOL_NAME,
			text,
		});
		expect(isEligibleToolResult(msg, DEFAULT_SETTINGS)).toBe(false);
	});

	it("rejects protected excluded tools even when user clears excluded list", () => {
		const settings: ToolOutputPruningSettings = {
			...DEFAULT_SETTINGS,
			toolOutputPruneExcludedTools: [],
		};
		const text = "x".repeat(3000);
		for (const toolName of PROTECTED_EXCLUDED_TOOLS) {
			const msg = makeToolResult({ toolCallId: "tc1", toolName, text });
			expect(isEligibleToolResult(msg, settings)).toBe(false);
		}
	});

	it("rejects internal tools even when user clears excluded list", () => {
		const settings: ToolOutputPruningSettings = {
			...DEFAULT_SETTINGS,
			toolOutputPruneExcludedTools: [],
		};
		const text = "x".repeat(3000);
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "compact_plus_internal_thing",
			text,
		});
		expect(isEligibleToolResult(msg, settings)).toBe(false);
	});

	it("rejects image content", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			image: true,
		});
		expect(isEligibleToolResult(msg, DEFAULT_SETTINGS)).toBe(false);
	});

	it("rejects mixed content", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "x".repeat(3000),
			mixed: true,
		});
		expect(isEligibleToolResult(msg, DEFAULT_SETTINGS)).toBe(false);
	});

	it("rejects results below min chars", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "short",
		});
		expect(isEligibleToolResult(msg, DEFAULT_SETTINGS)).toBe(false);
	});

	it("rejects non-toolResult messages", () => {
		expect(
			isEligibleToolResult(
				{
					role: "user" as const,
					content: "hello",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
				DEFAULT_SETTINGS,
			),
		).toBe(false);
	});

	it("honors included-tools filter when non-empty", () => {
		const settings: ToolOutputPruningSettings = {
			...DEFAULT_SETTINGS,
			toolOutputPruneIncludedTools: ["web_search"],
		};
		const text = "x".repeat(3000);
		expect(
			isEligibleToolResult(
				makeToolResult({ toolCallId: "tc1", toolName: "bash", text }),
				settings,
			),
		).toBe(false);
		expect(
			isEligibleToolResult(
				makeToolResult({ toolCallId: "tc2", toolName: "web_search", text }),
				settings,
			),
		).toBe(true);
	});
});

describe("buildArgsPreview", () => {
	it("returns null when details are absent", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "out",
		});
		expect(buildArgsPreview(msg)).toBeNull();
	});

	it("returns JSON string for details", () => {
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "out",
			details: { command: "ls" },
		});
		expect(buildArgsPreview(msg)).toBe('{"command":"ls"}');
	});

	it("truncates long previews", () => {
		const long = "x".repeat(500);
		const msg = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "out",
			details: { data: long },
		});
		const preview = buildArgsPreview(msg, 100);
		expect(preview).toHaveLength(100);
		expect(preview?.endsWith("…")).toBe(true);
	});
});

describe("buildFallbackSnippets", () => {
	it("returns null for empty text", () => {
		expect(buildFallbackSnippets("")).toBeNull();
	});

	it("returns full text when under limit", () => {
		expect(buildFallbackSnippets("hello world", 100)).toBe("hello world");
	});

	it("returns head and tail with separator when over limit", () => {
		const text = "a".repeat(1000);
		const result = buildFallbackSnippets(text, 200);
		expect(result).toContain("\n…\n");
		expect(result?.startsWith("a".repeat(80))).toBe(true);
		expect(result?.endsWith("a".repeat(80))).toBe(true);
	});
});

describe("captureBatch", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it("returns null for non-assistant message", () => {
		const msg = {
			role: "user" as const,
			content: "hello",
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const result = captureBatch(
			msg,
			[],
			0,
			Date.now(),
			DEFAULT_SETTINGS,
			state,
		);
		expect(result).toBeNull();
	});

	it("returns null when no tool results are eligible", () => {
		const assistant = makeAssistantMessage();
		const results = [
			makeToolResult({
				toolCallId: "tc1",
				toolName: "read",
				text: "x".repeat(3000),
			}),
		];
		const result = captureBatch(
			assistant,
			results,
			0,
			Date.now(),
			DEFAULT_SETTINGS,
			state,
		);
		expect(result).toBeNull();
	});

	it("captures only eligible tool results", () => {
		const assistant = makeAssistantMessage([
			{ id: "tc1", name: "bash" },
			{ id: "tc2", name: "read" },
		]);
		const results = [
			makeToolResult({
				toolCallId: "tc1",
				toolName: "bash",
				text: "x".repeat(3000),
			}),
			makeToolResult({
				toolCallId: "tc2",
				toolName: "read",
				text: "x".repeat(3000),
			}),
		];
		const result = captureBatch(
			assistant,
			results,
			1,
			1000,
			DEFAULT_SETTINGS,
			state,
		);
		expect(result).not.toBeNull();
		if (result === null) throw new Error("expected capture result");
		expect(result.records).toHaveLength(1);
		expect(result.records[0].toolName).toBe("bash");
		expect(result.batch.recordIds).toHaveLength(1);
	});

	it("assigns sequential short refs", () => {
		const assistant = makeAssistantMessage([
			{ id: "tc1", name: "bash" },
			{ id: "tc2", name: "bash" },
		]);
		const results = [
			makeToolResult({
				toolCallId: "tc1",
				toolName: "bash",
				text: "x".repeat(3000),
			}),
			makeToolResult({
				toolCallId: "tc2",
				toolName: "bash",
				text: "x".repeat(3000),
			}),
		];
		const result = captureBatch(
			assistant,
			results,
			0,
			1000,
			DEFAULT_SETTINGS,
			state,
		);
		expect(result).not.toBeNull();
		if (result === null) throw new Error("expected capture result");
		expect(result.records[0].shortRef).toBe("t1");
		expect(result.records[1].shortRef).toBe("t2");
	});

	it("sets correct metadata on records", () => {
		const assistant = makeAssistantMessage([{ id: "tc1", name: "bash" }]);
		const text = "x".repeat(3000);
		const results = [
			makeToolResult({
				toolCallId: "tc1",
				toolName: "bash",
				text,
				isError: true,
				details: { cmd: "ls" },
			}),
		];
		const result = captureBatch(
			assistant,
			results,
			2,
			5000,
			DEFAULT_SETTINGS,
			state,
		);
		expect(result).not.toBeNull();
		if (result === null) throw new Error("expected capture result");
		const record = result.records[0];
		expect(record.toolCallId).toBe("tc1");
		expect(record.toolName).toBe("bash");
		expect(record.chars).toBe(3000);
		expect(record.isError).toBe(true);
		expect(record.timestamp).toBe(5000);
		expect(record.entryId).toBeNull();
		expect(record.summary).toBeNull();
	});

	it("populates argsPreview and fallbackSnippets when available", () => {
		const assistant = makeAssistantMessage([{ id: "tc1", name: "bash" }]);
		const text = "x".repeat(3000);
		const results = [
			makeToolResult({
				toolCallId: "tc1",
				toolName: "bash",
				text,
				details: { command: "echo hi" },
			}),
		];
		const result = captureBatch(
			assistant,
			results,
			0,
			1000,
			DEFAULT_SETTINGS,
			state,
		);
		expect(result).not.toBeNull();
		if (result === null) throw new Error("expected capture result");
		const record = result.records[0];
		expect(record.argsPreview).toBe('{"command":"echo hi"}');
		// Fallback snippets are truncated for long text (default max 400 chars)
		expect(record.fallbackSnippets).not.toBeNull();
		expect(record.fallbackSnippets).toContain("\n…\n");
	});
});

describe("serializeBatchForSummarizer", () => {
	it("serializes records with bounded text", () => {
		const records = [
			{
				recordId: "r1",
				entryId: null,
				toolCallId: "tc1",
				toolName: "bash",
				timestamp: 1000,
				chars: 10,
				isError: false,
				summary: null,
				shortRef: "t1",
				argsPreview: '{"cmd":"ls"}',
				fallbackSnippets: null,
			},
		];
		const toolResults = [
			makeToolResult({
				toolCallId: "tc1",
				toolName: "bash",
				text: "hello world",
			}),
		];
		const text = serializeBatchForSummarizer(
			records,
			toolResults,
			DEFAULT_SETTINGS,
		);
		expect(text).toContain("[t1] bash (toolCallId: tc1)");
		expect(text).toContain('args: {"cmd":"ls"}');
		expect(text).toContain("hello world");
	});

	it("bounds text to summaryMaxChars", () => {
		const records = [
			{
				recordId: "r1",
				entryId: null,
				toolCallId: "tc1",
				toolName: "bash",
				timestamp: 1000,
				chars: 2000,
				isError: false,
				summary: null,
				shortRef: "t1",
				argsPreview: null,
				fallbackSnippets: null,
			},
		];
		const longText = "x".repeat(3000);
		const toolResults = [
			makeToolResult({ toolCallId: "tc1", toolName: "bash", text: longText }),
		];
		const settings: ToolOutputPruningSettings = {
			...DEFAULT_SETTINGS,
			toolOutputSummaryMaxChars: 100,
		};
		const text = serializeBatchForSummarizer(records, toolResults, settings);
		expect(text).toContain(`${"x".repeat(99)}…`);
		expect(text).not.toContain("x".repeat(100));
	});

	it("skips tool results not found in the provided array", () => {
		const records = [
			{
				recordId: "r1",
				entryId: null,
				toolCallId: "tc-missing",
				toolName: "bash",
				timestamp: 1000,
				chars: 10,
				isError: false,
				summary: null,
				shortRef: "t1",
				argsPreview: null,
				fallbackSnippets: null,
			},
		];
		const toolResults = [
			makeToolResult({ toolCallId: "tc1", toolName: "bash", text: "hello" }),
		];
		const text = serializeBatchForSummarizer(
			records,
			toolResults,
			DEFAULT_SETTINGS,
		);
		expect(text).toBe("");
	});

	it("concatenates multiple records", () => {
		const records = [
			{
				recordId: "r1",
				entryId: null,
				toolCallId: "tc1",
				toolName: "bash",
				timestamp: 1000,
				chars: 5,
				isError: false,
				summary: null,
				shortRef: "t1",
				argsPreview: null,
				fallbackSnippets: null,
			},
			{
				recordId: "r2",
				entryId: null,
				toolCallId: "tc2",
				toolName: "grep",
				timestamp: 1000,
				chars: 5,
				isError: false,
				summary: null,
				shortRef: "t2",
				argsPreview: null,
				fallbackSnippets: null,
			},
		];
		const toolResults = [
			makeToolResult({ toolCallId: "tc1", toolName: "bash", text: "out1" }),
			makeToolResult({ toolCallId: "tc2", toolName: "grep", text: "out2" }),
		];
		const text = serializeBatchForSummarizer(
			records,
			toolResults,
			DEFAULT_SETTINGS,
		);
		expect(text).toContain("[t1] bash");
		expect(text).toContain("[t2] grep");
		expect(text).toContain("out1");
		expect(text).toContain("out2");
	});
});

describe("captureBatch bounded limits", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it(`caps records per batch to MAX_RECORDS_PER_BATCH (${MAX_RECORDS_PER_BATCH})`, () => {
		const assistant = makeAssistantMessage();
		const results: AgentMessage[] = [];
		for (let i = 0; i < MAX_RECORDS_PER_BATCH + 10; i++) {
			results.push(
				makeToolResult({
					toolCallId: `tc${i}`,
					toolName: "bash",
					text: "x".repeat(3000),
				}),
			);
		}
		const result = captureBatch(
			assistant,
			results,
			0,
			1000,
			DEFAULT_SETTINGS,
			state,
		);
		expect(result).not.toBeNull();
		if (result === null) throw new Error("expected capture result");
		expect(result.records).toHaveLength(MAX_RECORDS_PER_BATCH);
		expect(result.batch.recordIds).toHaveLength(MAX_RECORDS_PER_BATCH);
	});
});
