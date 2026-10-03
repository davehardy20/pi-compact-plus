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

it("budgets only omitted user intent against the actual summary request", () => {
	const old = user(`Task: repair login.\n${"old context ".repeat(3000)}`);
	const redirect = user(
		`Please investigate routing instead.\n${"detail ".repeat(2000)}`,
	);
	const focus = extractCompactionFocus(
		[old, redirect],
		preparation([old]),
		200_000,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
	expect(focus.intentEvidence?.recentUserTurns).toEqual([
		redirect.content.trim(),
	]);
});

it("keeps later identical requests instead of deduplicating them as a text set", () => {
	const first = user("Please investigate login.");
	const repeated = user("Please investigate login.");
	const focus = extractCompactionFocus(
		[first, repeated],
		preparation([first]),
		200_000,
	);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([repeated.content]);
});

it("retains all evidence if the summary users do not match an authoritative prefix", () => {
	const current = user("The authorization paths, rather than login.");
	const obsolete = user("Task: deploy an obsolete service.");
	const focus = extractCompactionFocus(
		[current],
		preparation([obsolete]),
		200_000,
	);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([current.content]);
	expect(focus.intentEvidence?.recentUserTurns).not.toContain(obsolete.content);
});

it("does not revive edited-away users from preparation when the projection is empty", () => {
	const obsolete = user("Task: deploy an obsolete service.");
	const focus = extractCompactionFocus([], preparation([obsolete]), 200_000);
	expect(focus.intentEvidence).toBeUndefined();
	expect(focus.objective).toBe("Continue current task.");
});

it("counts split-prefix users as supplied to the unified structured request", () => {
	const first = user("Task: investigate login.");
	const prefix = user("Now the authorization paths instead.");
	const retained = user("Preserve the audit constraints too.");
	const focus = extractCompactionFocus(
		[first, prefix, retained],
		preparation([first], [prefix]),
		200_000,
	);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([retained.content]);
});

it("still fails closed for genuinely oversized retained UTF-8 intent", () => {
	const retained = user("約".repeat(100_000));
	const focus = extractCompactionFocus([retained], preparation([]), 1_000_000);
	expect(focus.intentEvidence?.overflow).toBe(true);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([]);
});

it("accepts large ASCII history that still fits the model token budget", () => {
	const source = user("x".repeat(190_000));
	const retained = user("Keep this entire latest instruction.".repeat(200));
	const focus = extractCompactionFocus(
		[source, retained],
		preparation([source]),
		200_000,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
});

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

it("allows bounded retained evidence on a small model with a fitting reserve", () => {
	const source = user("Task: repair login.");
	const retained = user("Keep the tests intact.");
	const focus = extractCompactionFocus(
		[source, retained],
		{ ...preparation([source]), settings: { reserveTokens: 2048 } },
		8192,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
	expect(focus.intentEvidence?.recentUserTurns).toEqual([retained.content]);
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

it("honors a large configured output reserve when budgeting additional evidence", () => {
	const source = user("x".repeat(600_000));
	const retained = user("Keep this instruction.".repeat(4000));
	const focus = extractCompactionFocus(
		[source, retained],
		{ ...preparation([source]), settings: { reserveTokens: 60_000 } },
		200_000,
	);
	expect(focus.intentEvidence?.overflow).toBe(true);
});
