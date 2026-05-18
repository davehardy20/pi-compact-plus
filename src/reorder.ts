import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Position-aware context reordering to mitigate "lost in the middle" degradation.
 *
 * Strategy: inject a compact "focus echo" at the recency position (before the
 * last user message) so that the model sees critical information at both
 * primacy (start, from the summary) and recency (end, from the echo) positions.
 *
 * The echo is intentionally small (under ~200 tokens) to avoid eating into
 * the working context. It only duplicates the highest-signal fields:
 * objective, blockers, active files, decisions, dependency chain, next step.
 */

export interface FocusEcho {
	objective: string;
	blockers: string[];
	activeFiles: string[];
	decisions: string[];
	dependencyChain: string[];
	nextStep: string;
}

const FOCUS_ECHO_MARKER = "<focus-echo>";
const MAX_ACTIVE_FILES = 4;
const MAX_BLOCKERS = 3;
const MAX_DECISIONS = 3;
const MAX_DEPENDENCY_STEPS = 4;
const MAX_ECHO_LINE_LENGTH = 120;
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
const ACTIVE_FILE_SECTION_LABELS = new Set([
	"files read that still matter",
	"files modified",
	"likely next files to inspect/edit",
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

/**
 * Headings that only appear together in a real Compact+ compaction summary.
 * Used to avoid false positives from chat messages that mention one heading.
 */
const SUMMARY_SIGNATURE_HEADINGS = [
	"## Current Objective",
	"## Active File Set",
	"## Decisions Made",
	"## Next Best Step",
];

const MIN_SIGNATURE_MATCHES = 2;

/** Pre-compiled regexes for summary signature detection. */
const SUMMARY_REGEXES = SUMMARY_SIGNATURE_HEADINGS.map(
	(h) => new RegExp(`^${escapeRegex(h)}`, "m"),
);

/**
 * Detect whether the messages array contains a Compact+ compaction summary.
 * Looks for assistant messages containing the "## Current Objective" heading
 * that Compact+ injects via buildSummaryInstructions().
 */
export function detectCompactionSummary(messages: AgentMessage[]):
	| { found: true; summaryText: string; summaryIndex: number }
	| {
			found: false;
			summaryText?: undefined;
			summaryIndex?: undefined;
	  } {
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const text = extractSimpleText(msg);
			const matchCount = SUMMARY_REGEXES.filter((re) => re.test(text)).length;
			if (matchCount >= MIN_SIGNATURE_MATCHES) {
				return { found: true, summaryText: text, summaryIndex: i };
			}
		}
	}
	return { found: false };
}

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

/**
 * Build a compact echo block to inject at the recency position.
 * Format:
 *   <focus-echo>
 *   Objective: ...
 *   Active files: ...
 *   Blockers: ...
 *   Next step: ...
 *   </focus-echo>
 */
export function buildFocusEchoBlock(echo: FocusEcho): string {
	const lines: string[] = [FOCUS_ECHO_MARKER];

	if (echo.objective) {
		lines.push(`Objective: ${echo.objective}`);
	}
	if (echo.activeFiles.length > 0) {
		lines.push(`Active files: ${echo.activeFiles.join(", ")}`);
	}
	if (echo.blockers.length > 0) {
		lines.push(`Blockers: ${echo.blockers.join("; ")}`);
	}
	if (echo.decisions.length > 0) {
		lines.push(`Decisions: ${echo.decisions.join("; ")}`);
	}
	if (echo.dependencyChain && echo.dependencyChain.length > 0) {
		lines.push(`Dependency chain: ${echo.dependencyChain.join(" → ")}`);
	}
	if (echo.nextStep) {
		lines.push(`Next step: ${echo.nextStep}`);
	}

	lines.push("</focus-echo>");
	return lines.join("\n");
}

/**
 * Create a synthetic user message containing the focus echo.
 * Uses role "user" with a clear marker so it's distinguishable.
 */
export function createEchoMessage(echo: FocusEcho): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text: buildFocusEchoBlock(echo) }],
	} as AgentMessage;
}

export function buildPersistedFocusEcho(summaryText: string): string | null {
	const echo = parseFocusEcho(summaryText);
	if (
		!echo.objective &&
		echo.blockers.length === 0 &&
		echo.activeFiles.length === 0 &&
		echo.decisions.length === 0 &&
		echo.dependencyChain.length === 0 &&
		!echo.nextStep
	) {
		return null;
	}
	return buildFocusEchoBlock(echo);
}

