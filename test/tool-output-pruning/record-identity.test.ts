import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	getPrunableToolResult,
	isCompactPlusInternalTool,
	isExcludedTool,
	isTextOnlyToolResult,
	PROTECTED_EXCLUDED_TOOLS,
	readBranchEntryText,
	recordMatchesBranchEntry,
} from "../../src/tool-output-pruning/record-identity.js";
import {
	makeToolOutputPruningSettings,
	makeToolOutputRecord,
	makeToolResult,
} from "../fixtures/tool-output-pruning.js";

const SETTINGS = makeToolOutputPruningSettings();

describe("getPrunableToolResult", () => {
	it("extracts the identity and bounded model data from an eligible text-only tool result", () => {
		const message = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "x".repeat(3000),
			isError: true,
			details: { command: "npm test" },
		});

		const result = getPrunableToolResult(message, SETTINGS);

		expect(result).toMatchObject({
			message,
			toolCallId: "tc1",
			toolName: "bash",
			chars: 3000,
			isError: true,
			details: { command: "npm test" },
		});
		expect(result?.text).toBe("x".repeat(3000));
	});

	it("rejects protected, internal, user-excluded, non-included, non-text, short, and non-toolResult messages", () => {
		for (const toolName of PROTECTED_EXCLUDED_TOOLS) {
			expect(
				getPrunableToolResult(
					makeToolResult({
						toolCallId: `tc-${toolName}`,
						toolName,
						text: "x".repeat(3000),
					}),
					SETTINGS,
				),
			).toBeNull();
		}

		expect(isCompactPlusInternalTool("compact_plus_stats")).toBe(true);
		expect(isExcludedTool("custom", SETTINGS)).toBe(false);
		expect(
			getPrunableToolResult(
				makeToolResult({
					toolCallId: "tc2",
					toolName: "compact_plus_stats",
					text: "x".repeat(3000),
				}),
				SETTINGS,
			),
		).toBeNull();
		expect(
			getPrunableToolResult(
				makeToolResult({
					toolCallId: "tc3",
					toolName: "bash",
					text: "x".repeat(3000),
				}),
				makeToolOutputPruningSettings({
					toolOutputPruneExcludedTools: ["bash"],
				}),
			),
		).toBeNull();
		expect(
			getPrunableToolResult(
				makeToolResult({
					toolCallId: "tc4",
					toolName: "bash",
					text: "x".repeat(3000),
				}),
				makeToolOutputPruningSettings({
					toolOutputPruneIncludedTools: ["python"],
				}),
			),
		).toBeNull();
		expect(
			getPrunableToolResult(
				makeToolResult({ toolCallId: "tc5", toolName: "bash", image: true }),
				SETTINGS,
			),
		).toBeNull();
		expect(
			getPrunableToolResult(
				makeToolResult({ toolCallId: "tc6", toolName: "bash", text: "short" }),
				SETTINGS,
			),
		).toBeNull();
		expect(
			getPrunableToolResult(
				{ role: "user", content: "hello" } as unknown as AgentMessage,
				SETTINGS,
			),
		).toBeNull();
	});

	it("rejects missing or empty tool metadata", () => {
		const missingMetadata = {
			role: "toolResult" as const,
			content: [{ type: "text" as const, text: "x".repeat(3000) }],
			isError: false,
		} as unknown as AgentMessage;

		expect(getPrunableToolResult(missingMetadata, SETTINGS)).toBeNull();
		expect(
			getPrunableToolResult(
				makeToolResult({
					toolCallId: "",
					toolName: "bash",
					text: "x".repeat(3000),
				}),
				SETTINGS,
			),
		).toBeNull();
		expect(
			getPrunableToolResult(
				makeToolResult({
					toolCallId: "tc1",
					toolName: "",
					text: "x".repeat(3000),
				}),
				SETTINGS,
			),
		).toBeNull();
	});
});

