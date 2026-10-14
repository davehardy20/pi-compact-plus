import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { extractCurrentFocus, extractTextContent } from "./session-evidence.js";
import {
	measureSummaryRequestTokens,
	type SummaryModel,
	type SummaryThinking,
} from "./summarization-request-budget.js";
import { CONTINUATION_PROMPT, type CurrentFocus } from "./types.js";

interface IntentPreparation {
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	previousSummary?: string;
	settings: { reserveTokens: number };
}

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
	/** The cut itself cannot fit the window, with or without added intent evidence. */
	transcriptOverflow?: true;
	/** Omitted turns dropped from the front so the request could fit. */
	evidenceTrimmed?: number;
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
		signal?: AbortSignal;
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
	const reject = (transcriptOverflow?: true): BudgetedIntent<T> => ({
		focus: overflowFocus(originalFocus),
		preparation: unified,
		...(transcriptOverflow ? { transcriptOverflow } : {}),
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
	const withEvidence = (turns: string[]): CurrentFocus => ({
		...originalFocus,
		intentEvidence: originalFocus.intentEvidence
			? {
					priorObjective: originalFocus.objective,
					certainty: originalFocus.intentEvidence.certainty,
					recentUserTurns: turns,
				}
			: undefined,
	});
	const measure = (instructions?: string) =>
		measureSummaryRequestTokens({
			messages: source,
			model,
			reserveTokens: reserve,
			...(instructions === undefined
				? {}
				: { customInstructions: instructions }),
			previousSummary: preparation.previousSummary,
			thinkingLevel: options.thinkingLevel,
			...(options.signal ? { signal: options.signal } : {}),
		});
	const render = (turns: string[]): string | undefined => {
		try {
			const instructions = options.renderInstructions(withEvidence(turns));
			return typeof instructions === "string" && instructions.trim()
				? instructions
				: undefined;
		} catch {
			return undefined;
		}
	};
	const focus = withEvidence(recentUserTurns);
	const renderedInstructions = render(recentUserTurns);
	if (!renderedInstructions) return reject();
	const measurement = await measure(renderedInstructions);
	// No registry, credentials, transport, provider, or network call happens
	// during the capture. An unmeasurable request fails closed: never hand an
	// unchecked cut to a provider.
	if (!measurement) return reject();
	if (measurement.totalTokens <= model.contextWindow) {
		return { focus, preparation: unified, renderedInstructions };
	}
	// Separate transcript-driven from evidence-driven rejection: re-measure the
	// same cut carrying no custom instructions. If it still cannot fit, the
	// transcript is the cause, not the evidence Compact+ chose to add.
	const baseline = await measure();
	if (baseline && baseline.totalTokens > model.contextWindow) {
		return reject(true);
	}
	// Evidence-driven: shrink what Compact+ added, oldest turns first, and re-measure.
	// Discarding the whole compaction because Compact+'s own optional additions did not
	// fit is worse than a shorter summary, so only a cut that cannot fit without them is
	// terminal. Dropping more turns never lengthens the request, so a binary search
	// finds the smallest trim that fits in log2(n) measurements instead of over-trimming
	// on a geometric schedule. Each probe re-serializes the cut, so the probe count is the
	// cost bound: 32 turns cost 5 probes and 256 cost 8. Rendering is monotone in drop count only up to formatting
	// differences between focus blocks, so a search that lands on a slightly larger trim
	// still yields a fitting request, never one that is too large.
	let low = 1;
	let high = recentUserTurns.length;
	let fitted:
		| { dropped: number; kept: string[]; instructions: string }
		| undefined;
	let probeFailed = false;
	while (low <= high) {
		// An aborted request must not keep probing: every probe re-serializes the cut.
		if (options.signal?.aborted) {
			probeFailed = true;
			break;
		}
		const dropped = (low + high) >> 1;
		const kept = recentUserTurns.slice(dropped);
		const instructions = render(kept);
		if (!instructions) {
			probeFailed = true;
			break;
		}
		const trimmed = await measure(instructions);
		// Fail closed: an unmeasurable rendering is never sent to a provider.
		if (!trimmed) {
			probeFailed = true;
			break;
		}
		if (trimmed.totalTokens <= model.contextWindow) {
			fitted = { dropped, kept, instructions };
			high = dropped - 1;
		} else {
			low = dropped + 1;
		}
	}
	if (fitted) {
		return {
			focus: withEvidence(fitted.kept),
			preparation: unified,
			renderedInstructions: fitted.instructions,
			evidenceTrimmed: fitted.dropped,
		};
	}
	// A probe that could not render or measure says nothing about the trim schedule, so it
	// stays an evidence-driven rejection rather than a claim about the transcript.
	if (probeFailed) return reject();
	// No trim fits, not even dropping every retained turn. What is left is the transcript
	// plus Compact+'s base prompt, so this is not evidence-driven: report it as a request
	// overflow and let the coordinator judge it against the payload Pi actually sends.
	return reject(true);
}

/** Trigger-time hints cannot budget evidence until Pi has selected its cut. */
export function extractTriggerFocus(projected: AgentMessage[]): CurrentFocus {
	return extractCurrentFocus(projected);
}
