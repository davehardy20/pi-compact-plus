import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	generateSummaryWithUsage,
} from "@earendil-works/pi-coding-agent";

export type SummaryModel = Parameters<typeof generateSummaryWithUsage>[1];
export type SummaryThinking = Parameters<typeof generateSummaryWithUsage>[8];

export interface SummaryRequestMeasurement {
	/** Estimated tokens of the rendered summarization request itself. */
	transcriptTokens: number;
	/**
	 * Output tokens the request actually reserves, clamped the way Pi clamps the
	 * request it sends: `min(fraction * reserveTokens, model.maxTokens)` when the
	 * model declares a positive cap.
	 */
	reservedOutputTokens: number;
	/** transcript + clamped reserved output: what the provider must fit in one request. */
	totalTokens: number;
}

/**
 * The output budget Pi reserves for a summarization request: `floor(0.8 * reserveTokens)`.
 * The split-turn prefix request uses a different fraction; see
 * `piReservedTurnPrefixOutputTokens`.
 */
export function piReservedOutputTokens(reserveTokens: number): number {
	return Math.floor(0.8 * reserveTokens);
}

/**
 * Pi builds the split-turn prefix request through a private helper that reserves
 * `floor(0.5 * reserveTokens)` rather than the 0.8 fraction used for the summary itself.
 */
export function piReservedTurnPrefixOutputTokens(
	reserveTokens: number,
): number {
	return Math.floor(0.5 * reserveTokens);
}

/**
 * Pi clamps every summarization request to the model's own output cap. A model with no
 * output cap leaves the request unclamped. Shared so the measurement and the
 * intent-evidence cap cannot drift apart.
 */
export function clampReservedOutput(
	model: { maxTokens: number },
	requested: number,
): number {
	return model.maxTokens > 0 ? Math.min(requested, model.maxTokens) : requested;
}

/**
 * Measure the exact summarization request Pi would send, without contacting a
 * provider. The public SDK builds the request, then the injected stream function
 * captures the assembled context and throws before any registry, credential,
 * transport, or network work happens.
 *
 * Estimates come from `estimateTokens` (characters / 4), so they can err in
 * either direction: base64 or minified JSON tokenizes denser than 4 chars/token,
 * prose with punctuation and markup sparser. The guard trips only above the full
 * `contextWindow`, not Pi's `contextWindow - reserveTokens` trigger, which is
 * what keeps a false-positive cancel unlikely.
 */
export async function measureSummaryRequestTokens(options: {
	messages: AgentMessage[];
	model: SummaryModel | null | undefined;
	reserveTokens: unknown;
	/**
	 * Replace the captured output budget. Clamped to the model's own cap before use,
	 * exactly as Pi clamps it. See `piReservedOutputTokens` and
	 * `piReservedTurnPrefixOutputTokens` for the fractions Pi itself uses.
	 */
	reservedOutputTokens?: number;
	signal?: AbortSignal;
	customInstructions?: string;
	previousSummary?: string;
	thinkingLevel?: SummaryThinking;
}): Promise<SummaryRequestMeasurement | undefined> {
	const model = options.model;
	const reserve = options.reserveTokens;
	if (
		!model ||
		!Number.isSafeInteger(model.contextWindow) ||
		model.contextWindow <= 0 ||
		!Number.isSafeInteger(model.maxTokens) ||
		model.maxTokens < 0 ||
		!Number.isSafeInteger(reserve) ||
		(reserve as number) <= 0
	) {
		return undefined;
	}

	const marker = new Error("Compact+ summary request budget capture");
	let captures = 0;
	let transcriptTokens: number | undefined;
	let reservedOutputTokens: number | undefined;

	try {
		await generateSummaryWithUsage(
			options.messages,
			model,
			reserve as number,
			undefined,
			undefined,
			options.signal,
			options.customInstructions,
			options.previousSummary,
			options.thinkingLevel,
			(_model, context, requestOptions) => {
				captures++;
				const output = requestOptions?.maxTokens;
				// A zero output budget is a measurement, not a failure: it means the
				// request left no room for the summary at all.
				if (
					Number.isSafeInteger(output) &&
					(output ?? 0) >= 0 &&
					context.messages.some((message) => message.role === "system")
				) {
					transcriptTokens = context.messages.reduce(
						(total, message) => total + estimateTokens(message),
						0,
					);
					reservedOutputTokens = output ?? 0;
				}
				throw marker;
			},
		);
		return undefined;
	} catch (error) {
		if (
			error !== marker ||
			captures !== 1 ||
			!Number.isSafeInteger(transcriptTokens) ||
			(transcriptTokens ?? -1) < 0 ||
			!Number.isSafeInteger(reservedOutputTokens) ||
			(reservedOutputTokens ?? -1) < 0
		) {
			return undefined;
		}
		const transcript = transcriptTokens as number;
		const override = options.reservedOutputTokens;
		const requested =
			Number.isSafeInteger(override) && (override ?? 0) >= 0
				? (override as number)
				: (reservedOutputTokens as number);
		const output = clampReservedOutput(model, requested);
		return {
			transcriptTokens: transcript,
			reservedOutputTokens: output,
			totalTokens: transcript + output,
		};
	}
}
