import type { SummarizerInput } from "./summarizer.js";

export interface SummaryParseSuccess {
	ok: true;
	summaries: Map<string, string>;
}

export interface SummaryParseFailure {
	ok: false;
	error: string;
}

export type SummaryParseResult = SummaryParseSuccess | SummaryParseFailure;

export interface SummaryResponseParser {
	parse(
		responseText: string,
		inputs: SummarizerInput[],
		maxCharsPerSummary: number,
	): SummaryParseResult;
}

interface KnownInputIndex {
	byRecordId: Map<string, SummarizerInput>;
	byShortRef: Map<string, SummarizerInput>;
}

interface ParsedSummaryEntry {
	recordId?: string;
	ref?: string;
	summary: unknown;
}

export const structuredSummaryResponseParser: SummaryResponseParser = {
	parse: parseSummariesFromResponse,
};

export function parseSummariesFromResponse(
	responseText: string,
	inputs: SummarizerInput[],
	maxCharsPerSummary: number,
): SummaryParseResult {
	const index = buildInputIndex(inputs);
	const jsonCandidate = extractJsonCandidate(responseText);
	if (jsonCandidate) {
		const parsedJson = parseJsonSummaries(
			jsonCandidate,
			inputs,
			index,
			maxCharsPerSummary,
		);
		if (parsedJson.ok) return parsedJson;
		return parseMarkdownSummaries(
			responseText,
			inputs,
			index,
			maxCharsPerSummary,
			parsedJson.error,
		);
	}

	return parseMarkdownSummaries(
		responseText,
		inputs,
		index,
		maxCharsPerSummary,
	);
}

function buildInputIndex(inputs: SummarizerInput[]): KnownInputIndex {
	return {
		byRecordId: new Map(inputs.map((input) => [input.recordId, input])),
		byShortRef: new Map(inputs.map((input) => [input.shortRef, input])),
	};
}

function extractJsonCandidate(responseText: string): string | null {
	const trimmed = responseText.trim();
	if (!trimmed) return null;

	const fencedJson = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fencedJson?.[1]) {
		const fencedBody = fencedJson[1].trim();
		if (looksJsonLike(fencedBody)) return fencedBody;
	}

	if (looksJsonLike(trimmed)) return trimmed;
	return null;
}

function looksJsonLike(value: string): boolean {
	return (
		(value.startsWith("{") && value.endsWith("}")) ||
		(value.startsWith("[") && value.endsWith("]"))
	);
}

function parseJsonSummaries(
	jsonText: string,
	inputs: SummarizerInput[],
	index: KnownInputIndex,
	maxCharsPerSummary: number,
): SummaryParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `malformed JSON summaries: ${message}` };
	}

	const entries = extractJsonSummaryEntries(parsed);
	if (!entries) {
		return {
			ok: false,
			error:
				'JSON summaries must be an array or an object with a "summaries" array/object',
		};
	}

	return buildSummaryMap(entries, inputs, index, maxCharsPerSummary);
}

function extractJsonSummaryEntries(
	parsed: unknown,
): ParsedSummaryEntry[] | null {
	if (Array.isArray(parsed)) {
		return parsed.map((entry) => normalizeJsonEntry(entry));
	}

	if (!isRecord(parsed)) return null;
	const summaries = parsed.summaries;

	if (Array.isArray(summaries)) {
		return summaries.map((entry) => normalizeJsonEntry(entry));
	}

	if (isRecord(summaries)) {
		return Object.entries(summaries).map(([key, value]) => {
			const entry = normalizeJsonEntry(value);
			return {
				...entry,
				recordId: entry.recordId ?? (key.startsWith("t") ? undefined : key),
				ref: entry.ref ?? (key.startsWith("t") ? key : undefined),
			};
		});
	}

	return null;
}

function normalizeJsonEntry(entry: unknown): ParsedSummaryEntry {
	if (typeof entry === "string") {
		return { summary: entry };
	}

	if (!isRecord(entry)) {
		return { summary: undefined };
	}

	const recordId =
		typeof entry.recordId === "string" ? entry.recordId : undefined;
	const ref =
		typeof entry.ref === "string"
			? entry.ref
			: typeof entry.shortRef === "string"
				? entry.shortRef
				: undefined;
	return {
		recordId,
		ref,
		summary: entry.summary,
	};
}

