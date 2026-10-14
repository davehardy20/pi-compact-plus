/**
 * Classification of summarization request failures.
 *
 * Pi's overflow classifier misses some provider shapes. The local llama.cpp-style
 * server reports `prompt (300932 tokens) + max tokens (1) exceeds the context
 * (262144)`, which matches none of Pi's `OVERFLOW_PATTERNS` (they need the word
 * "window") and is not retryable either. Unclassified, it flattens to a generic
 * provider error and the identical oversized payload is handed straight back to
 * native Pi compaction.
 *
 * Classification only: reasons are stable constants and never embed provider
 * text, so credentials or payload fragments cannot leak into telemetry.
 */

export type SummarizationFailureClass =
	| "context-overflow"
	| "output-cap"
	| "provider-error";

export const SUMMARIZATION_CONTEXT_OVERFLOW_REASON =
	"summarization request exceeded the model context window";

export const SUMMARIZATION_OUTPUT_CAP_REASON =
	"summarization output budget was exhausted";

/**
 * Not a failure: Compact+ dropped some of the additional intent evidence it adds
 * itself so the request could fit. Recorded so a live session can tell a trimmed
 * compaction apart from a declined one.
 */
export const SUMMARIZATION_EVIDENCE_TRIMMED_REASON =
	"intent evidence was trimmed to fit the summary request";

/** Compact+'s own optional intent evidence is what did not fit, not the transcript. */
export const SUMMARIZATION_INTENT_EVIDENCE_REASON =
	"additional intent evidence exceeds the summary request budget";

/**
 * Not a cancel: the estimate said the request could not fit, but provider-reported
 * usage sat comfortably under the window, so the estimate was not treated as
 * sufficient authority to decline compaction. Recorded so a live session can see that
 * the discrepancy happened.
 */
export const SUMMARIZATION_SUSPECT_ESTIMATE_REASON =
	"summarization estimate exceeded the window while provider usage reported headroom";

/** `prompt (300932 tokens) + max tokens (1) exceeds the context (262144)` */
const CONTEXT_OVERFLOW_PATTERNS = [
	/prompt \(\d[\d,]* tokens\) \+ max tokens \(\d[\d,]*\) exceeds the context \(\d[\d,]*\)/i,
	// Companion clause: the server found no room left for any output at all.
	/max_tokens \(at most 0 here\)/i,
];

/** Pi's own failure text when the clamped output budget left nothing to answer with. */
const OUTPUT_CAP_PATTERNS = [/generation hit the token cap/i];

function failureText(error: unknown): string {
	if (error instanceof Error) return error.message ?? "";
	if (typeof error === "string") return error;
	return "";
}

export function classifySummarizationFailure(
	error: unknown,
): SummarizationFailureClass {
	const message = failureText(error);
	if (!message) return "provider-error";
	if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) {
		return "context-overflow";
	}
	if (OUTPUT_CAP_PATTERNS.some((pattern) => pattern.test(message))) {
		return "output-cap";
	}
	return "provider-error";
}

export function summarizationFailureReason(
	kind: SummarizationFailureClass,
): string | null {
	if (kind === "context-overflow") return SUMMARIZATION_CONTEXT_OVERFLOW_REASON;
	if (kind === "output-cap") return SUMMARIZATION_OUTPUT_CAP_REASON;
	return null;
}
