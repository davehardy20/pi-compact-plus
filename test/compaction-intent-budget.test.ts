import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	generateSummaryWithUsage,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { prepareBudgetedCompactionFocus } from "../src/compaction-intent.js";
import { buildSummaryInstructions } from "../src/prompts.js";

const sdkRoot = dirname(
	fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const sdkCompaction = await import(
	/* @vite-ignore */ pathToFileURL(
		join(sdkRoot, "core/compaction/compaction.js"),
	).href
);

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}
function preparation(messages: AgentMessage[], prefix: AgentMessage[] = []) {
	return {
		messagesToSummarize: messages,
		turnPrefixMessages: prefix,
		isSplitTurn: prefix.length > 0,
		settings: { reserveTokens: 16_384 },
	};
}

async function extractCompactionFocus(
	projected: AgentMessage[],
	prepared: ReturnType<typeof preparation> & { previousSummary?: string },
	contextWindow: number,
) {
	const budgeted = await prepareBudgetedCompactionFocus(projected, prepared, {
		model: {
			id: "budget-test",
			provider: "budget-test",
			api: "openai-completions",
			contextWindow,
			maxTokens: contextWindow,
		} as Parameters<typeof generateSummaryWithUsage>[1],
		renderInstructions: (focus) =>
			buildSummaryInstructions("standard", focus, {
				isSplitTurn: prepared.isSplitTurn,
				turnPrefixCount: prepared.turnPrefixMessages.length,
				previousSummary: prepared.previousSummary,
			}),
	});
	return budgeted.focus;
}

it("budgets only omitted user intent against the actual summary request", async () => {
	const old = user(`Task: repair login.\n${"old context ".repeat(3000)}`);
	const redirect = user(
		`Please investigate routing instead.\n${"detail ".repeat(2000)}`,
	);
	const focus = await extractCompactionFocus(
		[old, redirect],
		preparation([old]),
		200_000,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
	expect(focus.intentEvidence?.recentUserTurns).toEqual([
		redirect.content.trim(),
	]);
});

it("native preparation includes users retained before a previous compaction entry", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage(user("Task: deploy the obsolete service."));
	const supplied = user(`Task: repair login.\n${"detail ".repeat(30_000)}`);
	const kept = session.appendMessage(supplied);
	session.appendCompaction("Prior memory.", kept, 60_000);
	const retained = user("Preserve the audit trail too.");
	session.appendMessage(retained);
	const projected = session.buildSessionContext().messages;
	const prepared = sdkCompaction.prepareCompaction(session.getBranch(), {
		enabled: true,
		reserveTokens: 2048,
		keepRecentTokens: 1,
	}) as Parameters<typeof extractCompactionFocus>[1] | undefined;
	expect(prepared).toBeDefined();
	if (!prepared) throw new Error("Native preparation was not generated");
	const source = prepared.isSplitTurn
		? [...prepared.messagesToSummarize, ...prepared.turnPrefixMessages]
		: prepared.messagesToSummarize;
	const suppliedUsers = source.filter((message) => message.role === "user");
	const projectedUsers = projected.filter((message) => message.role === "user");
	expect(suppliedUsers.length).toBe(1);
	expect(projectedUsers.slice(0, suppliedUsers.length)).toEqual(suppliedUsers);
	const focus = await extractCompactionFocus(projected, prepared, 200_000);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
	expect(focus.intentEvidence?.recentUserTurns).toEqual([retained.content]);
});

it("keeps later identical requests instead of deduplicating them as a text set", async () => {
	const first = user("Please investigate login.");
	const repeated = user("Please investigate login.");
	const focus = await extractCompactionFocus(
		[first, repeated],
		preparation([first]),
		200_000,
	);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([repeated.content]);
});

it("retains all evidence if the summary users do not match an authoritative prefix", async () => {
	const current = user("The authorization paths, rather than login.");
	const obsolete = user("Task: deploy an obsolete service.");
	const focus = await extractCompactionFocus(
		[current],
		preparation([obsolete]),
		200_000,
	);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([current.content]);
	expect(focus.intentEvidence?.recentUserTurns).not.toContain(obsolete.content);
});

