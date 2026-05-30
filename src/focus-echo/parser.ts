import type { FocusEcho } from "./model.js";
import {
	MAX_ACTIVE_FILES,
	MAX_BLOCKERS,
	MAX_DECISIONS,
	MAX_DEPENDENCY_STEPS,
	MAX_ECHO_LINE_LENGTH,
} from "./model.js";
import {
	ACTIVE_FILE_CANDIDATE_PATTERN,
	ACTIVE_FILE_GROUP_PRIORITY,
	ACTIVE_FILE_SECTION_LABELS,
	applyTextReplacementRules,
	BLOCKER_NORMALIZATION_RULES,
	DEPENDENCY_NORMALIZATION_RULES,
	DEPENDENCY_PRIORITY_PATTERNS,
	ISSUE_BOILERPLATE_PATTERNS,
	LEADING_GERUND_REPLACEMENTS,
	NEXT_STEP_NORMALIZATION_RULES,
	OBJECTIVE_NORMALIZATION_RULES,
	OBJECTIVE_PRE_COLON_RULES,
	OBJECTIVE_SOURCE_OF_TRUTH_RULES,
	PATH_DISPLAY_ANCHORS,
	ROOT_FILE_NAMES,
} from "./normalization-rules.js";

/**
 * Extract high-signal fields from a structured compaction summary.
 * Parses the known headings produced by buildSummaryInstructions().
 */
export function parseFocusEcho(summaryText: string): FocusEcho {
	const sectionHeadings = {
		objective: "## Current Objective",
		activeFiles: "## Active File Set",
		blockers: "## Open Problems",
		errors: "## Current Errors",
		decisions: "## Decisions Made",
		dependencyChain: "## Dependency Chain",
		nextStep: "## Next Best Step",
	};

	return {
		objective: extractSection(
			summaryText,
			sectionHeadings.objective,
			normalizeObjectiveText,
		),
		blockers: extractBlockers(
			summaryText,
			sectionHeadings.blockers,
			sectionHeadings.errors,
		),
		activeFiles: extractActiveFiles(summaryText, sectionHeadings.activeFiles),
		decisions: extractNormalizedListSection(
			summaryText,
			sectionHeadings.decisions,
			normalizeDecisionItem,
			MAX_DECISIONS,
		),
		dependencyChain: extractDependencyChain(
			summaryText,
			sectionHeadings.dependencyChain,
		),
		nextStep: extractSection(
			summaryText,
			sectionHeadings.nextStep,
			normalizeNextStepText,
		),
	};
}

// ── Internal helpers ────────────────────────────────────────────────

