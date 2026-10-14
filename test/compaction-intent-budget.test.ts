import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	estimateTokens,
	generateSummaryWithUsage,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { prepareBudgetedCompactionFocus } from "../src/compaction-intent.js";
import { buildSummaryInstructions } from "../src/prompts.js";
import { CONTINUATION_PROMPT } from "../src/types.js";

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

async function budgetOf(
	projected: AgentMessage[],
	prepared: ReturnType<typeof preparation> & { previousSummary?: string },
	contextWindow: number,
	maxTokens = contextWindow,
) {
	return prepareBudgetedCompactionFocus(projected, prepared, {
		model: {
			id: "budget-test",
			provider: "budget-test",
			api: "openai-completions",
			contextWindow,
			maxTokens,
		} as Parameters<typeof generateSummaryWithUsage>[1],
		renderInstructions: (focus) =>
			buildSummaryInstructions("standard", focus, {
				isSplitTurn: prepared.isSplitTurn,
				turnPrefixCount: prepared.turnPrefixMessages.length,
				previousSummary: prepared.previousSummary,
			}),
	});
}

async function extractCompactionFocus(
	projected: AgentMessage[],
	prepared: ReturnType<typeof preparation> & { previousSummary?: string },
	contextWindow: number,
) {
	const budgeted = await budgetOf(projected, prepared, contextWindow);
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

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "budget-test",
		model: "budget-test",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	} as AssistantMessage;
}

function nativeSplitTurnPreparation() {
	const session = SessionManager.inMemory();
	const history = user(`Task: repair login.\n${"detail ".repeat(3_000)}`);
	const redirect = user("Please investigate routing instead.");
	session.appendMessage(history);
	session.appendMessage(assistantText("working ".repeat(3_000)));
	session.appendMessage(redirect);
	session.appendMessage(assistantText("investigating ".repeat(3_000)));
	const prepared = sdkCompaction.prepareCompaction(session.getBranch(), {
		enabled: true,
		reserveTokens: 16_384,
		keepRecentTokens: 1,
	}) as Parameters<typeof extractCompactionFocus>[1] | undefined;
	if (!prepared) {
		throw new Error("Native split-turn preparation was not generated");
	}
	return prepared;
}

function stubSummary(text: string) {
	return {
		result: async () => ({
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		}),
	};
}

// Pi's compact(preparation, model, apiKey, headers, customInstructions, signal,
// thinkingLevel, streamFn, ...): the capturing handler is passed in the streamFn slot, so no
// provider transport is ever reached.
function runNativeCompact(
	prepared: unknown,
	maxTokens: number,
	onRequest: (
		context: { messages: unknown[] },
		options?: { maxTokens?: number },
	) => unknown,
) {
	return sdkCompaction.compact(
		prepared,
		{
			id: "budget-test",
			provider: "budget-test",
			api: "openai-completions",
			contextWindow: 200_000,
			maxTokens,
		} as never,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		((
			_model: unknown,
			context: { messages: unknown[] },
			options?: { maxTokens?: number },
		) => onRequest(context, options)) as never,
	);
}

const fetchSpy = vi.spyOn(globalThis, "fetch");

afterEach(() => {
	fetchSpy.mockClear();
});

it("pins both summarization fractions to Pi's own requests", async () => {
	const prepared = nativeSplitTurnPreparation();
	expect(prepared.isSplitTurn).toBe(true);
	expect(prepared.messagesToSummarize.length).toBeGreaterThan(0);
	expect(prepared.turnPrefixMessages.length).toBeGreaterThan(0);

	const requests: Array<{ maxTokens: number; isTurnPrefix: boolean }> = [];
	await runNativeCompact(prepared, 200_000, (context, options) => {
		requests.push({
			maxTokens: options?.maxTokens ?? 0,
			// Only Pi's TURN_PREFIX_SUMMARIZATION_PROMPT asks for this section.
			isTurnPrefix: JSON.stringify(context.messages).includes(
				"Context Needed to Continue",
			),
		});
		return stubSummary("## Goal\nstub summary");
	});

	expect(requests.length).toBe(2);
	// Pi issues the history request before the turn-prefix request (compaction.js:693-702), so
	// the order is pinned alongside the prompt marker instead of relying on it alone.
	expect(requests.map((entry) => entry.isTurnPrefix)).toEqual([false, true]);
	// Drift guard for the fractions documented in src/summarization-request-budget.ts:
	// generateSummaryWithUsage reserves floor(0.8 * reserveTokens) = 13_107 and the private
	// generateTurnPrefixSummary reserves floor(0.5 * reserveTokens) = 8_192. maxTokens 200_000
	// keeps the model cap from masking either fraction.
	expect(requests[0]?.maxTokens).toBe(13_107);
	expect(requests[1]?.maxTokens).toBe(8_192);
	expect(fetchSpy).not.toHaveBeenCalled();
});