/**
 * Main reordering function. If a compaction summary is detected:
 * 1. Parse the focus echo
 * 2. Inject it before the last user message (recency position)
 * 3. Return the reordered messages
 *
 * If no summary is detected, returns undefined (no-op).
 * If an existing <focus-echo> is found, returns undefined (dedup).
 * Pass `echoInjected=true` to skip the O(n) dedup scan (caller manages flag).
 */
export function reorderForPositioning(
	messages: AgentMessage[],
	echoInjected = false,
): { messages: AgentMessage[]; echoText: string } | undefined {
	const detection = detectCompactionSummary(messages);
	if (!detection.found) {
		return undefined;
	}

	// Dedup: skip if an existing focus-echo is already present
	if (!echoInjected) {
		const alreadyHasEcho = messages.some((msg) => {
			if (msg.role === "user") {
				const text = extractSimpleText(msg);
				return text.includes(FOCUS_ECHO_MARKER);
			}
			return false;
		});
		if (alreadyHasEcho) return undefined;
	}

	const echoText = buildPersistedFocusEcho(detection.summaryText);
	if (!echoText) {
		return undefined;
	}

	const echoMessage = {
		role: "user",
		content: [{ type: "text", text: echoText }],
	} as AgentMessage;

	// Inject before the last user message for recency positioning
	const lastUserIndex = findLastUserMessageIndex(messages);
	if (lastUserIndex === -1) return undefined;

	const result = [...messages];
	result.splice(lastUserIndex, 0, echoMessage);
	return { messages: result, echoText };
}

// ── Internal helpers ────────────────────────────────────────────────

