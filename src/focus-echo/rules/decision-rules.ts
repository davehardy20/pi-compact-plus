import { MAX_DECISIONS } from "../model.js";
import {
	normalizeInlineSummaryText,
	stripListPrefix,
	truncateLine,
} from "./shared.js";

function normalizeListSection(
	lines: string[],
	normalize: (line: string) => string | null,
	maxItems: number,
): string[] {
	const items = lines
		.map(normalize)
		.filter((item): item is string => Boolean(item));
	return Array.from(new Set(items)).slice(0, maxItems);
}

function normalizeDecisionItem(line: string): string | null {
	const trimmed = stripListPrefix(line);
	const titledDecision = trimmed.match(/^\*\*([^*]+)\*\*\s*:/);
	if (titledDecision) {
		return truncateLine(normalizeInlineSummaryText(titledDecision[1]));
	}

	const cleaned = normalizeInlineSummaryText(trimmed);
	if (!cleaned || /^no\b/i.test(cleaned)) {
		return null;
	}
	return truncateLine(cleaned);
}

export function normalizeDecisions(lines: string[]): string[] {
	return normalizeListSection(lines, normalizeDecisionItem, MAX_DECISIONS);
}
