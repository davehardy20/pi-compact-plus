/**
 * Classification of summarization request failures.
 *
 * Pi's own overflow classifier does not recognise every provider shape. The
 * local llama.cpp-style server used for Compact+ sessions reports context
 * overflow as:
 *   prompt (300932 tokens) + max tokens (1) exceeds the context (262144)
 * which matches none of Pi's `OVERFLOW_PATTERNS` (`exceeds the context window`
 * requires the word "window"), and is not retryable either. Without a local
 * classification the failure is flattened to a generic provider error and the
 * identical oversized payload is handed straight back to native Pi compaction.
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