describe("recordMatchesBranchEntry", () => {
	it("matches only when entryId, toolCallId, toolName, message type, role, and policy all agree", () => {
		const message = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "output",
		});
		const record = makeToolOutputRecord({
			entryId: "e1",
			toolCallId: "tc1",
			toolName: "bash",
		});

		expect(
			recordMatchesBranchEntry({ id: "e1", message }, record, SETTINGS),
		).toBe(true);
		expect(
			recordMatchesBranchEntry(
				{ type: "message", id: "e1", message },
				record,
				SETTINGS,
			),
		).toBe(true);
		expect(
			recordMatchesBranchEntry({ id: "stale", message }, record, SETTINGS),
		).toBe(false);
		expect(
			recordMatchesBranchEntry(
				{ type: "custom", id: "e1", message },
				record,
				SETTINGS,
			),
		).toBe(false);
		expect(
			recordMatchesBranchEntry(
				{
					id: "e1",
					message: makeToolResult({
						toolCallId: "other",
						toolName: "bash",
						text: "output",
					}),
				},
				record,
				SETTINGS,
			),
		).toBe(false);
		expect(
			recordMatchesBranchEntry(
				{
					id: "e1",
					message: makeToolResult({
						toolCallId: "tc1",
						toolName: "python",
						text: "output",
					}),
				},
				record,
				SETTINGS,
			),
		).toBe(false);
		expect(
			recordMatchesBranchEntry(
				{
					id: "e1",
					message: makeToolResult({
						toolCallId: "tc1",
						toolName: "bash",
						mixed: true,
					}),
				},
				record,
				SETTINGS,
			),
		).toBe(false);
		expect(
			recordMatchesBranchEntry(
				{ id: "e1", message },
				{ ...record, toolName: "read" },
				SETTINGS,
			),
		).toBe(false);
	});

	it("fails closed for records without entry ids, empty identities, and include-list misses", () => {
		const message = makeToolResult({
			toolCallId: "tc1",
			toolName: "bash",
			text: "output",
		});
		const record = makeToolOutputRecord({
			entryId: "e1",
			toolCallId: "tc1",
			toolName: "bash",
		});

		expect(
			recordMatchesBranchEntry(
				{ id: "e1", message },
				{ ...record, entryId: null },
				SETTINGS,
			),
		).toBe(false);
		expect(
			recordMatchesBranchEntry(
				{ id: "e1", message },
				{ ...record, toolCallId: "" },
				SETTINGS,
			),
		).toBe(false);
		expect(
			recordMatchesBranchEntry(
				{ id: "e1", message },
				{ ...record, toolName: "" },
				SETTINGS,
			),
		).toBe(false);
		expect(
			recordMatchesBranchEntry(
				{ id: "e1", message },
				record,
				makeToolOutputPruningSettings({
					toolOutputPruneIncludedTools: ["python"],
				}),
			),
		).toBe(false);
	});
});

describe("readBranchEntryText", () => {
	it("returns bounded text and truncation status for text-only branch entries", () => {
		const message = {
			role: "toolResult" as const,
			toolCallId: "tc1",
			toolName: "bash",
			content: [
				{ type: "text" as const, text: "hello " },
				{ type: "text" as const, text: "world" },
			],
		} as unknown as AgentMessage;

		expect(readBranchEntryText({ id: "e1", message }, 20)).toEqual({
			text: "hello world",
			truncated: false,
		});
		expect(readBranchEntryText({ id: "e1", message }, 8)).toEqual({
			text: "hello wo",
			truncated: true,
		});
		expect(readBranchEntryText({ id: "e1", message }, 11)).toEqual({
			text: "hello world",
			truncated: false,
		});
		expect(readBranchEntryText({ id: "e1", message }, 6)).toEqual({
			text: "hello ",
			truncated: true,
		});
	});

	it("returns null for zero limits, non-message entries, non-tool results, mixed content, and malformed text blocks", () => {
		expect(
			readBranchEntryText(
				{
					id: "e1",
					message: makeToolResult({
						toolCallId: "tc1",
						toolName: "bash",
						text: "output",
					}),
				},
				0,
			),
		).toBeNull();
		expect(
			readBranchEntryText(
				{
					type: "custom",
					id: "e1",
					message: makeToolResult({
						toolCallId: "tc1",
						toolName: "bash",
						text: "output",
					}),
				},
				10,
			),
		).toBeNull();
		expect(
			readBranchEntryText(
				{
					id: "e1",
					message: {
						role: "user",
						content: "hello",
					} as unknown as AgentMessage,
				},
				10,
			),
		).toBeNull();
		expect(
			readBranchEntryText(
				{
					id: "e1",
					message: makeToolResult({
						toolCallId: "tc1",
						toolName: "bash",
						mixed: true,
					}),
				},
				10,
			),
		).toBeNull();

		const malformedTextBlock = {
			role: "toolResult" as const,
			toolCallId: "tc1",
			toolName: "bash",
			content: [{ type: "text" as const }],
		} as unknown as AgentMessage;
		expect(isTextOnlyToolResult(malformedTextBlock)).toBe(false);
		expect(
			readBranchEntryText({ id: "e1", message: malformedTextBlock }, 10),
		).toBeNull();
	});
});
