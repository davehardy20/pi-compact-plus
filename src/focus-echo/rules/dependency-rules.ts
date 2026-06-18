import { MAX_DEPENDENCY_STEPS } from "../model.js";
import {
	normalizeInlineSummaryText,
	stripListPrefix,
	stripMarkdownFormatting,
	truncateLine,
} from "./shared.js";
import {
	applyTextReplacementRules,
	type TextReplacementRule,
} from "./types.js";

const DEPENDENCY_PRIORITY_PATTERNS = [
	/focus echo/i,
	/lastinjectedecho/i,
	/persist/i,
	/summary/i,
	/compactionentry\.summary/i,
	/session_compact/i,
	/compact-plus status/i,
	/status/i,
];

/** Dependency-chain cleanup rules shorten known path and echo-normalization wording. */
const DEPENDENCY_NORMALIZATION_RULES: readonly TextReplacementRule[] = [
	{
		name: "dependency-001-custom-compaction-summary-in-i",
		pattern: /^custom compaction summary in\s+/i,
		replacement: "",
	},
	{
		name: "dependency-002-global-pi-settings-in-i",
		pattern: /^global pi settings in\s+/i,
		replacement: "",
	},
	{
		name: "dependency-003-remaining-i",
		pattern: /^remaining\s+/i,
		replacement: "",
	},
	{
		name: "dependency-004-persisted-focus-echo",
		pattern: /\bpersisted last focus echo\b/i,
		replacement: "persisted focus echo",
	},
	// dependency-005 (buildPersistedFocusEcho/parseFocusEcho in src/reorder.ts) and
	// dependency-006 (summary-normalization helpers in src/reorder.ts) pruned in plan
	// pl-874d step 4: src/reorder.ts was deleted in slice 0, so both rules produced
	// output naming a file that no longer exists. See test goldens for rationale.
	{
		name: "dependency-007-or",
		pattern: /\sand\/or\s/gi,
		replacement: " or ",
	},
];

function scoreDependencyLine(value: string): number {
	const cleaned = stripMarkdownFormatting(value);
	let score = cleaned.includes("->") || cleaned.includes("→") ? 1 : 0;
	for (const pattern of DEPENDENCY_PRIORITY_PATTERNS) {
		if (pattern.test(cleaned)) {
			score += 2;
		}
	}
	return score;
}

function normalizeDependencyItem(line: string): string | null {
	let cleaned = normalizeInlineSummaryText(line);
	cleaned = applyTextReplacementRules(cleaned, DEPENDENCY_NORMALIZATION_RULES);
	if (!cleaned) {
		return null;
	}
	return truncateLine(cleaned);
}

export function normalizeDependencyChain(lines: string[]): string[] {
	const chains: string[] = [];
	let currentChain = "";
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		if (line.startsWith("- ") || line.startsWith("* ")) {
			if (currentChain) {
				chains.push(currentChain);
			}
			currentChain = stripListPrefix(line);
			continue;
		}
		if (/^(?:->|→)\s*/.test(line)) {
			currentChain =
				`${currentChain} -> ${line.replace(/^(?:->|→)\s*/, "")}`.trim();
			continue;
		}
		if (currentChain) {
			currentChain = `${currentChain} ${line}`.trim();
		}
	}
	if (currentChain) {
		chains.push(currentChain);
	}
	if (chains.length === 0) {
		return [];
	}

	const selectedLine = chains.reduce((best, candidate) => {
		return scoreDependencyLine(candidate) > scoreDependencyLine(best)
			? candidate
			: best;
	});
	const items = selectedLine
		.split(/\s*(?:->|→)\s*/)
		.map((line) => normalizeDependencyItem(line))
		.filter((item): item is string => Boolean(item));
	return Array.from(new Set(items)).slice(0, MAX_DEPENDENCY_STEPS);
}