function parseMarkdownSummaries(
	responseText: string,
	inputs: SummarizerInput[],
	index: KnownInputIndex,
	maxCharsPerSummary: number,
	jsonError?: string,
): SummaryParseResult {
	const matches = findMarkdownHeadingMatches(responseText);
	if (matches.length === 0) {
		return {
			ok: false,
			error: jsonError
				? `${jsonError}; no markdown summary headings found`
				: "no markdown summary headings found",
		};
	}

	const entries: ParsedSummaryEntry[] = [];
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		const start = match.headingEnd;
		const end = matches[i + 1]?.headingStart ?? responseText.length;
		entries.push({
			ref: match.ref,
			summary: responseText.slice(start, end).trim(),
		});
	}

	return buildSummaryMap(entries, inputs, index, maxCharsPerSummary);
}

function findMarkdownHeadingMatches(
	responseText: string,
): Array<{ ref: string; headingStart: number; headingEnd: number }> {
	const matches: Array<{
		ref: string;
		headingStart: number;
		headingEnd: number;
	}> = [];
	let offset = 0;
	let openFenceMarker: "`" | "~" | null = null;
	let openFenceLength = 0;

	for (const line of responseText.split(/(?<=\n)/)) {
		const lineWithoutNewline = line.replace(/\r?\n$/, "");
		const trimmed = lineWithoutNewline.trimStart();
		const fence = /^(?<marker>`{3,}|~{3,})/.exec(trimmed)?.groups?.marker;
		if (fence) {
			const marker = fence[0] as "`" | "~";
			if (openFenceMarker === marker && fence.length >= openFenceLength) {
				openFenceMarker = null;
				openFenceLength = 0;
			} else if (!openFenceMarker) {
				openFenceMarker = marker;
				openFenceLength = fence.length;
			}
			offset += line.length;
			continue;
		}

		if (!openFenceMarker) {
			const match = /^##\s+(t\d+)\s*$/.exec(lineWithoutNewline);
			if (match) {
				matches.push({
					ref: match[1],
					headingStart: offset,
					headingEnd: offset + line.length,
				});
			}
		}

		offset += line.length;
	}

	return matches;
}

function buildSummaryMap(
	entries: ParsedSummaryEntry[],
	inputs: SummarizerInput[],
	index: KnownInputIndex,
	maxCharsPerSummary: number,
): SummaryParseResult {
	const summaries = new Map<string, string>();
	const seen = new Set<string>();

	for (const entry of entries) {
		const input = resolveInput(entry, index);
		if (!input) continue;

		if (seen.has(input.recordId)) {
			return {
				ok: false,
				error: `duplicate summary for ${input.shortRef}`,
			};
		}

		if (entry.recordId && entry.recordId !== input.recordId) {
			return {
				ok: false,
				error: `summary identity mismatch for ${input.shortRef}`,
			};
		}
		if (entry.ref && entry.ref !== input.shortRef) {
			return {
				ok: false,
				error: `summary identity mismatch for ${input.shortRef}`,
			};
		}

		if (typeof entry.summary !== "string") {
			return {
				ok: false,
				error: `summary for ${input.shortRef} is not a string`,
			};
		}

		const summary = truncateSummary(entry.summary.trim(), maxCharsPerSummary);
		if (summary.length === 0) {
			return { ok: false, error: `summary for ${input.shortRef} is empty` };
		}

		seen.add(input.recordId);
		summaries.set(input.recordId, summary);
	}

	for (const input of inputs) {
		if (!summaries.has(input.recordId)) {
			return { ok: false, error: `missing summary for ${input.shortRef}` };
		}
	}

	return { ok: true, summaries };
}

function resolveInput(
	entry: Pick<ParsedSummaryEntry, "recordId" | "ref">,
	index: KnownInputIndex,
): SummarizerInput | undefined {
	const byRecordId = entry.recordId
		? index.byRecordId.get(entry.recordId)
		: undefined;
	const byShortRef = entry.ref ? index.byShortRef.get(entry.ref) : undefined;
	return byRecordId ?? byShortRef;
}

function truncateSummary(summary: string, maxChars: number): string {
	if (summary.length <= maxChars) return summary;
	if (maxChars <= 1) return "…";
	return `${summary.slice(0, maxChars - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
