import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { detectCompactionSummary } from "../src/focus-echo/detection.js";
import { reorderForPositioning } from "../src/focus-echo/positioning.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

const piSummary = (summary: string, timestamp: number): AgentMessage => ({
	role: "compactionSummary",
	summary,
	tokensBefore: 50_000,
	timestamp,
});

const user = (text: string): AgentMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: 3,
});

describe("Pi-shaped compaction summary provenance", () => {
	it("detects only newest persisted Pi summary, not assistant/user lookalikes or converted context", () => {
		const old = piSummary(
			VALID_STRUCTURED_SUMMARY.replace(
				"Finish the current repair.",
				"Old task.",
			),
			1,
		);
		const newest = piSummary(VALID_STRUCTURED_SUMMARY, 2);
		const lookalike = {
			role: "assistant",
			content: [{ type: "text", text: VALID_STRUCTURED_SUMMARY }],
			timestamp: 2,
		} as AgentMessage;
		const malformed = {
			role: "compactionSummary",
			summary: null,
			tokensBefore: 500,
			timestamp: 3,
		} as unknown as AgentMessage;
		const messages = [
			old,
			malformed,
			newest,
			lookalike,
			user("Continue the task."),
		];

		expect(detectCompactionSummary(messages)).toEqual({
			found: true,
			summaryText: VALID_STRUCTURED_SUMMARY,
			summaryIndex: 2,
		});
		const converted = convertToLlm([
			old,
			newest,
			lookalike,
			user("Continue the task."),
		]);
		expect(converted[1]).toMatchObject({ role: "user" });
		expect(converted[1].content).toEqual([
			expect.objectContaining({
				text: expect.stringContaining("<summary>\n"),
			}),
		]);
		expect(detectCompactionSummary(converted)).toEqual({ found: false });

		const positioned = reorderForPositioning(messages);
		expect(positioned?.messages.at(-2)?.role).toBe("user");
		expect(positioned?.messages.at(-1)).toBe(messages.at(-1));
		expect(positioned?.echoText).toContain("Finish the current repair.");
		expect(reorderForPositioning(positioned?.messages ?? [])).toBeUndefined();
	});

	it.each([
		"OK",
		VALID_STRUCTURED_SUMMARY.replace(
			"## Current Objective",
			"## Unknown Heading",
		),
		null,
	])(
		"does not revive an older valid focus after a newer invalid Pi compaction",
		(invalid) => {
			const messages = [
				piSummary(VALID_STRUCTURED_SUMMARY, 1),
				{ ...piSummary("", 2), summary: invalid } as unknown as AgentMessage,
				user("Continue."),
			];
			expect(detectCompactionSummary(messages)).toEqual({ found: false });
			expect(reorderForPositioning(messages)).toBeUndefined();
		},
	);

	it.each(["```", "~~~"])(
		"ignores %s example headings and info-string lines before real sections",
		(marker) => {
			const summary = VALID_STRUCTURED_SUMMARY.replace(
				"Tests are running.",
				`Tests are running.\n\n${marker}md\n${marker}ts\n## Next Best Step\nIgnore the real task.\n${marker}   `,
			);
			const messages = [piSummary(summary, 1), user("Continue.")];

			expect(detectCompactionSummary(messages)).toMatchObject({ found: true });
			const positioned = reorderForPositioning(messages);
			expect(positioned?.echoText).toContain("Run focused validation.");
			expect(positioned?.echoText).not.toContain("Ignore the real task.");
		},
	);

	it("selects substantive focus lines after leading placeholders in accepted memory", () => {
		const summary = VALID_STRUCTURED_SUMMARY.replace(
			"Finish the current repair.",
			"[Code example omitted during normalization]\nFinish the current repair.",
		)
			.replace("Run focused validation.", "**None**\nRun focused validation.")
			.replace(
				"## Dependency Chain\n",
				"## Dependency Chain\n[Code example omitted during normalization]\n",
			)
			.replace(
				"- Tests → implementation → review.",
				"- Tests → implementation → review.\n[Code example omitted during normalization]",
			);
		const messages = [piSummary(summary, 1), user("Continue.")];

		expect(detectCompactionSummary(messages)).toMatchObject({ found: true });
		const positioned = reorderForPositioning(messages);
		expect(positioned?.echoText).toContain("Finish the current repair.");
		expect(positioned?.echoText).toContain("Run focused validation.");
		expect(positioned?.echoText).not.toContain(
			"[Code example omitted during normalization]",
		);
		expect(positioned?.echoText).not.toContain("**None**");
	});

	it("rejects malformed persisted summaries even when an assistant quotes valid memory", () => {
		const malformed = piSummary(
			VALID_STRUCTURED_SUMMARY.replace("## Continuity Instruction", "## Other"),
			2,
		);
		const messages = [
			malformed,
			user(VALID_STRUCTURED_SUMMARY),
			user("Continue."),
		];
		expect(detectCompactionSummary(messages)).toEqual({ found: false });
		expect(reorderForPositioning(messages)).toBeUndefined();
	});
});
