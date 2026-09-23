export const STRUCTURED_SUMMARY_TITLE = "Compaction Summary — Compact+ memory";
const MAX_RAW_SUMMARY_CHARS = 128_000;

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

const CRITICAL_HEADINGS: readonly StructuredSummaryHeading[] = [
	"## Current Objective",
	"## Current Task State",
	"## Next Best Step",
	"## Continuity Instruction",
];

export type SummaryValidation =
	| { valid: true }
	| { valid: false; reason: string };

/** Validate only top-level headings outside code fences; never trust quoted examples. */
export function validateStructuredSummary(summary: string): SummaryValidation {
	if (summary.length > MAX_RAW_SUMMARY_CHARS) {
		return { valid: false, reason: "raw summary too large" };
	}
	const lines = summary.replace(/\r\n?/g, "\n").split("\n");
	if (lines[0] !== STRUCTURED_SUMMARY_TITLE) {
		return { valid: false, reason: "canonical summary title missing" };
	}

	const sections = new Map<StructuredSummaryHeading, string[]>();
	const allowed = new Set<string>(STRUCTURED_SUMMARY_HEADINGS);
	let current: StructuredSummaryHeading | undefined;
	let fence: "`" | "~" | undefined;
	let fenceLength = 0;
	for (const line of lines.slice(1)) {
		const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			const kind = marker[0] as "`" | "~";
			if (!fence) {
				fence = kind;
				fenceLength = marker.length;
			} else if (fence === kind && marker.length >= fenceLength) {
				fence = undefined;
			}
		}
		if (fence || fenceMatch) {
			if (current) sections.get(current)?.push(line);
			continue;
		}
		if (/^##\s+/.test(line)) {
			const heading = line.trimEnd();
			if (!allowed.has(heading)) {
				return { valid: false, reason: `unknown heading: ${heading}` };
			}
			const key = heading as StructuredSummaryHeading;
			if (sections.has(key)) {
				return { valid: false, reason: `duplicate heading: ${key}` };
			}
			sections.set(key, []);
			current = key;
		} else if (current) {
			sections.get(current)?.push(line);
		} else if (line.trim()) {
			return { valid: false, reason: "content before first section" };
		}
	}
	if (fence) return { valid: false, reason: "unterminated code fence" };
	for (const heading of STRUCTURED_SUMMARY_HEADINGS) {
		if (!sections.has(heading)) {
			return { valid: false, reason: `missing heading: ${heading}` };
		}
	}
	for (const heading of CRITICAL_HEADINGS) {
		const body = sections.get(heading)?.join("\n").trim() ?? "";
		if (!body || /^(?:[-*]\s*)?(?:none\.?|n\/a)$/i.test(body)) {
			return { valid: false, reason: `empty critical section: ${heading}` };
		}
	}
	return { valid: true };
}
