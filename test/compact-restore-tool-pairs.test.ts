import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { __test__ as compactTest } from "../src/compact.js";
import {
	makeAssistantMessage,
	makeToolResult,
} from "./fixtures/tool-output-pruning.js";

const { restoreToolPairs } = compactTest;

function expectSameMessages(
	actual: AgentMessage[],
	expected: AgentMessage[],
): void {
	expect(actual).toHaveLength(expected.length);
	for (const [index, message] of expected.entries()) {
		expect(actual[index]).toBe(message);
	}
}

function makeUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
	} as AgentMessage;
}

describe("restoreToolPairs characterization", () => {
	it("preserves all four pair-retention states", () => {
		const call = makeAssistantMessage([{ id: "call-1", name: "read" }]);
		const result = makeToolResult({ toolCallId: "call-1" });
		const original = [call, result];

		expectSameMessages(restoreToolPairs([], original), []);
		expectSameMessages(restoreToolPairs([call], original), original);
		expectSameMessages(restoreToolPairs([result], original), original);
		expectSameMessages(
			restoreToolPairs([result, call, call], original),
			original,
		);
	});

	it("restores independent pairs in both directions without cross-wiring", () => {
		const callA = makeAssistantMessage([{ id: "call-a", name: "read" }]);
		const resultA = makeToolResult({ toolCallId: "call-a", toolName: "read" });
		const callB = makeAssistantMessage([{ id: "call-b", name: "bash" }]);
		const resultB = makeToolResult({ toolCallId: "call-b", toolName: "bash" });
		const original = [callA, resultA, callB, resultB];

		expectSameMessages(restoreToolPairs([callA, resultB], original), original);
	});

	it("restores every result belonging to a retained multi-call assistant", () => {
		const call = makeAssistantMessage([
			{ id: "call-a", name: "read" },
			{ id: "call-b", name: "bash" },
		]);
		const resultA = makeToolResult({ toolCallId: "call-a", toolName: "read" });
		const unrelated = makeUserMessage("keep original ordering");
		const resultB = makeToolResult({ toolCallId: "call-b", toolName: "bash" });
		const original = [call, resultA, unrelated, resultB];

		expectSameMessages(restoreToolPairs([call, unrelated], original), original);
	});

	it("ignores missing, non-string, empty, and unmatched identifiers", () => {
		const missingIdCall = {
			role: "assistant",
			content: [{ type: "toolCall", name: "read" }],
		} as AgentMessage;
		const numericIdCall = {
			role: "assistant",
			content: [{ type: "toolCall", id: 7, name: "read" }],
		} as unknown as AgentMessage;
		const emptyIdCall = makeAssistantMessage([{ id: "", name: "read" }]);
		const unmatchedCall = makeAssistantMessage([
			{ id: "call-only", name: "read" },
		]);
		const emptyIdResult = makeToolResult({ toolCallId: "" });
		const unmatchedResult = makeToolResult({ toolCallId: "result-only" });
		const original = [
			missingIdCall,
			numericIdCall,
			emptyIdCall,
			emptyIdResult,
			unmatchedCall,
			unmatchedResult,
		];

		expectSameMessages(
			restoreToolPairs(
				[missingIdCall, numericIdCall, emptyIdCall, unmatchedCall],
				original,
			),
			[missingIdCall, numericIdCall, emptyIdCall, unmatchedCall],
		);
		expectSameMessages(
			restoreToolPairs([emptyIdResult, unmatchedResult], original),
			[emptyIdResult, unmatchedResult],
		);
	});

	it("does not treat non-tool-result roles carrying toolCallId as results", () => {
		const call = makeAssistantMessage([{ id: "call-1", name: "read" }]);
		const impostorResult = {
			role: "user",
			toolCallId: "call-1",
			content: [{ type: "text", text: "untrusted shape" }],
		} as unknown as AgentMessage;
		const original = [call, impostorResult];

		expectSameMessages(restoreToolPairs([call], original), [call]);
		expectSameMessages(restoreToolPairs([impostorResult], original), [
			impostorResult,
		]);
	});

	it("matches whitespace identifiers while filtering outsiders and original-ordering duplicates", () => {
		const first = makeUserMessage("first");
		const call = makeAssistantMessage([{ id: " ", name: "read" }]);
		const result = makeToolResult({ toolCallId: " " });
		const last = makeUserMessage("last");
		const outsider = makeUserMessage("outsider");
		const original = [first, call, result, last];

		expectSameMessages(
			restoreToolPairs([last, call, first, first, outsider], original),
			original,
		);
	});
});
