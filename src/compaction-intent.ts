import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	generateSummaryWithUsage,
} from "@earendil-works/pi-coding-agent";
import { extractCurrentFocus, extractTextContent } from "./session-evidence.js";
import { CONTINUATION_PROMPT, type CurrentFocus } from "./types.js";

interface IntentPreparation {
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	previousSummary?: string;
	settings: { reserveTokens: number };
}

type SummaryModel = Parameters<typeof generateSummaryWithUsage>[1];
type SummaryThinking = Parameters<typeof generateSummaryWithUsage>[8];
type UnifiedPreparation<T extends IntentPreparation> = Omit<
	T,
	"messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn"
> & {
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: false;
};

interface BudgetedIntent<T extends IntentPreparation> {
	focus: CurrentFocus;
	preparation: UnifiedPreparation<T>;
	/** Reuse verbatim; absent on every failed or oversized capture. */
	renderedInstructions?: string;
}

function overflowFocus(focus: CurrentFocus): CurrentFocus {
	return {
		...focus,
		intentEvidence: {
			priorObjective: focus.objective,
			certainty: focus.intentEvidence?.certainty ?? "provisional",
			recentUserTurns: [],
			overflow: true,
		},
	};
}

/** Select complete chronological evidence; capture the exact public SDK request. */
export async function prepareBudgetedCompactionFocus<
	T extends IntentPreparation,
>(
	projected: AgentMessage[],
	preparation: T,
	options: {
		model: SummaryModel | null | undefined;
		thinkingLevel?: SummaryThinking;
		renderInstructions: (focus: CurrentFocus) => string;
	},
): Promise<BudgetedIntent<T>> {
	const originalFocus = extractCurrentFocus(projected);
	const source = preparation.isSplitTurn
		? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
		: preparation.messagesToSummarize;
	const unified: UnifiedPreparation<T> = {
		...preparation,
		messagesToSummarize: source,
		turnPrefixMessages: [],
		isSplitTurn: false,
	};
	const reject = (): BudgetedIntent<T> => ({
		focus: overflowFocus(originalFocus),
		preparation: unified,
	});
	const model = options.model;
	const reserve = preparation.settings?.reserveTokens;
	if (
		!model ||
		!Number.isSafeInteger(model.contextWindow) ||
		model.contextWindow <= 0 ||
		!Number.isSafeInteger(model.maxTokens) ||
		model.maxTokens < 0 ||
		!Number.isSafeInteger(reserve) ||
		reserve <= 0
	) {
		return reject();
	}
	let boundary = -1;
	for (let index = projected.length - 1; index >= 0; index--) {
		if (projected[index].role === "compactionSummary") {
			boundary = index;
			break;
		}
	}
	const users = projected.slice(boundary + 1).filter((m) => m.role === "user");
	const supplied = source.filter((m) => m.role === "user");
	// Native cuts cover a prefix after the canonical compaction boundary;
	// retained raw entries are already inside that projected cut domain.
	// Verify it, never use a text-keyed set or remove a middle subsequence:
	// unknown provenance keeps complete user order, including later repeats.
	const prefixMatches = supplied.every(
		(message, index) =>
			users[index] &&
			extractTextContent(message) === extractTextContent(users[index]),
	);
	const omitted = prefixMatches ? users.slice(supplied.length) : users;
	const recentUserTurns: string[] = [];
	let evidenceLowerBound = 0;
	for (const message of omitted) {
		const text = extractTextContent(message).trim();
		if (!text || text === CONTINUATION_PROMPT) continue;
		// Discount one rounding unit per turn. SDK text-only estimates then
		// lower-bound the combined complete evidence, before any wrappers.
		evidenceLowerBound += Math.max(
			0,
			estimateTokens({ role: "user", content: text, timestamp: 0 }) - 1,
		);
		// Avoid constructing an already-impossible native request; the full
		// SDK capture below remains the authoritative fit check.
		if (evidenceLowerBound > model.contextWindow) return reject();
		recentUserTurns.push(text);
	}
	const focus: CurrentFocus = {
		...originalFocus,
		intentEvidence: originalFocus.intentEvidence
			? {
					priorObjective: originalFocus.objective,
					certainty: originalFocus.intentEvidence.certainty,
					recentUserTurns,
				}
			: undefined,
	};
	const marker = new Error("Compact+ local request-budget capture");
	let captures = 0;
	let totalTokens: number | undefined;
	let renderedInstructions: string | undefined;
	try {
		renderedInstructions = options.renderInstructions(focus);
		if (
			typeof renderedInstructions !== "string" ||
			!renderedInstructions.trim()
		) {
			return reject();
		}
		await generateSummaryWithUsage(
			source,
			model,
			reserve,
			undefined,
			undefined,
			undefined,
			renderedInstructions,
			preparation.previousSummary,
			options.thinkingLevel,
			(_model, context, requestOptions) => {
				captures++;
				const output = requestOptions?.maxTokens;
				if (
					Number.isSafeInteger(output) &&
					(output ?? 0) > 0 &&
					context.messages.some((message) => message.role === "system")
				) {
					totalTokens = context.messages.reduce(
						(total, message) => total + estimateTokens(message),
						output ?? 0,
					);
				}
				// No registry, credentials, transport, provider, or network call.
				// Undefined retry yields one attempt. Wrapped markers fail closed.
				throw marker;
			},
		);
		return reject();
	} catch (error) {
		if (
			error !== marker ||
			captures !== 1 ||
			!Number.isSafeInteger(totalTokens) ||
			(totalTokens ?? -1) < 0 ||
			(totalTokens ?? Number.POSITIVE_INFINITY) > model.contextWindow
		) {
			return reject();
		}
	}
	return { focus, preparation: unified, renderedInstructions };
}

/** Trigger-time hints cannot budget evidence until Pi has selected its cut. */
export function extractTriggerFocus(projected: AgentMessage[]): CurrentFocus {
	return extractCurrentFocus(projected);
}
