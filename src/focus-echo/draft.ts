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
	return {
		objective: extractFirstNonEmptyLine(
			summaryText,
			FOCUS_ECHO_SECTION_HEADINGS.objective,
		),
		activeFiles: extractRawListSection(
			summaryText,
			FOCUS_ECHO_SECTION_HEADINGS.activeFiles,
		),
		blockers: extractRawListSection(
			summaryText,
			FOCUS_ECHO_SECTION_HEADINGS.blockers,
		),
		errors: extractRawListSection(
			summaryText,
			FOCUS_ECHO_SECTION_HEADINGS.errors,
		),
		decisions: extractRawListSection(
			summaryText,
			FOCUS_ECHO_SECTION_HEADINGS.decisions,
		),
		dependencyChain: extractRawSectionLines(
			summaryText,
			FOCUS_ECHO_SECTION_HEADINGS.dependencyChain,
		),
		nextStep: extractFirstNonEmptyLine(
			summaryText,
			FOCUS_ECHO_SECTION_HEADINGS.nextStep,
		),
	};
}

function extractFirstNonEmptyLine(text: string, heading: string): string {
	const content = extractSectionContent(text, heading);
	if (!content) return "";

	return (
		content
			.split(/\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
	);
}

function extractRawListSection(text: string, heading: string): string[] {
	return extractRawSectionLines(text, heading).filter(
		(line) => line.startsWith("- ") || line.startsWith("* "),
	);
}

function extractRawSectionLines(text: string, heading: string): string[] {
	const content = extractSectionContent(text, heading);
	if (!content) return [];

	return content
		.split(/\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function extractSectionContent(text: string, heading: string): string {
	const headingIndex = text.indexOf(heading);
	if (headingIndex === -1) return "";

	const afterHeading = text.slice(headingIndex + heading.length).trimStart();
	const nextHeading = afterHeading.search(/^## /m);
	return nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
}
