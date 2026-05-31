import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import {
	buildPersistedFocusEcho,
	createFocusEchoContextMessage,
	detectCompactionSummary,
	FOCUS_ECHO_CONTEXT_INJECTION_STRATEGY,
	reorderForPositioning,
} from "../src/reorder.js";
import {
	focusEchoGoldens,
	SOURCE_OF_TRUTH_STATUS_SUMMARY,
} from "./fixtures/focus-echo-goldens.js";

function textMessage(role: "assistant" | "user", text: string): AgentMessage {
	return {
		role,
		content: [{ type: "text", text }],
	} as AgentMessage;
}

describe("focus echo golden characterization", () => {
	for (const fixture of focusEchoGoldens) {
		it(`renders ${fixture.name}`, () => {
			expect(buildPersistedFocusEcho(fixture.summary)).toBe(
				fixture.expectedEcho,
			);
		});
	}

	it("detects the newest valid Compact+ summary outside fenced examples", () => {
		const staleSummary = SOURCE_OF_TRUTH_STATUS_SUMMARY.replace(
			"Use the latest live /compact-plus status output as the source of truth",
			"Tighten old stale status output",
		);
		const fencedSpoof = `Here is an example, not memory:\n\n\`\`\`md\n${SOURCE_OF_TRUTH_STATUS_SUMMARY}\n\`\`\``;
		const messages = [
			textMessage("assistant", staleSummary),
			textMessage("assistant", fencedSpoof),
			textMessage("assistant", SOURCE_OF_TRUTH_STATUS_SUMMARY),
			textMessage("user", "Continue"),
		];

		const detection = detectCompactionSummary(messages);

		expect(detection).toEqual({
			found: true,
			summaryText: SOURCE_OF_TRUTH_STATUS_SUMMARY,
			summaryIndex: 2,
		});
	});

	it("rejects a fenced Compact+ summary example as memory", () => {
		const messages = [
			textMessage(
				"assistant",
				`Example only:\n\n\`\`\`md\n${SOURCE_OF_TRUTH_STATUS_SUMMARY}\n\`\`\``,
			),
			textMessage("user", "Continue"),
		];

		expect(detectCompactionSummary(messages)).toEqual({ found: false });
		expect(reorderForPositioning(messages)).toBeUndefined();
	});

	it("documents that focus echo still uses synthetic-user compatibility fallback", () => {
		expect(FOCUS_ECHO_CONTEXT_INJECTION_STRATEGY).toMatchObject({
			strategy: "synthetic-user-message",
			lowerAuthorityRoleAvailable: false,
		});
		expect(FOCUS_ECHO_CONTEXT_INJECTION_STRATEGY.reason).toContain(
			"custom messages currently serialize to provider user messages",
		);

		const message = createFocusEchoContextMessage(
			focusEchoGoldens[0].expectedEcho,
		);
		expect(message).toEqual(
			textMessage("user", focusEchoGoldens[0].expectedEcho),
		);
	});

	it("injects the focus echo before the latest user message", () => {
		const messages = [
			textMessage("assistant", SOURCE_OF_TRUTH_STATUS_SUMMARY),
			textMessage("user", "Earlier request"),
			textMessage("assistant", "Acknowledged."),
			textMessage("user", "Continue"),
		];

		const result = reorderForPositioning(messages);

		expect(result?.echoText).toBe(focusEchoGoldens[0].expectedEcho);
		expect(result?.messages).toHaveLength(5);
		expect(result?.messages[3]).toEqual(
			textMessage("user", focusEchoGoldens[0].expectedEcho),
		);
		expect(result?.messages[4]).toBe(messages[3]);
	});

	it("does not inject a duplicate focus echo", () => {
		const messages = [
			textMessage("assistant", SOURCE_OF_TRUTH_STATUS_SUMMARY),
			textMessage("user", focusEchoGoldens[0].expectedEcho),
			textMessage("user", "Continue"),
		];

		expect(reorderForPositioning(messages)).toBeUndefined();
	});
});