it("pins the model-cap clamp Pi applies to both requests", async () => {
	const prepared = nativeSplitTurnPreparation();
	const captured: number[] = [];
	await runNativeCompact(prepared, 4096, (_context, options) => {
		captured.push(options?.maxTokens ?? 0);
		return stubSummary("## Goal\nstub summary");
	});

	// Pi clamps both requests to model.maxTokens: min(floor(0.8 * 16_384), 4096) and
	// min(floor(0.5 * 16_384), 4096). clampReservedOutput must keep reproducing that.
	expect(captured).toEqual([4096, 4096]);
	expect(fetchSpy).not.toHaveBeenCalled();
});

it("pins the unclamped requests Pi sends when the model declares no output cap", async () => {
	const prepared = nativeSplitTurnPreparation();
	const captured: number[] = [];
	await runNativeCompact(prepared, 0, (_context, options) => {
		captured.push(options?.maxTokens ?? 0);
		return stubSummary("## Goal\nstub summary");
	});

	// Pi treats a non-positive model cap as no cap at all, so both fractions survive unclamped.
	// clampReservedOutput mirrors that branch and must not silently clamp to zero.
	expect(captured).toEqual([13_107, 8_192]);
	expect(fetchSpy).not.toHaveBeenCalled();
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

it("names a transcript-driven rejection as transcript overflow, not as added intent", async () => {
	const source = user("x".repeat(40_000));
	const budgeted = await budgetOf([source], preparation([source]), 8192);
	expect(budgeted.transcriptOverflow).toBe(true);
});

it("shrinks added evidence instead of reporting a transcript overflow", async () => {
	const source = user("x".repeat(600_000));
	const retained = user("Keep this instruction.".repeat(4000));
	const budgeted = await budgetOf(
		[source, retained],
		{ ...preparation([source]), settings: { reserveTokens: 60_000 } },
		200_000,
	);
	expect(budgeted.transcriptOverflow).toBeUndefined();
	expect(budgeted.evidenceTrimmed).toBe(1);
	expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
	expect(budgeted.focus.intentEvidence?.recentUserTurns).toEqual([]);
});

it("shrinks omitted intent evidence instead of rejecting when a trimmed request fits", async () => {
	const source = user("x".repeat(600_000));
	const retained = [
		user("oldest retained instruction ".repeat(4000)),
		user("middle retained instruction ".repeat(4000)),
		user("latest retained instruction ".repeat(400)),
	];
	const budgeted = await budgetOf(
		[source, ...retained],
		{ ...preparation([source]), settings: { reserveTokens: 60_000 } },
		200_000,
	);
	expect(budgeted.transcriptOverflow).toBeUndefined();
	expect(budgeted.renderedInstructions).toBeTypeOf("string");
	expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
	expect(budgeted.focus.intentEvidence?.recentUserTurns.length).toBeLessThan(
		retained.length,
	);
	expect(budgeted.evidenceTrimmed).toBeTypeOf("number");
});

it("drops the oldest evidence first when a smaller trim is enough", async () => {
	const source = user("x".repeat(600_000));
	const retained = [
		user("oldest retained instruction ".repeat(4000)),
		user("latest retained instruction ".repeat(40)),
	];
	const budgeted = await budgetOf(
		[source, ...retained],
		{ ...preparation([source]), settings: { reserveTokens: 50_000 } },
		200_000,
	);
	expect(budgeted.evidenceTrimmed).toBe(1);
	expect(budgeted.focus.intentEvidence?.recentUserTurns).toEqual([
		retained[1].content.trim(),
	]);
});

it("still rejects when the request cannot fit even with all added evidence dropped", async () => {
	const source = user("x".repeat(600_000));
	const retained = user("Keep this instruction.".repeat(4000));
	const budgeted = await prepareBudgetedCompactionFocus(
		[source, retained],
		{ ...preparation([source]), settings: { reserveTokens: 60_000 } },
		{
			model: {
				id: "budget-test",
				provider: "budget-test",
				api: "openai-completions",
				contextWindow: 199_000,
				maxTokens: 199_000,
			} as Parameters<typeof generateSummaryWithUsage>[1],
			renderInstructions: () => "oversized base prompt ".repeat(20_000),
		},
	);
	// No trim fits, not even with every retained turn dropped: what is left is the
	// transcript plus the base prompt, so this is a request overflow the coordinator
	// judges against the payload Pi sends, not an evidence-driven rejection.
	expect(budgeted.transcriptOverflow).toBe(true);
	expect(budgeted.renderedInstructions).toBeUndefined();
	expect(budgeted.focus.intentEvidence?.overflow).toBe(true);
	expect(budgeted.focus.intentEvidence?.recentUserTurns).toEqual([]);
});

it("still rejects when even the trimmed request cannot fit", async () => {
	const source = user("x".repeat(600_000));
	const retained = [user("a".repeat(100_000)), user("b".repeat(100_000))];
	const budgeted = await budgetOf(
		[source, ...retained],
		{ ...preparation([source]), settings: { reserveTokens: 100_000 } },
		200_000,
	);
	expect(budgeted.transcriptOverflow).toBe(true);
	expect(budgeted.renderedInstructions).toBeUndefined();
	expect(budgeted.focus.intentEvidence?.overflow).toBe(true);
	expect(budgeted.focus.intentEvidence?.recentUserTurns).toEqual([]);
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
	const budgeted = await budgetOf(
		[source, retained],
		{ ...preparation([source]), settings: { reserveTokens: 60_000 } },
		200_000,
	);
	// The configured 60k reserve leaves no room for the added evidence, so the
	// evidence is trimmed rather than the cut being declared oversized.
	expect(budgeted.transcriptOverflow).toBeUndefined();
	expect(budgeted.evidenceTrimmed).toBe(1);
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

it("omits only the exact generated continuation after verifying the native prefix", async () => {
	const source = user("Task: repair login.");
	const generated = user(CONTINUATION_PROMPT);
	const real = user(`${CONTINUATION_PROMPT} Preserve the audit constraints.`);
	for (const supplied of [[source], [source, generated]]) {
		const focus = await extractCompactionFocus(
			[source, generated, real],
			preparation(supplied),
			200_000,
		);
		expect(focus.intentEvidence?.overflow).toBeUndefined();
		expect(focus.intentEvidence?.recentUserTurns).toEqual([real.content]);
	}
});

it("caps evidence rather than cancelling when a retained paste alone exceeds the window", async () => {
	const unit = "old context ";
	const sized = (target: number) => {
		let text = "";
		while (
			estimateTokens({ role: "user", content: text, timestamp: 1 }) < target
		) {
			text += unit.repeat(2_000);
		}
		return text;
	};
	const source = user("Task: repair login.");
	const older = user("Preserve the audit constraints.");
	const tooBig = user(sized(260_000));
	const recent = user(sized(60_000));

	// The lower bound says this much evidence cannot fit. That is a reason to cap the
	// evidence, not to discard the compaction: the cut itself is small and still fits. The
	// oversized paste cannot fit at any budget position, so it is the turn that gets dropped;
	// the older turn that still fits survives.
	const budgeted = await budgetOf(
		[source, older, tooBig, recent],
		preparation([source]),
		200_000,
	);
	expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
	expect(budgeted.renderedInstructions).toBeDefined();
	expect(budgeted.focus.intentEvidence?.recentUserTurns).toEqual([
		older.content,
		recent.content.trim(),
	]);
	// The cap is reported, so a session can see that evidence was dropped rather than
	// inferring it from a shorter summary.
	expect(budgeted.evidenceTrimmed).toBe(1);
});

it("keeps an older turn when the newest retained turn alone cannot fit", async () => {
	const unit = "old context ";
	let huge = "";
	while (
		estimateTokens({ role: "user", content: huge, timestamp: 1 }) < 260_000
	) {
		huge += unit.repeat(2_000);
	}
	const source = user("Task: repair login.");
	const older = user("Preserve the audit constraints.");
	const newest = user(huge);

	// The cap skips the turn that cannot fit, so an oversized newest turn costs itself
	// rather than everything older than it.
	const budgeted = await budgetOf(
		[source, older, newest],
		preparation([source]),
		200_000,
	);
	expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
	expect(budgeted.focus.intentEvidence?.recentUserTurns).toEqual([
		older.content,
	]);
	expect(budgeted.evidenceTrimmed).toBe(1);
});

it("keeps evidence that fits the clamped output budget the measurement actually uses", async () => {
	const unit = "old context ";
	const sized = (target: number) => {
		let text = "";
		while (
			estimateTokens({ role: "user", content: text, timestamp: 1 }) < target
		) {
			text += unit.repeat(2_000);
		}
		return text;
	};
	const source = user("Task: repair login.");
	// reserveTokens is 16_384 and maxTokens is the whole window here, so the binding term is
	// Pi's floor(0.8 * reserveTokens) = 13_107 rather than the model cap. Evidence between
	// 186_893 and 183_616 tokens fits that budget but not the unclamped reserve.
	const evidence = user(sized(185_000));
	const budgeted = await budgetOf(
		[source, evidence],
		preparation([source]),
		200_000,
	);
	expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
	expect(budgeted.focus.intentEvidence?.recentUserTurns).toEqual([
		evidence.content.trim(),
	]);
	expect(budgeted.evidenceTrimmed).toBeUndefined();
});

it("caps evidence against the model output cap when the cap is the binding term", async () => {
	const unit = "old context ";
	let evidenceText = "";
	while (
		estimateTokens({ role: "user", content: evidenceText, timestamp: 1 }) <
		187_000
	) {
		evidenceText += unit.repeat(200);
	}
	const source = user("Task: repair login.");
	const evidence = user(evidenceText);

	// maxTokens 4096 is below floor(0.8 * 16_384), so the clamp is what binds: the evidence cap
	// is 200_000 - 4096 = 195_904. The sizing loop steps in 600-token increments (12-char unit
	// x 200 repeats), so it exits at 187_200 and leaves 8_704 of slack instead of the ~3.9k a
	// coarser step left. Against the unclamped 13_107 the cap is 186_893, so the same turn is
	// dropped; the paired call pins that instead of leaving it to this comment.
	const prepared = preparation([source]);
	const clamped = await budgetOf([source, evidence], prepared, 200_000, 4096);
	expect(clamped.focus.intentEvidence?.overflow).toBeUndefined();
	expect(clamped.focus.intentEvidence?.recentUserTurns).toEqual([
		evidence.content.trim(),
	]);
	expect(clamped.evidenceTrimmed).toBeUndefined();

	// Same transcript with the model cap lifted, so floor(0.8 * 16_384) binds instead of the
	// clamp. The turn no longer fits and is dropped.
	const uncapped = await budgetOf([source, evidence], prepared, 200_000);
	expect(uncapped.focus.intentEvidence?.recentUserTurns).toEqual([]);
	expect(uncapped.evidenceTrimmed).toBe(1);
});

it("counts cap drops and trim-search drops together", async () => {
	const unit = "old context ";
	const sized = (target: number) => {
		let text = "";
		while (
			estimateTokens({ role: "user", content: text, timestamp: 1 }) < target
		) {
			text += unit.repeat(2_000);
		}
		return text;
	};
	// A transcript large enough that the admitted evidence no longer fits alongside it,
	// plus a retained turn the cap never admits.
	const cut = user(sized(150_000));
	const admitted = user("Preserve the audit constraints.".repeat(8000));
	const oversized = user(sized(260_000));

	const budgeted = await budgetOf(
		[cut, admitted, oversized],
		preparation([cut]),
		200_000,
	);
	expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
	expect(budgeted.focus.intentEvidence?.recentUserTurns).toEqual([]);
	// One turn never entered the evidence, one entered it and was trimmed by the search.
	expect(budgeted.evidenceTrimmed).toBe(2);
});

it("counts every dropped turn when the native prefix cannot be verified", async () => {
	const unit = "old context ";
	const sized = (target: number) => {
		let text = "";
		while (
			estimateTokens({ role: "user", content: text, timestamp: 1 }) < target
		) {
			text += unit.repeat(2_000);
		}
		return text;
	};
	const projected = [user("Task: repair login."), user(sized(60_000))];
	// The cut does not match the projected prefix, so containment is unverifiable and the
	// count must stay conservative rather than subtracting turns assumed to be inside the cut.
	const cut = user(sized(150_000));
	const budgeted = await budgetOf(projected, preparation([cut]), 200_000);
	expect(budgeted.focus.intentEvidence?.overflow).toBeUndefined();
	expect(budgeted.focus.intentEvidence?.recentUserTurns).toEqual([]);
	expect(budgeted.evidenceTrimmed).toBe(projected.length);
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
