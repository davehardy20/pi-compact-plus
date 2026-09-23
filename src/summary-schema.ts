export const STRUCTURED_SUMMARY_TITLE = "Compaction Summary — Compact+ memory";
const MAX_RAW_SUMMARY_CHARS = 128_000;
export const FENCED_EXAMPLE_OMISSION =
	"[Code example omitted during normalization]";

/** The complete schema used by generation, acceptance and persisted-memory detection. */
export const STRUCTURED_SUMMARY_HEADINGS = [
	"## Current Objective",
	"## Current Task State",
	"## Active File Set",
	"## Repository State",
	"## Decisions Made",
	"## Completed Work",
	"## Open Problems",
	"## Current Errors",
	"## Known Constraints",
	"## Failed Attempts",
	"## Next Best Step",
	"## Continuity Instruction",
	"## Dependency Chain",
] as const;

export type StructuredSummaryHeading =
	(typeof STRUCTURED_SUMMARY_HEADINGS)[number];

export const CRITICAL_HEADINGS: readonly StructuredSummaryHeading[] = [
	"## Current Objective",
	"## Current Task State",
	"## Next Best Step",
	"## Continuity Instruction",
];

export type SummaryValidation =
	| { valid: true }
	| { valid: false; reason: string };

/** A closing fence permits only whitespace after a matching marker. */
export function parseSummaryFenceMarker(
	line: string,
): { kind: "`" | "~"; length: number; canClose: boolean } | undefined {
	const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match) return undefined;
	return {
		kind: match[1][0] as "`" | "~",
		length: match[1].length,
		canClose: match[2].trim().length === 0,
	};
}

/** Keep fenced examples out of both validation and focus-echo extraction. */
export function parseSummarySections(summary: string): {
	sections: Map<string, string[]>;
	headings: string[];
	contentBeforeFirstSection: boolean;
	unterminatedFence: boolean;
} {
	const lines = summary.replace(/\r\n?/g, "\n").split("\n");
	const sections = new Map<string, string[]>();
	const headings: string[] = [];
	let current: string | undefined;
	let fence: "`" | "~" | undefined;
	let fenceLength = 0;
	let contentBeforeFirstSection = false;
	for (const line of lines[0] === STRUCTURED_SUMMARY_TITLE
		? lines.slice(1)
		: lines) {
		const marker = parseSummaryFenceMarker(line);
		if (marker) {
			if (!fence) {
				fence = marker.kind;
				fenceLength = marker.length;
			} else if (
				fence === marker.kind &&
				marker.length >= fenceLength &&
				marker.canClose
			) {
				fence = undefined;
			}
		}
		if (fence || marker) continue;
		if (/^##\s+/.test(line)) {
			const heading = line.trimEnd();
			headings.push(heading);
			if (!sections.has(heading)) sections.set(heading, []);
			current = heading;
		} else if (current) {
			sections.get(current)?.push(line);
		} else if (line.trim()) {
			contentBeforeFirstSection = true;
		}
	}
	return {
		sections,
		headings,
		contentBeforeFirstSection,
		unterminatedFence: !!fence,
	};
}

/** Reject malformed structure and critical content absent outside fences. */
export function validateStructuredSummary(summary: string): SummaryValidation {
	if (summary.length > MAX_RAW_SUMMARY_CHARS) {
		return { valid: false, reason: "raw summary too large" };
	}
	if (
		summary.replace(/\r\n?/g, "\n").split("\n", 1)[0] !==
		STRUCTURED_SUMMARY_TITLE
	) {
		return { valid: false, reason: "canonical summary title missing" };
	}

	const parsed = parseSummarySections(summary);
	const allowed = new Set<string>(STRUCTURED_SUMMARY_HEADINGS);
	const seen = new Set<string>();
	for (const heading of parsed.headings) {
		if (!allowed.has(heading)) {
			return { valid: false, reason: `unknown heading: ${heading}` };
		}
		if (seen.has(heading)) {
			return { valid: false, reason: `duplicate heading: ${heading}` };
		}
		seen.add(heading);
	}
	if (parsed.contentBeforeFirstSection) {
		return { valid: false, reason: "content before first section" };
	}
	if (parsed.unterminatedFence) {
		return { valid: false, reason: "unterminated code fence" };
	}
	for (const heading of STRUCTURED_SUMMARY_HEADINGS) {
		if (!parsed.sections.has(heading)) {
			return { valid: false, reason: `missing heading: ${heading}` };
		}
	}
	for (const heading of CRITICAL_HEADINGS) {
		const substantive = parsed.sections.get(heading)?.some((line) => {
			// A bare Markdown list marker is not substantive memory.
			const text = line
				.trim()
				.replace(/^(?:[-*+]|\d+[.)])(?:\s+|$)/, "")
				.trim();
			const plain = text
				.replace(/^[*_~`]+/, "")
				.replace(/[*_~`]+$/, "")
				.trim();
			return (
				plain.length > 0 &&
				!/^(?:none\.?|n\/a)$/i.test(plain) &&
				plain !== FENCED_EXAMPLE_OMISSION
			);
		});
		if (!substantive) {
			return { valid: false, reason: `empty critical section: ${heading}` };
		}
	}
	return { valid: true };
}
