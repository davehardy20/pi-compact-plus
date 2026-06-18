import { MAX_ACTIVE_FILES } from "../model.js";
import {
	looksLikeFileReference,
	shortenFileReference,
	stripListPrefix,
	stripMarkdownFormatting,
} from "./shared.js";

const ACTIVE_FILE_SECTION_LABELS = new Set([
	"files read that still matter",
	"files modified",
	"likely next files to inspect/edit",
]);

const ACTIVE_FILE_GROUP_PRIORITY = [
	"files modified",
	"likely next files to inspect/edit",
	"files read that still matter",
	"default",
] as const;

const ACTIVE_FILE_CANDIDATE_PATTERN =
	/^((?:\.\/|[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)/;

export function normalizeActiveFiles(lines: string[]): string[] {
	const groupedFiles = new Map<string, string[]>();
	let currentGroup = "default";

	for (const rawLine of lines) {
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

function normalizeActiveFileItem(line: string): string | null {
	const cleaned = stripMarkdownFormatting(stripListPrefix(line))
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) {
		return null;
	}

	if (ACTIVE_FILE_SECTION_LABELS.has(cleaned.toLowerCase())) {
		return null;
	}

	const unwrapped = cleaned.replace(/^([`'"])(.*)\1$/, "$2");
	const pathMatch = unwrapped.match(
		/((?:\/|\.\/|[A-Za-z0-9_.-]+\/)(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)/,
	);
	const candidateMatch = unwrapped.match(ACTIVE_FILE_CANDIDATE_PATTERN);
	const candidate = pathMatch?.[1] ?? candidateMatch?.[1] ?? unwrapped;
	if (!looksLikeFileReference(candidate)) {
		return null;
	}

	return shortenFileReference(candidate);
}