function extractSimpleText(msg: AgentMessage): string {
	if (msg.role === "assistant") {
		return msg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	if (msg.role === "user") {
		if (typeof msg.content === "string") return msg.content;
		if (Array.isArray(msg.content)) {
			return msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}
	}
	return "";
}

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

	const prioritizedGroups = [
		"files modified",
		"likely next files to inspect/edit",
		"files read that still matter",
		"default",
	];
	const orderedItems = prioritizedGroups.flatMap(
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
	cleaned = cleaned.replace(/^examples seen live include\s+/i, "");
	cleaned = cleaned.replace(
		/^current live output proves persistence works, but\s+/i,
		"",
	);
	cleaned = cleaned.replace(/^need a follow-up implementation pass.*$/i, "");
	cleaned = cleaned.replace(
		/^(?:the\s+)?latest (?:direct )?live last focus echo (?:(?:is|was)(?: still)? )?too noisy.*$/i,
		"",
	);
	cleaned = cleaned.replace(/^need to validate that the new\s+/i, "validate ");
	cleaned = cleaned.replace(
		/^(?:fresh|newly pasted|newest pasted) live\s+\/compact-plus status output\s+shows?\s+noisy persisted echo content(?:\s+despite\s+[^.]+)?(?:\s+.*)?$/i,
		"Live /compact-plus status shows noisy persisted echo content",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?latest pasted live\s+.*compact\+ status shows a noisy\/stale persisted last focus echo.*$/i,
		"Live /compact-plus status shows noisy persisted echo content",
	);
	cleaned = cleaned.replace(
		/^(?:fresh\s+)?live\s+(?:last\s+)?focus echo output leaks the newest\s*\/\s*post-compaction summary shape wording in objective, blockers, and(?:\s+next step|…).*$/i,
		"Objective, Blockers, and Next step still leak post-compaction wording",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?latest pasted live\s+(?:last\s+)?focus echo is noisy.*$/i,
		"Live /compact-plus status shows noisy persisted echo content",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?newly pasted live\s+(?:last\s+)?focus echo is noisy.*$/i,
		"Live /compact-plus status shows noisy persisted echo content",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?live\s+(?:last\s+)?focus echo needs cleanup around\s+objective, blockers, dependency chain, and next step.*$/i,
		"Live /compact-plus status shows noisy persisted echo content",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?newest pasted live\s+(?:last\s+)?focus echo shows noise in\s+objective, blockers, dependency chain, and next step.*$/i,
		"Live /compact-plus status shows noisy persisted echo content",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?newest pasted live\s+(?:last\s+)?focus echo has a new unnormalized objective prefix:.*$/i,
		"Objective includes live source-of-truth prefix",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?new(?:ly|est) pasted live\s+(?:last\s+)?focus echo shows an unnormalized objective prefix beginning\s+use the latest pasted live foc(?:us)? echo.*$/i,
		"Objective includes live source-of-truth prefix",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?new(?:ly|est) pasted live\s+(?:last\s+)?focus echo shows another unnormalized objective prefix beginning.*$/i,
		"Objective includes live source-of-truth prefix",
	);
	cleaned = cleaned.replace(
		/^latest live objective starts with\s+tighten persisted focus-?echo normalization(?:\s+in\s+\S+)?\s+for the new(?:ly|est) pasted(?:\s+live\s+focus\s+echo(?:\s*\/\s*post-compaction summary)?\s+shape|\s+l…).*$/i,
		"Objective includes pasted-live wording",
	);
	cleaned = cleaned.replace(
		/^latest live objective starts with\s+finali[sz]e the persisted focus-?echo normalization fixes(?:\s+in\s+\S+)?\s+for the new(?:ly|est) pasted(?:\s+live\s+focus\s+echo(?:\s*\/\s*post-compaction summary)?\s+shape|\s+l…).*$/i,
		"Objective includes pasted-live wording",
	);
	cleaned = cleaned.replace(
		/^live objective begins:\s+use the self-improvement workflow to finali[sz]e the persisted focus-?echo normalization fixes.*$/i,
		"Objective includes self-improvement-workflow wording",
	);
	cleaned = cleaned.replace(
		/^blockers include noisy\/stale live wording.*$/i,
		"Blockers retains noisy/stale live wording",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?latest live output reports noisy\/stale blockers wording and umbrella cleanup text around objective, blockers, dependency chain, and next step.*$/i,
		"Objective, Blockers, Dependency chain, and Next step need cleanup",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?newest pasted live blockers contain noisy\/stale umbrella cleanup text around objective, blockers, dependency chain,.*$/i,
		"Objective, Blockers, Dependency chain, and Next step need cleanup",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?newest live blockers contain stale\/noisy wording, including.*$/i,
		"Blockers retains noisy/stale live wording",
	);
	cleaned = cleaned.replace(
		/^latest live blockers include variants(?: like| from the newest live summary wording family).*$/i,
		"Blockers retains noisy/stale live wording",
	);
	cleaned = cleaned.replace(
		/^live blockers include stale\/noisy items such as.*$/i,
		"Blockers retains noisy/stale live wording",
	);
	cleaned = cleaned.replace(
		/^final live verification is missing because the latest pasted .*compact\+ status shows.*$/i,
		"Final live custom-path verification is still pending",
	);
	cleaned = cleaned.replace(
		/^because the custom compact\+ summary path did not run, the new normalization logic has not yet been proven against fresh.*$/i,
		"Final live custom-path verification is still pending",
	);
	cleaned = cleaned.replace(
		/^mulch expertise is empty \(no expertise recorded yet\.\) and should remain unrecorded until live custom-path success.*$/i,
		"Wait to record Mulch until live custom-path success",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?active normalization hotspot remains the regex cleanup flow in src\/reorder\.ts, especially the section beginning.*$/i,
		"Regex cleanup flow in src/reorder.ts remains the hotspot",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?newest live next step is too verbose.*$/i,
		"Next step needs shortening",
	);
	cleaned = cleaned.replace(
		/^cleanup needed around objective, blockers, dependency chain, and next step.*$/i,
		"Objective, Blockers, Dependency chain, and Next step need cleanup",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?newest changes have not been validated in this snippet with a post-edit vitest run.*$/i,
		"Latest changes are not yet validated",
	);
	cleaned = cleaned.replace(
		/^(?:need to confirm whether|(?:it\s+)needs confirmation whether) stale active files entries are(?: actually)? leaking into the persisted echo\/status flow.*$/i,
		"Confirm stale Active files leakage",
	);
	cleaned = cleaned.replace(
		/^dependency-chain cleanup for the newest live echo may need pruning\/shortening beyond.*$/i,
		"Dependency chain still needs pruning",
	);
	cleaned = cleaned.replace(
		/^(?:the\s+)?latest regex edits for that shape are not yet validated.*$/i,
		"Latest regex edits are not yet validated",
	);
	cleaned = cleaned.replace(
		/^need regression coverage in test\/index\.test\.ts for the newest pasted live echo\s*\/\s*post-compaction summary shape.*$/i,
		"Add regression coverage for the newest live echo shape",
	);
	cleaned = cleaned.replace(
		/^test\/index\.test\.ts needs a regression for this newest pasted live objective-prefix shape.*$/i,
		"Add regression coverage for the newest live-source-of-truth echo shape",
	);
	cleaned = cleaned.replace(
		/^test\/index\.test\.ts needs regression coverage for this newest pasted live objective-prefix\s*\/\s*post-compaction summary shape.*$/i,
		"Add regression coverage for the newest live-source-of-truth echo shape",
	);
	cleaned = cleaned.replace(
		/^test expectations are now out of sync with the new path-preference behavior that removes package\.json when path items exist.*$/i,
		"Update test expectations for path-preference active files",
	);
	cleaned = cleaned.replace(
		/^dependency chain and next step remain overly verbose\/truncated.*$/i,
		"Dependency chain and Next step need shortening",
	);
	cleaned = cleaned.replace(
		/^objective is verbose\/truncated:\s+.*$/i,
		"Objective needs shortening",
	);
	cleaned = cleaned.replace(
		/^blockers? leaks? stale\/literal text:\s+.*$/i,
		"Blockers retains stale/literal text",
	);
	cleaned = cleaned.replace(
		/^blockers?.*stale validation\/dedupe noise.*$/i,
		"Blockers retains stale validation/dedupe noise",
	);
	cleaned = cleaned.replace(
		/^next step (?:still )?(?:renders?|includes?) literal command text:\s+.*$/i,
		"Next step still includes literal command text",
	);
	cleaned = cleaned.replace(
		/\s+actually improves live\s+\/compact-plus status output\.?$/i,
		" against live /compact-plus status output",
	);
	cleaned = cleaned.replace(
		/^focus files status output\s+needs deduping.*$/i,
		"Focus files line needs deduping",
	);
	cleaned = cleaned.replace(
		/^focus files status output\s+still needs deduping.*$/i,
		"Focus files line needs deduping",
	);
	cleaned = cleaned.replace(
		/\blive\s+\/compact-plus status\s+is\s+/i,
		"/compact-plus status is ",
	);
	cleaned = cleaned.replace(/\bstill\s+/i, "");
	cleaned = cleaned.replace(/^src\/\S+\s+has now been updated to\s+.*$/i, "");
	cleaned = cleaned.replace(/[.;]+$/g, "");
	cleaned = cleaned.replace(/\s+with$/i, "");
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
	cleaned = cleaned.replace(/^custom compaction summary in\s+/i, "");
	cleaned = cleaned.replace(/^global pi settings in\s+/i, "");
	cleaned = cleaned.replace(/^remaining\s+/i, "");
	cleaned = cleaned.replace(
		/\bpersisted last focus echo\b/i,
		"persisted focus echo",
	);
	cleaned = cleaned.replace(
		/^buildPersistedFocusEcho\(summaryText\)\s*\/\s*parseFocusEcho\(\)\s+in\s+src\/reorder\.ts(?:\s+normalize summary fields)?$/i,
		"buildPersistedFocusEcho()/parseFocusEcho() in src/reorder.ts",
	);
	cleaned = cleaned.replace(
		/^summary-normalization helpers including\s+.*$/i,
		"summary-normalization helpers in src/reorder.ts",
	);
	cleaned = cleaned.replace(/\sand\/or\s/gi, " or ");
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
	const candidateMatch = unwrapped.match(
		/^((?:\.\/|[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)/,
	);
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
	cleaned = cleaned.replace(/\bthe working v(\d+\.\d+\.\d+)\b/i, "v$1");
	cleaned = cleaned.replace(
		/\bpersisted last focus echo\b/i,
		"persisted focus echo",
	);
	cleaned = cleaned.replace(/\blast focus echo\b/i, "focus echo");
	const colonSplit = cleaned.match(/^(.*?):\s+(.*)$/);
	if (
		colonSplit &&
		/(follow-up|requested|status check|carry out)/i.test(colonSplit[1])
	) {
		cleaned = colonSplit[2];
	}
	cleaned = cleaned.replace(/^further\s+/i, "");
	cleaned = cleaned.replace(
		/^us(?:e|ing) the newly pasted(?: post-compaction)?\s+\/compact-plus status (?:snapshot|output)(?:\s+and\s+latest pasted focus echo)?\s+as the source of truth(?:\s+to\s+)?(?:further\s+)?/i,
		"",
	);
	cleaned = cleaned.replace(
		/^us(?:e|ing) the latest live\s+\/compact-plus status (?:snapshot|output)\s+as the source of truth(?:\s+to\s+)?(?:further\s+)?/i,
		"",
	);
	cleaned = cleaned.replace(
		/^us(?:e|ing) the latest live\s+\/compact-plus status\s*\/\s*focus echo shape\s+as the source of truth(?:\s+in\s+\S+)?(?:\s+to\s+)?(?:further\s+)?/i,
		"",
	);
	cleaned = cleaned.replace(
		/^us(?:e|ing) the latest pasted live focus echo\s*\/\s*\/compact-plus status output\s+as the source of truth(?:\s+in\s+\S+)?(?:\s+to\s+)?(?:further\s+)?/i,
		"",
	);
	cleaned = cleaned.replace(
		/^us(?:e|ing) the newly pasted(?: live)?\s+focus echo as the current live source of truth(?:\s+to\s+)?(?:further\s+)?/i,
		"",
	);
	cleaned = stripIssueBoilerplate(cleaned).trim();
	cleaned = cleaned.replace(
		/^continue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?(?:,\s*|\s+by\s+|\s+)/i,
		"",
	);
	cleaned = cleaned.replace(/^in\s+[A-Za-z0-9_.-]+\s+to\s+/i, "");
	cleaned = cleaned.replace(
		/^continue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?(?:,\s*|\s+by\s+|\s+)/i,
		"",
	);
	cleaned = cleaned.replace(
		/,\s+especially objective, blockers, dependency chain, and(?: the literal)? next step\.?$/i,
		"",
	);
	cleaned = cleaned.replace(/^to\s+/i, "");
	cleaned = cleaned.replace(
		/^\s*focus files dedupe is fixed, but\s+the persisted focus echo needs cleanup for\s+/i,
		"clean up persisted focus echo: ",
	);
	cleaned = cleaned.replace(/^\s*focus files dedupe is fixed, but\s+/i, "");
	cleaned = cleaned.replace(
		/\bstill needs cleanup for\b/i,
		"needs cleanup for",
	);
	cleaned = cleaned.replace(
		/^\s*the persisted focus echo needs cleanup for\s+/i,
		"clean up persisted focus echo: ",
	);
	cleaned = cleaned.replace(
		/^\s*persisted focus echo needs cleanup for\s+/i,
		"clean up persisted focus echo: ",
	);
	cleaned = cleaned.replace(/;\s+src\/\S+.*$/i, "");
	cleaned = cleaned.replace(
		/\bpersisted focus-echo output\b/i,
		"persisted focus echo",
	);
	cleaned = cleaned.replace(/\bby shortening\b/i, ": shorten");
	cleaned = cleaned.replace(/\bcompressing\b/gi, "compress");
	cleaned = cleaned.replace(/\bpruning\b/gi, "prune");
	cleaned = cleaned.replace(/\bdeduping\b/gi, "dedupe");
	cleaned = cleaned.replace(/\bpossibly\s+/gi, "");
	cleaned = cleaned.replace(/\bthe separate status\b/gi, "status");
	cleaned = cleaned.replace(/,\s+and dedupe status Focus files line/i, "");
	cleaned = cleaned.replace(
		/\bwhile preserving the already-working\b/i,
		"while preserving",
	);
	cleaned = cleaned.replace(
		/\bfocus-echo persistence behavior\b/i,
		"persistence",
	);
	cleaned = cleaned.replace(/,\s+while preserving/gi, " while preserving");
	cleaned = cleaned.replace(
		/,?\s+using the (?:(?:fresh|latest)|freshly captured) live status (?:snapshot|output)(?: as the source of truth)?(?:,?\s+then\s+.+?|\s+so\s+.+?|\s+and then re-verifying\s+.+?)?\.?$/i,
		"",
	);
	cleaned = cleaned.replace(
		/^(?:further\s+)?refining persisted focus echo normalization so\s+\/compact-plus status renders cleaner\s+objective, blockers, dependency chain, and next step text.*$/i,
		"refine persisted focus echo normalization for /compact-plus status",
	);
	cleaned = cleaned.replace(
		/^evaluate the newly pasted live .*compact\+ status after compaction and finish the persisted focus-?echo normalization work.*$/i,
		"Tighten persisted focus echo normalization for /compact-plus status",
	);
	cleaned = cleaned.replace(
		/^verify the self-improvement-workflow-derived persisted focus-?echo normalization live on a successful custom compact\+ co.*$/i,
		"Tighten persisted focus echo normalization for /compact-plus status",
	);
	cleaned = cleaned.replace(
		/^tighten persisted focus-?echo normalization(?:\s+in\s+\S+)?\s+for the new(?:ly|est) pasted live focus echo(?:\s*\/\s*post-compaction summary)? shape so\s+\/compact-plus status.*$/i,
		"Tighten persisted focus echo normalization for /compact-plus status",
	);
	cleaned = cleaned.replace(
		/^finali[sz]e the persisted focus-?echo normalization fixes(?:\s+in\s+\S+)?\s+for the new(?:ly|est) pasted live focus echo(?:\s*\/\s*post-c.*)?$/i,
		"Tighten persisted focus echo normalization for /compact-plus status",
	);
	cleaned = cleaned.replace(
		/^use the self-improvement workflow to finali[sz]e the persisted focus-?echo normalization fixes(?:\s+in\s+\S+)?(?:,\s*specifically)?\s+for the new(?:ly|est) pasted live\s+(?:last\s+)?focus echo(?:\s*\/\s*post-compaction summary)? shape so\s+\/compact-plus status.*$/i,
		"Tighten persisted focus echo normalization for /compact-plus status",
	);
	cleaned = cleaned.replace(
		/^tighten persisted focus echo\s*:\s*shorten objective, compress blockers, prune dependency chain\b/i,
		"Tighten persisted focus echo",
	);
	return truncateLine(rewriteLeadingGerund(cleaned));
}

function normalizeNextStepText(value: string): string {
	let cleaned = stripIssueBoilerplate(normalizeInlineSummaryText(value));
	cleaned = cleaned.replace(
		/^inspect(?:ing)?\s+[^ ]+\s+and\s+refin(?:e|ing)\s+/i,
		"refine ",
	);
	cleaned = cleaned.replace(/^continue in\s+\S+\s+to\s+/i, "");
	cleaned = cleaned.replace(/^continue with\s+/i, "");
	cleaned = cleaned.replace(
		/^refine\s+\S+\s+using the latest live\s+\/compact-plus status output so\s+objective\b.*$/i,
		"use live /compact-plus status output to refine Objective, Blockers, Dependency chain, and Next step.",
	);
	cleaned = cleaned.replace(
		/^refine\s+src\/reorder\.ts\s+around\s+buildPersistedFocusEcho\(summaryText\)\s+using the captured live\s+(?:last\s+)?focus echo,\s+specifically\b.*$/i,
		"refine buildPersistedFocusEcho(summaryText) normalization in src/reorder.ts against the captured live focus echo.",
	);
	cleaned = cleaned.replace(
		/^refine\s+src\/reorder\.ts\s+again\s+using the newly pasted live\s+(?:last\s+)?focus echo,\s+targeting\s+the\s+still-noisy\s+objective,\s+blockers,?.*$/i,
		"refine src/reorder.ts using the newly pasted live focus echo to clean Objective and Blockers.",
	);
	cleaned = cleaned.replace(
		/^reproduce the new(?:ly|est) pasted live\s+(?:last\s+)?focus echo exactly in test\/index\.test\.ts.*buildPersistedFocusEcho\(summaryText\).*(?:objective|blockers).*$/i,
		"reproduce the live focus echo in test/index.test.ts and refine buildPersistedFocusEcho(summaryText).",
	);
	cleaned = cleaned.replace(
		/^re-run\s+vitest run test\/index\.test\.ts,\s+tsc --noemit,\s+and\s+biome check src\/reorder\.ts test\/index\.test\.ts\s+against the newest.*$/i,
		"re-run targeted validation after the newest echo-normalization edits.",
	);
	cleaned = cleaned.replace(
		/^inspect the actual buildPersistedFocusEcho\(summary\) output from the failing\s+normalizes newly pasted post-compaction live snapshots\s+case.*$/i,
		"inspect buildPersistedFocusEcho(summary) output for the failing live-snapshot regression.",
	);
	cleaned = cleaned.replace(
		/^compare the newly pasted live\s+(?:last\s+)?focus echo against current buildPersistedFocusEcho\(summary\)\s*\/\s*parseFocusEcho\(\)\s+behaviou?r.*$/i,
		"compare the live focus echo against buildPersistedFocusEcho(summary)/parseFocusEcho() behavior.",
	);
	cleaned = cleaned.replace(
		/^reconcile the \d+ failing vitest expectations in test\/index\.test\.ts with the new src\/reorder\.ts behavior.*$/i,
		"update test/index.test.ts expectations for current src/reorder.ts behavior.",
	);
	cleaned = cleaned.replace(
		/^add\/update test\/index\.test\.ts regression coverage for the newest pasted live\s+(?:last\s+)?focus echo\s*\/\s*post-compaction summary shape.*$/i,
		"add regression coverage in test/index.test.ts for the newest live echo shape.",
	);
	cleaned = cleaned.replace(
		/^add\/update test\/index\.test\.ts with a regression for the newest pasted live\s+(?:last\s+)?focus echo shape beginning use the latest live\s+\/compact-plus status output as the source of truth.*$/i,
		"add regression coverage in test/index.test.ts for the newest live-source-of-truth echo shape.",
	);
	cleaned = cleaned.replace(
		/^add a focused regression in test\/index\.test\.ts for the just-pasted live\s+(?:last\s+)?focus echo(?: shape)? whose objective starts(?: with)?.*$/i,
		"add regression coverage in test/index.test.ts for the newest live-source-of-truth echo shape.",
	);
	cleaned = cleaned.replace(
		/^add a focused regression in test\/index\.test\.ts for the new(?:ly|est) live\s+(?:last\s+)?focus echo\s*\/\s*post-compaction summary shape whose objective(?: still carries| starts(?: with)?)?.*$/i,
		"add regression coverage in test/index.test.ts for the newest live-source-of-truth echo shape.",
	);
	cleaned = cleaned.replace(
		/^use the self-improvement workflow to finali[sz]e this task, starting with the relevant workflow\/playbook context in\s+\S+.*$/i,
		"use the self-improvement workflow to finalize the remaining echo-normalization fixes.",
	);
	cleaned = cleaned.replace(
		/^switch fully into the self-improvement workflow for\s+[A-Za-z0-9-]+,\s+using the newly added siw trigger guidance as.*$/i,
		"use the self-improvement workflow to finalize the remaining echo-normalization fixes.",
	);
	cleaned = cleaned.replace(
		/^use the just-pasted live .*compact\+ status\s*\/\s*last focus echo as the newest source of truth and isolate the still-leaki.*$/i,
		"use live /compact-plus status output to isolate the remaining echo leaks.",
	);
	cleaned = cleaned.replace(
		/^retry \/compact-plus standard until the pasted status shows.*$/i,
		"retry /compact-plus standard until custom path produces a clean Last focus echo.",
	);
	cleaned = cleaned.replace(
		/^add a focused regression in test\/index\.test\.ts for the new(?:ly|est) live\s+(?:last\s+)?focus echo\s*\/\s*post-compaction summary shape.*$/i,
		"add regression coverage in test/index.test.ts for the newest live echo shape.",
	);
	cleaned = cleaned.replace(
		/^run targeted vitest coverage for test\/index\.test\.ts, especially the new normalizes latest live-status snapshot source-of-truth summaries case.*$/i,
		"run targeted vitest coverage for test/index.test.ts.",
	);
	cleaned = cleaned.replace(/^validate the new\s+/i, "validate ");
	cleaned = cleaned.replace(/^further\s+/i, "");
	cleaned = cleaned.replace(
		/^shorten live persisted-focus echo objective,\s+/i,
		"shorten Objective, ",
	);
	cleaned = cleaned.replace(
		/^shorten live persisted-echo objective,\s+/i,
		"shorten Objective, ",
	);
	cleaned = cleaned.replace(
		/\bagainst \/compact-plus status output\b/i,
		"against live /compact-plus status output",
	);
	cleaned = cleaned.replace(/\s+to confirm\b.*$/i, "");
	cleaned = cleaned.replace(
		/\busing the actual\s+\/compact-plus status output as the target\.?$/i,
		"using live /compact-plus status output.",
	);
	cleaned = cleaned.replace(
		/\busing live \/compact-plus status output\.$/i,
		"from live /compact-plus status.",
	);
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

function findLastUserMessageIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
