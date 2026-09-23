import {
	isSubstantiveCriticalLine,
	parseSummarySections,
} from "../summary-schema.js";

export const FOCUS_ECHO_SECTION_HEADINGS = {
	objective: "## Current Objective",
	activeFiles: "## Active File Set",
	blockers: "## Open Problems",
	errors: "## Current Errors",
	decisions: "## Decisions Made",
	dependencyChain: "## Dependency Chain",
	nextStep: "## Next Best Step",
} as const;

/**
 * Raw focus-echo input extracted from structured Compact+ summary sections.
 *
 * This is the seam between summary parsing and future focus-echo normalization:
 * values are section text/list lines, not yet cleaned into the rendered
 * FocusEcho model.
 */
export interface FocusEchoDraft {
	objective: string;
	activeFiles: string[];
	blockers: string[];
	errors: string[];
	decisions: string[];
	dependencyChain: string[];
	nextStep: string;
}

export function extractFocusEchoDraft(summaryText: string): FocusEchoDraft {
	const { sections } = parseSummarySections(summaryText);
	return {
		objective: extractFirstNonEmptyLine(
			sections,
			FOCUS_ECHO_SECTION_HEADINGS.objective,
		),
		activeFiles: extractRawListSection(
			sections,
			FOCUS_ECHO_SECTION_HEADINGS.activeFiles,
		),
		blockers: extractRawListSection(
			sections,
			FOCUS_ECHO_SECTION_HEADINGS.blockers,
		),
		errors: extractRawListSection(sections, FOCUS_ECHO_SECTION_HEADINGS.errors),
		decisions: extractRawListSection(
			sections,
			FOCUS_ECHO_SECTION_HEADINGS.decisions,
		),
		dependencyChain: extractRawSectionLines(
			sections,
			FOCUS_ECHO_SECTION_HEADINGS.dependencyChain,
		),
		nextStep: extractFirstNonEmptyLine(
			sections,
			FOCUS_ECHO_SECTION_HEADINGS.nextStep,
		),
	};
}

function extractFirstNonEmptyLine(
	sections: Map<string, string[]>,
	heading: string,
): string {
	return (
		extractRawSectionLines(sections, heading).find(isSubstantiveCriticalLine) ??
		""
	);
}

function extractRawListSection(
	sections: Map<string, string[]>,
	heading: string,
): string[] {
	return extractRawSectionLines(sections, heading).filter(
		(line) => line.startsWith("- ") || line.startsWith("* "),
	);
}

function extractRawSectionLines(
	sections: Map<string, string[]>,
	heading: string,
): string[] {
	return (sections.get(heading) ?? [])
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}
