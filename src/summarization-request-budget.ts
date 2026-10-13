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
	/** Output tokens the summarization call reserves for the summary. */
	reservedOutputTokens: number;
	/** transcript + reserved output: what the provider must fit in one request. */
	totalTokens: number;
}

/**
 * Measure the exact summarization request Pi would send, without contacting a
 * provider. The public SDK builds the request, then the injected stream function
 * captures the assembled context and throws before any registry, credential,
 * transport, or network work happens.
 *
 * Estimates come from `estimateTokens` (characters / 4), so they can err in
 * either direction: dense content such as base64 or minified JSON tokenizes
 * denser than 4 chars/token, prose with punctuation and markup tokenizes
 * sparser. The guard only trips above the full `contextWindow`, not Pi's
 * `contextWindow - reserveTokens` compaction trigger, which is what keeps a
 * false-positive cancel unlikely.
 */
export async function measureSummaryRequestTokens(options: {
	messages: AgentMessage[];
	model: SummaryModel | null | undefined;
	reserveTokens: unknown;
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
			undefined,
			options.customInstructions,
			options.previousSummary,
			options.thinkingLevel,
			(_model, context, requestOptions) => {
				captures++;
				const output = requestOptions?.maxTokens;
				if (
					Number.isSafeInteger(output) &&
					(output ?? 0) > 0 &&
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
			(reservedOutputTokens ?? 0) <= 0
		) {
			return undefined;
		}
		const transcript = transcriptTokens as number;
		const output = reservedOutputTokens as number;
		return {
			transcriptTokens: transcript,
			reservedOutputTokens: output,
			totalTokens: transcript + output,
		};
	}
}