it("does not revive edited-away users from preparation when the projection is empty", async () => {
	const obsolete = user("Task: deploy an obsolete service.");
	const focus = await extractCompactionFocus(
		[],
		preparation([obsolete]),
		200_000,
	);
	expect(focus.intentEvidence).toBeUndefined();
	expect(focus.objective).toBe("Continue current task.");
});

it("counts split-prefix users as supplied to the unified structured request", async () => {
	const first = user("Task: investigate login.");
	const prefix = user("Now the authorization paths instead.");
	const retained = user("Preserve the audit constraints too.");
	const focus = await extractCompactionFocus(
		[first, prefix, retained],
		preparation([first], [prefix]),
		200_000,
	);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([retained.content]);
});

it("still fails closed for retained UTF-8 intent exceeding the request budget", async () => {
	const retained = user("約".repeat(100_000));
	const focus = await extractCompactionFocus([retained], preparation([]), 8192);
	expect(focus.intentEvidence?.overflow).toBe(true);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([]);
});

it("preserves complete additional ASCII above the old cap when the request fits", async () => {
	const retained = user("x".repeat(300_000));
	expect(estimateTokens(retained)).toBeLessThan(1_000_000 - 16_384);
	const focus = await extractCompactionFocus(
		[retained],
		preparation([]),
		1_000_000,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
	expect(focus.intentEvidence?.recentUserTurns).toEqual([retained.content]);
});

it("accepts large ASCII history that still fits the model token budget", async () => {
	const source = user("x".repeat(190_000));
	const retained = user("Keep this entire latest instruction.".repeat(200));
	const focus = await extractCompactionFocus(
		[source, retained],
		preparation([source]),
		200_000,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
});

it("allows bounded retained evidence on a small model with a fitting reserve", async () => {
	const source = user("Task: repair login.");
	const retained = user("Keep the tests intact.");
	const focus = await extractCompactionFocus(
		[source, retained],
		{ ...preparation([source]), settings: { reserveTokens: 2048 } },
		8192,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
	expect(focus.intentEvidence?.recentUserTurns).toEqual([retained.content]);
});

it.each([
	{ contextWindow: 0, reserveTokens: 2048 },
	{ contextWindow: Number.NaN, reserveTokens: 2048 },
	{ contextWindow: 8192, reserveTokens: Number.NaN },
	{ contextWindow: 8192, reserveTokens: -1 },
])("rejects invalid request budgets %j", async (settings) => {
	const focus = await extractCompactionFocus(
		[user("Keep the constraints.")],
		{ ...preparation([]), settings },
		settings.contextWindow,
	);
	expect(focus.intentEvidence?.overflow).toBe(true);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([]);
});

it("rejects an oversized transcript even when no additional intent is omitted", async () => {
	const source = user("x".repeat(40_000));
	const focus = await extractCompactionFocus(
		[source],
		preparation([source]),
		8192,
	);
	expect(focus.intentEvidence?.overflow).toBe(true);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([]);
});

it("rejects a small-model request when native prompt plus output exceeds context", async () => {
	const source = user("Task: repair login.");
	const retained = user("Keep the audit constraints.");
	const prepared = {
		...preparation([source]),
		settings: { reserveTokens: 512 },
	};
	const focus = await extractCompactionFocus(
		[source, retained],
		prepared,
		1024,
	);
	const marker = new Error("capture only: no provider call");
	let requestTokens = 0;
	await expect(
		generateSummaryWithUsage(
			prepared.messagesToSummarize,
			{
				id: "budget-test",
				provider: "budget-test",
				api: "openai-completions",
				contextWindow: 1024,
				maxTokens: 1024,
			} as never,
			512,
			undefined,
			undefined,
			undefined,
			buildSummaryInstructions("standard", focus, {
				isSplitTurn: false,
				turnPrefixCount: 0,
			}),
			undefined,
			undefined,
			(_model, context, options) => {
				expect(
					context.messages.some((message) => message.role === "system"),
				).toBe(true);
				requestTokens = context.messages.reduce(
					(total, message) => total + estimateTokens(message),
					options?.maxTokens ?? 0,
				);
				throw marker;
			},
		),
	).rejects.toBe(marker);
	expect(requestTokens).toBeGreaterThan(1024);
	expect(focus.intentEvidence?.overflow).toBe(true);
});

it("honors a large configured output reserve when budgeting additional evidence", async () => {
	const source = user("x".repeat(600_000));
	const retained = user("Keep this instruction.".repeat(4000));
	const focus = await extractCompactionFocus(
		[source, retained],
		{ ...preparation([source]), settings: { reserveTokens: 60_000 } },
		200_000,
	);
	expect(focus.intentEvidence?.overflow).toBe(true);
});

it("fits a small model using its actual capped output allowance", async () => {
	const source = user("Task: repair login.");
	const prepared = preparation([source]);
	const renderer = vi.fn(() => "Preserve the complete task.");
	const fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("Budgeting must not contact a provider"));
	let budgeted: Awaited<ReturnType<typeof prepareBudgetedCompactionFocus>>;
	try {
		budgeted = await prepareBudgetedCompactionFocus([source], prepared, {
			model: {
				id: "budget-test",
				provider: "budget-test",
				api: "openai-completions",
				contextWindow: 2048,
				maxTokens: 512,
			} as Parameters<typeof generateSummaryWithUsage>[1],
			renderInstructions: renderer,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(renderer).toHaveBeenCalledTimes(1);
	} finally {
		fetchSpy.mockRestore();
	}
	expect(prepared.settings.reserveTokens).toBeGreaterThan(2048);
	expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
	expect(budgeted.renderedInstructions).toBe(renderer());
});

it("fits the exact captured total but rejects one token less", async () => {
	const source = user("Task: repair login.");
	const prefix = user("Keep the existing audit controls.");
	const prepared = preparation([source], [prefix]);
	const model = {
		id: "budget-test",
		provider: "budget-test",
		api: "openai-completions",
		contextWindow: 200_000,
		maxTokens: 512,
	} as Parameters<typeof generateSummaryWithUsage>[1];
	const renderInstructions = () => "Preserve both complete user turns.";
	const wide = await prepareBudgetedCompactionFocus(
		[source, prefix],
		prepared,
		{ model, renderInstructions },
	);
	expect(wide.preparation.isSplitTurn).toBe(false);
	expect(wide.preparation.turnPrefixMessages).toEqual([]);
	expect(wide.preparation.messagesToSummarize).toEqual([source, prefix]);
	expect(wide.renderedInstructions).toBe(renderInstructions());
	const marker = new Error("capture only");
	let total = 0;
	let captures = 0;
	await expect(
		generateSummaryWithUsage(
			wide.preparation.messagesToSummarize,
			model,
			prepared.settings.reserveTokens,
			undefined,
			undefined,
			undefined,
			wide.renderedInstructions,
			undefined,
			undefined,
			(_model, context, options) => {
				captures++;
				expect(options?.maxTokens).toBe(512);
				expect(options?.apiKey).toBeUndefined();
				expect(options?.headers).toBeUndefined();
				expect(options?.env).toBeUndefined();
				total = context.messages.reduce(
					(sum, message) => sum + estimateTokens(message),
					options?.maxTokens ?? 0,
				);
				throw marker;
			},
		),
	).rejects.toBe(marker);
	expect(captures).toBe(1);
	for (const delta of [0, -1]) {
		const budgeted = await prepareBudgetedCompactionFocus(
			[source, prefix],
			prepared,
			{ model: { ...model, contextWindow: total + delta }, renderInstructions },
		);
		if (delta === 0) {
			expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
			expect(budgeted.renderedInstructions).toBe(wide.renderedInstructions);
		} else {
			expect(budgeted.focus.intentEvidence?.overflow).toBe(true);
			expect(budgeted.renderedInstructions).toBeUndefined();
		}
	}
});

it("fails closed when instruction rendering throws", async () => {
	const prepared = preparation([user("Task: repair login.")]);
	const budgeted = await prepareBudgetedCompactionFocus([], prepared, {
		model: {
			id: "budget-test",
			provider: "budget-test",
			api: "openai-completions",
			contextWindow: 200_000,
			maxTokens: 512,
		} as Parameters<typeof generateSummaryWithUsage>[1],
		renderInstructions: () => {
			throw new Error("renderer unavailable");
		},
	});
	expect(budgeted.focus.intentEvidence?.overflow).toBe(true);
	expect(budgeted.renderedInstructions).toBeUndefined();
});