function extractSection(
	text: string,
	heading: string,
	normalize: (value: string) => string = normalizeGenericSectionText,
): string {
	const content = extractSectionContent(text, heading);
	if (!content) return "";

	const firstLine = content
		.split(/\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return firstLine ? normalize(firstLine) : "";
}

function extractSectionContent(text: string, heading: string): string {
	const headingIndex = text.indexOf(heading);
	if (headingIndex === -1) return "";

	const afterHeading = text.slice(headingIndex + heading.length).trimStart();
	const nextHeading = afterHeading.search(/^## /m);
	return nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
}

function extractRawListSection(text: string, heading: string): string[] {
	const content = extractSectionContent(text, heading);
	if (!content) return [];

	return content
		.split(/\n/)
		.map((l) => l.trim())
		.filter((l) => l.startsWith("- ") || l.startsWith("* "));
}

function extractNormalizedListSection(
	text: string,
	heading: string,
	normalize: (line: string) => string | null,
	maxItems: number,
): string[] {
	const items = extractRawListSection(text, heading)
		.map(normalize)
		.filter((item): item is string => Boolean(item));
	return Array.from(new Set(items)).slice(0, maxItems);
}

function extractActiveFiles(text: string, heading: string): string[] {
	const content = extractSectionContent(text, heading);
	if (!content) {
		return [];
	}

	const groupedFiles = new Map<string, string[]>();
	let currentGroup = "default";

	for (const rawLine of content.split(/\n/)) {
		const match = rawLine.match(/^\s*[-*]\s+(.+)$/);
		if (!match) {
			continue;
		}

		const bulletText = match[1].trim();
		const lowerText = bulletText.toLowerCase();
		if (ACTIVE_FILE_SECTION_LABELS.has(lowerText)) {
			currentGroup = lowerText;
			if (!groupedFiles.has(currentGroup)) {
				groupedFiles.set(currentGroup, []);
			}
			continue;
		}

		const normalized = normalizeActiveFileItem(bulletText);
		if (!normalized) {
			continue;
		}

		const groupItems = groupedFiles.get(currentGroup) ?? [];
		groupItems.push(normalized);
		groupedFiles.set(currentGroup, groupItems);
	}

	const orderedItems = ACTIVE_FILE_GROUP_PRIORITY.flatMap(
		(group) => groupedFiles.get(group) ?? [],
	);
	const uniqueItems = Array.from(new Set(orderedItems));
	const pathItems = uniqueItems.filter((item) => item.includes("/"));
	const displayItems = pathItems.length > 0 ? pathItems : uniqueItems;
	return displayItems.slice(0, MAX_ACTIVE_FILES);
}

function extractBlockers(
	text: string,
	blockersHeading: string,
	errorsHeading: string,
): string[] {
	const items = [
		...extractRawListSection(text, blockersHeading),
		...extractRawListSection(text, errorsHeading),
	]
		.flatMap((line) => splitSummaryClauses(stripListPrefix(line)))
		.map((line) => normalizeBlockerItem(line))
		.filter((item): item is string => Boolean(item));

	const uniqueItems = Array.from(new Set(items)).filter((item) => {
		return !(
			item === "Blockers retains stale/literal text" &&
			items.includes("Blockers retains stale validation/dedupe noise")
		);
	});
	return uniqueItems.slice(0, MAX_BLOCKERS);
}

function extractDependencyChain(text: string, heading: string): string[] {
	const content = extractSectionContent(text, heading);
	if (!content) {
		return [];
	}

	const chains: string[] = [];
	let currentChain = "";
	for (const rawLine of content.split(/\n/)) {
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

function normalizeBlockerItem(line: string): string | null {
	if (/^`[^`]+`$/.test(line.trim())) {
		return null;
	}

	const embeddedEchoBlocker = summarizeEmbeddedEchoFieldAsBlocker(line);
	if (embeddedEchoBlocker) {
		return truncateLine(embeddedEchoBlocker);
	}

	let cleaned = normalizeInlineSummaryText(line);
	cleaned = applyTextReplacementRules(cleaned, BLOCKER_NORMALIZATION_RULES);
	if (!cleaned || /^no\b/i.test(cleaned)) {
		return null;
	}
	if (/partially cleaned up/i.test(cleaned)) {
		return null;
	}
	if (/were resolved/i.test(cleaned)) {
		return null;
	}
	if (/^[A-Za-z0-9-]+ remains to be implemented$/i.test(cleaned)) {
		return null;
	}
	return truncateLine(capitalizeSentence(cleaned));
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

function normalizeDependencyItem(line: string): string | null {
	let cleaned = normalizeInlineSummaryText(line);
	cleaned = applyTextReplacementRules(cleaned, DEPENDENCY_NORMALIZATION_RULES);
	if (!cleaned) {
		return null;
	}
	return truncateLine(cleaned);
}

function normalizeActiveFileItem(line: string): string | null {
	const cleaned = normalizeInlineSummaryText(line);
	if (!cleaned) {
		return null;
	}

	if (ACTIVE_FILE_SECTION_LABELS.has(cleaned.toLowerCase())) {
		return null;
	}

	const unwrapped = cleaned.replace(/^([`'"])(.*)\1$/, "$2");
	const candidateMatch = unwrapped.match(ACTIVE_FILE_CANDIDATE_PATTERN);
	const candidate = candidateMatch?.[1] ?? unwrapped;
	if (!looksLikeFileReference(candidate)) {
		return null;
	}

	return shortenFileReference(candidate);
}

function normalizeGenericSectionText(value: string): string {
	return truncateLine(normalizeInlineSummaryText(value));
}

function summarizeEmbeddedEchoFieldAsBlocker(line: string): string | null {
	const cleaned = normalizeInlineSummaryText(line);
	const objective = cleaned.match(/^objective:\s+(.+)$/i);
	if (objective) {
		const objectiveText = objective[1];
		const hasBoilerplate = ISSUE_BOILERPLATE_PATTERNS.some((pattern) =>
			pattern.test(objectiveText),
		);
		const hasPath = /\b(?:src|test|docs|agent)\//i.test(objectiveText);
		const hasIssueId = /\b[A-Za-z0-9-]+-[A-Za-z0-9-]+\b/.test(objectiveText);
		if (hasBoilerplate || hasPath || hasIssueId) {
			return "Objective still includes issue boilerplate/path noise";
		}
		return "Objective still needs cleanup";
	}
	if (/^blockers:\s+/i.test(cleaned)) {
		return "Blockers retains stale validation/dedupe noise";
	}
	if (/^dependency chain:\s+/i.test(cleaned)) {
		return "Dependency chain still includes stale summary wording";
	}
	if (/^next step:\s+/i.test(cleaned)) {
		return "Next step still includes stale validation wording";
	}
	return null;
}

function normalizeObjectiveText(value: string): string {
	let cleaned = stripIssueBoilerplate(normalizeInlineSummaryText(value)).trim();
	cleaned = applyTextReplacementRules(cleaned, OBJECTIVE_PRE_COLON_RULES);
	const colonSplit = cleaned.match(/^(.*?):\s+(.*)$/);
	if (
		colonSplit &&
		/(follow-up|requested|status check|carry out)/i.test(colonSplit[1])
	) {
		cleaned = colonSplit[2];
	}
	cleaned = applyTextReplacementRules(cleaned, OBJECTIVE_SOURCE_OF_TRUTH_RULES);
	cleaned = stripIssueBoilerplate(cleaned).trim();
	cleaned = applyTextReplacementRules(cleaned, OBJECTIVE_NORMALIZATION_RULES);
	return truncateLine(rewriteLeadingGerund(cleaned));
}

function normalizeNextStepText(value: string): string {
	let cleaned = stripIssueBoilerplate(normalizeInlineSummaryText(value));
	cleaned = applyTextReplacementRules(cleaned, NEXT_STEP_NORMALIZATION_RULES);
	return truncateLine(rewriteLeadingGerund(cleaned));
}

function normalizeInlineSummaryText(value: string): string {
	return normalizePathReferences(
		stripMarkdownFormatting(stripListPrefix(value)),
	)
		.replace(/\[compaction\]/gi, "")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.replace(/[;:]$/, "")
		.trim();
}

function normalizePathReferences(value: string): string {
	return value
		.replace(
			/\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+/g,
			(match) => shortenFileReference(match),
		)
		.replace(/\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g, (match) =>
			shortenDirectoryReference(match),
		)
		.replace(
			/(^|[\s(])((?:\.\/|[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)/g,
			(_match, prefix: string, candidate: string) =>
				`${prefix}${shortenFileReference(candidate)}`,
		);
}

function stripIssueBoilerplate(value: string): string {
	return ISSUE_BOILERPLATE_PATTERNS.reduce(
		(result, pattern) => result.replace(pattern, ""),
		value,
	);
}

function rewriteLeadingGerund(value: string): string {
	const trimmed = value.trim();
	for (const [gerund, replacement] of LEADING_GERUND_REPLACEMENTS) {
		const pattern = new RegExp(`^${gerund}\\b`, "i");
		if (pattern.test(trimmed)) {
			return capitalizeSentence(trimmed.replace(pattern, replacement));
		}
	}
	return capitalizeSentence(trimmed);
}

function splitSummaryClauses(value: string): string[] {
	return value
		.split(/\s*;\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

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

function stripListPrefix(value: string): string {
	return value
		.trim()
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+\.\s+/, "");
}

function stripMarkdownFormatting(value: string): string {
	return value
		.replace(/^`([^`]+)`$/, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1");
}

function looksLikeFileReference(value: string): boolean {
	const normalized = value.replace(/\\/g, "/");
	return (
		normalized.includes("/") ||
		/^[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/.test(normalized)
	);
}

function shortenFileReference(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	if (!normalized.includes("/")) {
		return normalized;
	}

	const segments = normalized.split("/").filter(Boolean);
	const basename = segments[segments.length - 1];
	if (ROOT_FILE_NAMES.has(basename)) {
		return basename;
	}

	const anchorIndex = segments.findIndex((segment) =>
		PATH_DISPLAY_ANCHORS.includes(segment),
	);
	if (anchorIndex !== -1) {
		return segments.slice(anchorIndex).join("/");
	}
	if (segments.length >= 2 && /\./.test(segments[segments.length - 1])) {
		return segments.slice(-2).join("/");
	}
	return basename ?? normalized;
}

function shortenDirectoryReference(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	if (!normalized.includes("/")) {
		return normalized;
	}

	const segments = normalized.split("/").filter(Boolean);
	const anchorIndex = segments.findIndex((segment) =>
		PATH_DISPLAY_ANCHORS.includes(segment),
	);
	if (anchorIndex !== -1) {
		return segments.slice(anchorIndex).join("/");
	}
	return segments[segments.length - 1] ?? normalized;
}

function capitalizeSentence(value: string): string {
	if (!value) {
		return "";
	}
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncateLine(value: string, maxLength = MAX_ECHO_LINE_LENGTH): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
