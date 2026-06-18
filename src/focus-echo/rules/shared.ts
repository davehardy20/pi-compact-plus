import { MAX_ECHO_LINE_LENGTH } from "../model.js";

const ISSUE_BOILERPLATE_PATTERNS = [
	/^(?:fix|work on|resolve)\s+seeds issue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?\s+by\s+/i,
	/^implement\s+(?:seeds issue\s+)?[A-Za-z0-9-]+(?:\s+in\s+\S+)?\s+by\s+/i,
	/^continue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?\s+by\s+/i,
	/^continue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?\s+using\s+.+?(?::|;\s+)/i,
];

const LEADING_GERUND_REPLACEMENTS = new Map<string, string>([
	["cleaning", "Clean"],
	["refining", "Refine"],
	["tightening", "Tighten"],
	["verifying", "Verify"],
	["inspecting", "Inspect"],
	["adding", "Add"],
	["removing", "Remove"],
	["deduping", "Dedupe"],
	["deduplicating", "Deduplicate"],
]);

const PATH_DISPLAY_ANCHORS = [
	"src",
	"test",
	"docs",
	"dist",
	"agent",
	"skills",
	"examples",
	".pi",
	".mulch",
];

const ROOT_FILE_NAMES = new Set([
	"package.json",
	"package-lock.json",
	"README.md",
	"LICENSE",
	"tsconfig.json",
	"tsconfig.build.json",
	"vitest.config.ts",
	"DEV-RELEASE-PLAYBOOK.md",
]);

export function hasIssueBoilerplate(value: string): boolean {
	return ISSUE_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(value));
}

export function stripIssueBoilerplate(value: string): string {
	return ISSUE_BOILERPLATE_PATTERNS.reduce(
		(result, pattern) => result.replace(pattern, ""),
		value,
	);
}

export function normalizeInlineSummaryText(value: string): string {
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

export function rewriteLeadingGerund(value: string): string {
	const trimmed = value.trim();
	for (const [gerund, replacement] of LEADING_GERUND_REPLACEMENTS) {
		const pattern = new RegExp(`^${gerund}\\b`, "i");
		if (pattern.test(trimmed)) {
			return capitalizeSentence(trimmed.replace(pattern, replacement));
		}
	}
	return capitalizeSentence(trimmed);
}

export function splitSummaryClauses(value: string): string[] {
	return value
		.split(/\s*;\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

export function stripListPrefix(value: string): string {
	return value
		.trim()
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+\.\s+/, "");
}

export function stripMarkdownFormatting(value: string): string {
	return value
		.replace(/^`([^`]+)`$/, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1");
}

export function looksLikeFileReference(value: string): boolean {
	const normalized = value.replace(/\\/g, "/");
	return (
		normalized.includes("/") ||
		/^[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/.test(normalized)
	);
}

export function shortenFileReference(value: string): string {
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

export function capitalizeSentence(value: string): string {
	if (!value) {
		return "";
	}
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export function truncateLine(
	value: string,
	maxLength = MAX_ECHO_LINE_LENGTH,
): string {
	if (value.length <= maxLength) {
		return value;
	}
	return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
