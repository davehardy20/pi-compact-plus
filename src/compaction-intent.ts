import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	convertToLlm,
	estimateTokens,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { extractCurrentFocus, extractTextContent } from "./session-evidence.js";
import type { CurrentFocus } from "./types.js";

interface IntentPreparation {
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	previousSummary?: string;
	settings?: { reserveTokens: number };
}

const MAX_EVIDENCE_BYTES = 256 * 1024;
const REQUEST_RESERVE_TOKENS = 16_384;

function textTokens(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

/** User text already in the summary request needs no second copy in its prompt. */
export function extractCompactionFocus(
	projected: AgentMessage[],
	preparation: IntentPreparation,
	contextWindow: number,
): CurrentFocus {
	const focus = extractCurrentFocus(projected);
	const source = preparation.isSplitTurn
		? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
		: preparation.messagesToSummarize;
	let boundary = -1;
	for (let index = projected.length - 1; index >= 0; index--) {
		if (projected[index].role === "compactionSummary") {
			boundary = index;
			break;
		}
	}
	const users = projected.slice(boundary + 1).filter((m) => m.role === "user");
	const supplied = source.filter((m) => m.role === "user");
	// Remove only a verified chronological prefix, never a text-keyed set:
	// repeated identical requests and unknown later redirects must survive.
	const prefixMatches = supplied.every(
		(message, index) =>
			users[index] &&
			extractTextContent(message) === extractTextContent(users[index]),
	);
	const omitted = prefixMatches ? users.slice(supplied.length) : users;
	const evidence = extractCurrentFocus(
		omitted,
		MAX_EVIDENCE_BYTES,
	).intentEvidence;
	const transcript = serializeConversation(convertToLlm(source));
	// Keep units consistent with Pi's token estimator. Previous memory appears
	// in both Pi's prompt and Compact+'s merging guidance. The caller supplies
	// the normalized memory actually sent, not an oversized historical draft.
	const reserve = Math.max(
		REQUEST_RESERVE_TOKENS,
		preparation.settings?.reserveTokens ?? 0,
	);
	const available = Number.isSafeInteger(contextWindow)
		? contextWindow -
			textTokens(transcript) -
			2 * textTokens(preparation.previousSummary ?? "") -
			reserve
		: 0;
	const evidenceTokens =
		evidence?.recentUserTurns.reduce(
			(total, turn) => total + textTokens(turn) + 48,
			0,
		) ?? 0;
	const overflow =
		evidence?.overflow || evidenceTokens > Math.max(0, available);
	return {
		...focus,
		intentEvidence: focus.intentEvidence
			? {
					priorObjective: focus.objective,
					certainty: focus.intentEvidence.certainty,
					recentUserTurns: overflow ? [] : (evidence?.recentUserTurns ?? []),
					...(overflow ? { overflow: true } : {}),
				}
			: undefined,
	};
}

/** Trigger-time hints cannot budget evidence until Pi has selected its cut. */
export function extractTriggerFocus(projected: AgentMessage[]): CurrentFocus {
	// Retain bounded trigger evidence for native compatibility fallback. Its
	// overflow marker is uncertainty, not a reason to reject before the cut.
	return extractCurrentFocus(projected);
}
