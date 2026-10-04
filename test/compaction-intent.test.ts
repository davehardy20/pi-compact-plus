import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { prepareCompactionIntent } from "../src/compact.js";
import { extractCompactionFocus } from "../src/compaction-intent.js";
import { buildSummaryInstructions } from "../src/prompts.js";

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}
function preparation(messages: AgentMessage[], prefix: AgentMessage[] = []) {
	return {
		messagesToSummarize: messages,
		turnPrefixMessages: prefix,
		isSplitTurn: prefix.length > 0,
	};
}

it("budgets the hard-mode transcript after pruning ephemeral acknowledgements", () => {
	const source = user("Task: repair login.");
	const retained = user("Keep this instruction.".repeat(1000));
	const history = [
		source,
		...(Array.from({ length: 4500 }, () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "ok".repeat(80) }],
		})) as AgentMessage[]),
	];
	const projected = [...history, retained];
	const original = preparation(history);
	const before = extractCompactionFocus(projected, original, 200_000);
	expect(before.intentEvidence?.overflow).toBe(true);
	const hard = prepareCompactionIntent(original as never, "hard");
	const after = extractCompactionFocus(projected, hard, 200_000);
	expect(after.intentEvidence?.overflow).toBeUndefined();
});

it.each([false, true])(
	"resolves summarized unfamiliar redirects with retained status=%s",
	(hasStatus) => {
		const original = user("Task: deploy the retired service.");
		const redirect = user("I'd like to investigate login instead.");
		const status = user("All tests passed.");
		const source = preparation([original, redirect]);
		const focus = extractCompactionFocus(
			[original, redirect, ...(hasStatus ? [status] : [])],
			source,
			200_000,
		);
		expect(focus.intentEvidence?.priorObjective).toBe(
			"deploy the retired service.",
		);
		expect(focus.intentEvidence?.recentUserTurns).toEqual(
			hasStatus ? [status.content] : [],
		);
		expect(source.messagesToSummarize).toEqual([original, redirect]);
		const instructions = buildSummaryInstructions("standard", focus, {
			previousSummary: "Old memory: deploy the retired service.",
			isSplitTurn: false,
			turnPrefixCount: 0,
		});
		expect(instructions).not.toContain(redirect.content);
		expect(instructions).toContain("Supplemental projected user turns");
		expect(
			instructions
				.split("\n")
				.filter(
					(line) =>
						line.includes("conversation user turns") &&
						line.includes("supplemental omitted/retained user turns"),
				),
		).toHaveLength(2);
	},
);
