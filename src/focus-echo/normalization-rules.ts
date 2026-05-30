export interface TextReplacementRule {
	readonly name: string;
	readonly pattern: RegExp;
	readonly replacement: string;
}

export function applyTextReplacementRules(
	value: string,
	rules: readonly TextReplacementRule[],
): string {
	let result = value;
	for (const rule of rules) {
		result = result.replace(rule.pattern, rule.replacement);
	}
	return result;
}

export const ISSUE_BOILERPLATE_PATTERNS = [
	/^(?:fix|work on|resolve)\s+seeds issue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?\s+by\s+/i,
	/^implement\s+(?:seeds issue\s+)?[A-Za-z0-9-]+(?:\s+in\s+\S+)?\s+by\s+/i,
	/^continue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?\s+by\s+/i,
	/^continue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?\s+using\s+.+?(?::|;\s+)/i,
];
export const LEADING_GERUND_REPLACEMENTS = new Map<string, string>([
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
export const DEPENDENCY_PRIORITY_PATTERNS = [
	/focus echo/i,
	/lastinjectedecho/i,
	/persist/i,
	/summary/i,
	/compactionentry\.summary/i,
	/session_compact/i,
	/compact-plus status/i,
	/status/i,
];
export const ACTIVE_FILE_SECTION_LABELS = new Set([
	"files read that still matter",
	"files modified",
	"likely next files to inspect/edit",
]);
export const PATH_DISPLAY_ANCHORS = [
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
export const ROOT_FILE_NAMES = new Set([
	"package.json",
	"package-lock.json",
	"README.md",
	"LICENSE",
	"tsconfig.json",
	"tsconfig.build.json",
	"vitest.config.ts",
	"DEV-RELEASE-PLAYBOOK.md",
]);

export const ACTIVE_FILE_GROUP_PRIORITY = [
	"files modified",
	"likely next files to inspect/edit",
	"files read that still matter",
	"default",
] as const;

export const ACTIVE_FILE_CANDIDATE_PATTERN =
	/^((?:\.\/|[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)/;

/** Blocker cleanup rules are ordered from live-status source-of-truth phrases to generic noise pruning. */
export const BLOCKER_NORMALIZATION_RULES: readonly TextReplacementRule[] = [
	{
		name: "blocker-001-examples-seen-live-include-i",
		pattern: /^examples seen live include\s+/i,
		replacement: "",
	},
	{
		name: "blocker-002-current-live-output-proves-persistence-works-but",
		pattern: /^current live output proves persistence works, but\s+/i,
		replacement: "",
	},
	{
		name: "blocker-003-need-a-follow-up-implementation-pass-i",
		pattern: /^need a follow-up implementation pass.*$/i,
		replacement: "",
	},
	{
		name: "blocker-004-the-latest-direct-live-last-focus-echo-is-was-st",
		pattern:
			/^(?:the\s+)?latest (?:direct )?live last focus echo (?:(?:is|was)(?: still)? )?too noisy.*$/i,
		replacement: "",
	},
	{
		name: "blocker-005-validate",
		pattern: /^need to validate that the new\s+/i,
		replacement: "validate ",
	},
	{
		name: "blocker-006-live-compact-plus-status-shows-noisy-persisted-e",
		pattern:
			/^(?:fresh|newly pasted|newest pasted) live\s+\/compact-plus status output\s+shows?\s+noisy persisted echo content(?:\s+despite\s+[^.]+)?(?:\s+.*)?$/i,
		replacement: "Live /compact-plus status shows noisy persisted echo content",
	},
	{
		name: "blocker-007-live-compact-plus-status-shows-noisy-persisted-e",
		pattern:
			/^(?:the\s+)?latest pasted live\s+.*compact\+ status shows a noisy\/stale persisted last focus echo.*$/i,
		replacement: "Live /compact-plus status shows noisy persisted echo content",
	},
	{
		name: "blocker-008-objective-blockers-and-next-step-still-leak-post",
		pattern:
			/^(?:fresh\s+)?live\s+(?:last\s+)?focus echo output leaks the newest\s*\/\s*post-compaction summary shape wording in objective, blockers, and(?:\s+next step|…).*$/i,
		replacement:
			"Objective, Blockers, and Next step still leak post-compaction wording",
	},
	{
		name: "blocker-009-live-compact-plus-status-shows-noisy-persisted-e",
		pattern:
			/^(?:the\s+)?latest pasted live\s+(?:last\s+)?focus echo is noisy.*$/i,
		replacement: "Live /compact-plus status shows noisy persisted echo content",
	},
	{
		name: "blocker-010-live-compact-plus-status-shows-noisy-persisted-e",
		pattern:
			/^(?:the\s+)?newly pasted live\s+(?:last\s+)?focus echo is noisy.*$/i,
		replacement: "Live /compact-plus status shows noisy persisted echo content",
	},
	{
		name: "blocker-011-live-compact-plus-status-shows-noisy-persisted-e",
		pattern:
			/^(?:the\s+)?live\s+(?:last\s+)?focus echo needs cleanup around\s+objective, blockers, dependency chain, and next step.*$/i,
		replacement: "Live /compact-plus status shows noisy persisted echo content",
	},
	{
		name: "blocker-012-live-compact-plus-status-shows-noisy-persisted-e",
		pattern:
			/^(?:the\s+)?newest pasted live\s+(?:last\s+)?focus echo shows noise in\s+objective, blockers, dependency chain, and next step.*$/i,
		replacement: "Live /compact-plus status shows noisy persisted echo content",
	},
	{
		name: "blocker-013-objective-includes-live-source-of-truth-prefix",
		pattern:
			/^(?:the\s+)?newest pasted live\s+(?:last\s+)?focus echo has a new unnormalized objective prefix:.*$/i,
		replacement: "Objective includes live source-of-truth prefix",
	},
	{
		name: "blocker-014-objective-includes-live-source-of-truth-prefix",
		pattern:
			/^(?:the\s+)?new(?:ly|est) pasted live\s+(?:last\s+)?focus echo shows an unnormalized objective prefix beginning\s+use the latest pasted live foc(?:us)? echo.*$/i,
		replacement: "Objective includes live source-of-truth prefix",
	},
	{
		name: "blocker-015-objective-includes-live-source-of-truth-prefix",
		pattern:
			/^(?:the\s+)?new(?:ly|est) pasted live\s+(?:last\s+)?focus echo shows another unnormalized objective prefix beginning.*$/i,
		replacement: "Objective includes live source-of-truth prefix",
	},
	{
		name: "blocker-016-objective-includes-pasted-live-wording",
		pattern:
			/^latest live objective starts with\s+tighten persisted focus-?echo normalization(?:\s+in\s+\S+)?\s+for the new(?:ly|est) pasted(?:\s+live\s+focus\s+echo(?:\s*\/\s*post-compaction summary)?\s+shape|\s+l…).*$/i,
		replacement: "Objective includes pasted-live wording",
	},
	{
		name: "blocker-017-objective-includes-pasted-live-wording",
		pattern:
			/^latest live objective starts with\s+finali[sz]e the persisted focus-?echo normalization fixes(?:\s+in\s+\S+)?\s+for the new(?:ly|est) pasted(?:\s+live\s+focus\s+echo(?:\s*\/\s*post-compaction summary)?\s+shape|\s+l…).*$/i,
		replacement: "Objective includes pasted-live wording",
	},
	{
		name: "blocker-018-objective-includes-self-improvement-workflow-wor",
		pattern:
			/^live objective begins:\s+use the self-improvement workflow to finali[sz]e the persisted focus-?echo normalization fixes.*$/i,
		replacement: "Objective includes self-improvement-workflow wording",
	},
	{
		name: "blocker-019-blockers-retains-noisy-stale-live-wording",
		pattern: /^blockers include noisy\/stale live wording.*$/i,
		replacement: "Blockers retains noisy/stale live wording",
	},
	{
		name: "blocker-020-objective-blockers-dependency-chain-and-next-ste",
		pattern:
			/^(?:the\s+)?latest live output reports noisy\/stale blockers wording and umbrella cleanup text around objective, blockers, dependency chain, and next step.*$/i,
		replacement:
			"Objective, Blockers, Dependency chain, and Next step need cleanup",
	},
	{
		name: "blocker-021-objective-blockers-dependency-chain-and-next-ste",
		pattern:
			/^(?:the\s+)?newest pasted live blockers contain noisy\/stale umbrella cleanup text around objective, blockers, dependency chain,.*$/i,
		replacement:
			"Objective, Blockers, Dependency chain, and Next step need cleanup",
	},
	{
		name: "blocker-022-blockers-retains-noisy-stale-live-wording",
		pattern:
			/^(?:the\s+)?newest live blockers contain stale\/noisy wording, including.*$/i,
		replacement: "Blockers retains noisy/stale live wording",
	},
	{
		name: "blocker-023-blockers-retains-noisy-stale-live-wording",
		pattern:
			/^latest live blockers include variants(?: like| from the newest live summary wording family).*$/i,
		replacement: "Blockers retains noisy/stale live wording",
	},
	{
		name: "blocker-024-blockers-retains-noisy-stale-live-wording",
		pattern: /^live blockers include stale\/noisy items such as.*$/i,
		replacement: "Blockers retains noisy/stale live wording",
	},
	{
		name: "blocker-025-final-live-custom-path-verification-is-still-pen",
		pattern:
			/^final live verification is missing because the latest pasted .*compact\+ status shows.*$/i,
		replacement: "Final live custom-path verification is still pending",
	},
	{
		name: "blocker-026-final-live-custom-path-verification-is-still-pen",
		pattern:
			/^because the custom compact\+ summary path did not run, the new normalization logic has not yet been proven against fresh.*$/i,
		replacement: "Final live custom-path verification is still pending",
	},
	{
		name: "blocker-027-wait-to-record-mulch-until-live-custom-path-succ",
		pattern:
			/^mulch expertise is empty \(no expertise recorded yet\.\) and should remain unrecorded until live custom-path success.*$/i,
		replacement: "Wait to record Mulch until live custom-path success",
	},
	{
		name: "blocker-028-regex-cleanup-flow-in-src-reorder-ts-remains-the",
		pattern:
			/^(?:the\s+)?active normalization hotspot remains the regex cleanup flow in src\/reorder\.ts, especially the section beginning.*$/i,
		replacement: "Regex cleanup flow in src/reorder.ts remains the hotspot",
	},
	{
		name: "blocker-029-next-step-needs-shortening",
		pattern: /^(?:the\s+)?newest live next step is too verbose.*$/i,
		replacement: "Next step needs shortening",
	},
	{
		name: "blocker-030-objective-blockers-dependency-chain-and-next-ste",
		pattern:
			/^cleanup needed around objective, blockers, dependency chain, and next step.*$/i,
		replacement:
			"Objective, Blockers, Dependency chain, and Next step need cleanup",
	},
	{
		name: "blocker-031-latest-changes-are-not-yet-validated",
		pattern:
			/^(?:the\s+)?newest changes have not been validated in this snippet with a post-edit vitest run.*$/i,
		replacement: "Latest changes are not yet validated",
	},
	{
		name: "blocker-032-confirm-stale-active-files-leakage",
		pattern:
			/^(?:need to confirm whether|(?:it\s+)needs confirmation whether) stale active files entries are(?: actually)? leaking into the persisted echo\/status flow.*$/i,
		replacement: "Confirm stale Active files leakage",
	},
	{
		name: "blocker-033-dependency-chain-still-needs-pruning",
		pattern:
			/^dependency-chain cleanup for the newest live echo may need pruning\/shortening beyond.*$/i,
		replacement: "Dependency chain still needs pruning",
	},
	{
		name: "blocker-034-latest-regex-edits-are-not-yet-validated",
		pattern:
			/^(?:the\s+)?latest regex edits for that shape are not yet validated.*$/i,
		replacement: "Latest regex edits are not yet validated",
	},
	{
		name: "blocker-035-add-regression-coverage-for-the-newest-live-echo",
		pattern:
			/^need regression coverage in test\/index\.test\.ts for the newest pasted live echo\s*\/\s*post-compaction summary shape.*$/i,
		replacement: "Add regression coverage for the newest live echo shape",
	},
	{
		name: "blocker-036-add-regression-coverage-for-the-newest-live-sour",
		pattern:
			/^test\/index\.test\.ts needs a regression for this newest pasted live objective-prefix shape.*$/i,
		replacement:
			"Add regression coverage for the newest live-source-of-truth echo shape",
	},
	{
		name: "blocker-037-add-regression-coverage-for-the-newest-live-sour",
		pattern:
			/^test\/index\.test\.ts needs regression coverage for this newest pasted live objective-prefix\s*\/\s*post-compaction summary shape.*$/i,
		replacement:
			"Add regression coverage for the newest live-source-of-truth echo shape",
	},
	{
		name: "blocker-038-update-test-expectations-for-path-preference-act",
		pattern:
			/^test expectations are now out of sync with the new path-preference behavior that removes package\.json when path items exist.*$/i,
		replacement: "Update test expectations for path-preference active files",
	},
	{
		name: "blocker-039-dependency-chain-and-next-step-need-shortening",
		pattern:
			/^dependency chain and next step remain overly verbose\/truncated.*$/i,
		replacement: "Dependency chain and Next step need shortening",
	},
	{
		name: "blocker-040-objective-needs-shortening",
		pattern: /^objective is verbose\/truncated:\s+.*$/i,
		replacement: "Objective needs shortening",
	},
	{
		name: "blocker-041-blockers-retains-stale-literal-text",
		pattern: /^blockers? leaks? stale\/literal text:\s+.*$/i,
		replacement: "Blockers retains stale/literal text",
	},
	{
		name: "blocker-042-blockers-retains-stale-validation-dedupe-noise",
		pattern: /^blockers?.*stale validation\/dedupe noise.*$/i,
		replacement: "Blockers retains stale validation/dedupe noise",
	},
	{
		name: "blocker-043-next-step-still-includes-literal-command-text",
		pattern:
			/^next step (?:still )?(?:renders?|includes?) literal command text:\s+.*$/i,
		replacement: "Next step still includes literal command text",
	},
	{
		name: "blocker-044-against-live-compact-plus-status-output",
		pattern: /\s+actually improves live\s+\/compact-plus status output\.?$/i,
		replacement: " against live /compact-plus status output",
	},
	{
		name: "blocker-045-focus-files-line-needs-deduping",
		pattern: /^focus files status output\s+needs deduping.*$/i,
		replacement: "Focus files line needs deduping",
	},
	{
		name: "blocker-046-focus-files-line-needs-deduping",
		pattern: /^focus files status output\s+still needs deduping.*$/i,
		replacement: "Focus files line needs deduping",
	},
	{
		name: "blocker-047-compact-plus-status-is",
		pattern: /\blive\s+\/compact-plus status\s+is\s+/i,
		replacement: "/compact-plus status is ",
	},
	{
		name: "blocker-048-i",
		pattern: /\bstill\s+/i,
		replacement: "",
	},
	{
		name: "blocker-049-src-s-s-has-now-been-updated-to-i",
		pattern: /^src\/\S+\s+has now been updated to\s+.*$/i,
		replacement: "",
	},
	{
		name: "blocker-050-g",
		pattern: /[.;]+$/g,
		replacement: "",
	},
	{
		name: "blocker-051-with-i",
		pattern: /\s+with$/i,
		replacement: "",
	},
];

/** Dependency-chain cleanup rules shorten known path and echo-normalization wording. */
export const DEPENDENCY_NORMALIZATION_RULES: readonly TextReplacementRule[] = [
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
	{
		name: "dependency-005-buildpersistedfocusecho-parsefocusecho-in-src-re",
		pattern:
			/^buildPersistedFocusEcho\(summaryText\)\s*\/\s*parseFocusEcho\(\)\s+in\s+src\/reorder\.ts(?:\s+normalize summary fields)?$/i,
		replacement: "buildPersistedFocusEcho()/parseFocusEcho() in src/reorder.ts",
	},
	{
		name: "dependency-006-summary-normalization-helpers-in-src-reorder-ts",
		pattern: /^summary-normalization helpers including\s+.*$/i,
		replacement: "summary-normalization helpers in src/reorder.ts",
	},
	{
		name: "dependency-007-or",
		pattern: /\sand\/or\s/gi,
		replacement: " or ",
	},
];

/** Objective rules that must run before optional status/check prefix splitting. */
export const OBJECTIVE_PRE_COLON_RULES: readonly TextReplacementRule[] = [
	{
		name: "objective-pre-001-v-1",
		pattern: /\bthe working v(\d+\.\d+\.\d+)\b/i,
		replacement: "v$1",
	},
	{
		name: "objective-pre-002-persisted-focus-echo",
		pattern: /\bpersisted last focus echo\b/i,
		replacement: "persisted focus echo",
	},
	{
		name: "objective-pre-003-focus-echo",
		pattern: /\blast focus echo\b/i,
		replacement: "focus echo",
	},
];

/** Objective source-of-truth rules remove live-status lead-ins before issue boilerplate is stripped again. */
export const OBJECTIVE_SOURCE_OF_TRUTH_RULES: readonly TextReplacementRule[] = [
	{
		name: "objective-source-001-further-i",
		pattern: /^further\s+/i,
		replacement: "",
	},
	{
		name: "objective-source-002-us-e-ing-the-newly-pasted-post-compaction-s-comp",
		pattern:
			/^us(?:e|ing) the newly pasted(?: post-compaction)?\s+\/compact-plus status (?:snapshot|output)(?:\s+and\s+latest pasted focus echo)?\s+as the source of truth(?:\s+to\s+)?(?:further\s+)?/i,
		replacement: "",
	},
	{
		name: "objective-source-003-us-e-ing-the-latest-live-compact-plus-status-sna",
		pattern:
			/^us(?:e|ing) the latest live\s+\/compact-plus status (?:snapshot|output)\s+as the source of truth(?:\s+to\s+)?(?:further\s+)?/i,
		replacement: "",
	},
	{
		name: "objective-source-004-us-e-ing-the-latest-live-compact-plus-status-s-f",
		pattern:
			/^us(?:e|ing) the latest live\s+\/compact-plus status\s*\/\s*focus echo shape\s+as the source of truth(?:\s+in\s+\S+)?(?:\s+to\s+)?(?:further\s+)?/i,
		replacement: "",
	},
	{
		name: "objective-source-005-us-e-ing-the-latest-pasted-live-focus-echo-s-com",
		pattern:
			/^us(?:e|ing) the latest pasted live focus echo\s*\/\s*\/compact-plus status output\s+as the source of truth(?:\s+in\s+\S+)?(?:\s+to\s+)?(?:further\s+)?/i,
		replacement: "",
	},
	{
		name: "objective-source-006-us-e-ing-the-newly-pasted-live-s-focus-echo-as-t",
		pattern:
			/^us(?:e|ing) the newly pasted(?: live)?\s+focus echo as the current live source of truth(?:\s+to\s+)?(?:further\s+)?/i,
		replacement: "",
	},
];

/** Objective cleanup rules shorten persisted-focus-echo wording while preserving readable intent. */
export const OBJECTIVE_NORMALIZATION_RULES: readonly TextReplacementRule[] = [
	{
		name: "objective-001-continue-a-za-z0-9-s-in-s-s-by-s-i",
		pattern: /^continue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?(?:,\s*|\s+by\s+|\s+)/i,
		replacement: "",
	},
	{
		name: "objective-002-in-a-za-z0-9-s-to-i",
		pattern: /^in\s+[A-Za-z0-9_.-]+\s+to\s+/i,
		replacement: "",
	},
	{
		name: "objective-003-continue-a-za-z0-9-s-in-s-s-by-s-i",
		pattern: /^continue\s+[A-Za-z0-9-]+(?:\s+in\s+\S+)?(?:,\s*|\s+by\s+|\s+)/i,
		replacement: "",
	},
	{
		name: "objective-004-especially-objective-blockers-dependency-chain-a",
		pattern:
			/,\s+especially objective, blockers, dependency chain, and(?: the literal)? next step\.?$/i,
		replacement: "",
	},
	{
		name: "objective-005-to-i",
		pattern: /^to\s+/i,
		replacement: "",
	},
	{
		name: "objective-006-clean-up-persisted-focus-echo",
		pattern:
			/^\s*focus files dedupe is fixed, but\s+the persisted focus echo needs cleanup for\s+/i,
		replacement: "clean up persisted focus echo: ",
	},
	{
		name: "objective-007-s-focus-files-dedupe-is-fixed-but-i",
		pattern: /^\s*focus files dedupe is fixed, but\s+/i,
		replacement: "",
	},
	{
		name: "objective-008-needs-cleanup-for",
		pattern: /\bstill needs cleanup for\b/i,
		replacement: "needs cleanup for",
	},
	{
		name: "objective-009-clean-up-persisted-focus-echo",
		pattern: /^\s*the persisted focus echo needs cleanup for\s+/i,
		replacement: "clean up persisted focus echo: ",
	},
	{
		name: "objective-010-clean-up-persisted-focus-echo",
		pattern: /^\s*persisted focus echo needs cleanup for\s+/i,
		replacement: "clean up persisted focus echo: ",
	},
	{
		name: "objective-011-src-s-i",
		pattern: /;\s+src\/\S+.*$/i,
		replacement: "",
	},
	{
		name: "objective-012-persisted-focus-echo",
		pattern: /\bpersisted focus-echo output\b/i,
		replacement: "persisted focus echo",
	},
	{
		name: "objective-013-shorten",
		pattern: /\bby shortening\b/i,
		replacement: ": shorten",
	},
	{
		name: "objective-014-compress",
		pattern: /\bcompressing\b/gi,
		replacement: "compress",
	},
	{
		name: "objective-015-prune",
		pattern: /\bpruning\b/gi,
		replacement: "prune",
	},
	{
		name: "objective-016-dedupe",
		pattern: /\bdeduping\b/gi,
		replacement: "dedupe",
	},
	{
		name: "objective-017-gi",
		pattern: /\bpossibly\s+/gi,
		replacement: "",
	},
	{
		name: "objective-018-status",
		pattern: /\bthe separate status\b/gi,
		replacement: "status",
	},
	{
		name: "objective-019-and-dedupe-status-focus-files-line-i",
		pattern: /,\s+and dedupe status Focus files line/i,
		replacement: "",
	},
	{
		name: "objective-020-while-preserving",
		pattern: /\bwhile preserving the already-working\b/i,
		replacement: "while preserving",
	},
	{
		name: "objective-021-persistence",
		pattern: /\bfocus-echo persistence behavior\b/i,
		replacement: "persistence",
	},
	{
		name: "objective-022-while-preserving",
		pattern: /,\s+while preserving/gi,
		replacement: " while preserving",
	},
	{
		name: "objective-023-s-using-the-fresh-latest-freshly-captured-live-s",
		pattern:
			/,?\s+using the (?:(?:fresh|latest)|freshly captured) live status (?:snapshot|output)(?: as the source of truth)?(?:,?\s+then\s+.+?|\s+so\s+.+?|\s+and then re-verifying\s+.+?)?\.?$/i,
		replacement: "",
	},
	{
		name: "objective-024-refine-persisted-focus-echo-normalization-for-co",
		pattern:
			/^(?:further\s+)?refining persisted focus echo normalization so\s+\/compact-plus status renders cleaner\s+objective, blockers, dependency chain, and next step text.*$/i,
		replacement:
			"refine persisted focus echo normalization for /compact-plus status",
	},
	{
		name: "objective-025-tighten-persisted-focus-echo-normalization-for-c",
		pattern:
			/^evaluate the newly pasted live .*compact\+ status after compaction and finish the persisted focus-?echo normalization work.*$/i,
		replacement:
			"Tighten persisted focus echo normalization for /compact-plus status",
	},
	{
		name: "objective-026-tighten-persisted-focus-echo-normalization-for-c",
		pattern:
			/^verify the self-improvement-workflow-derived persisted focus-?echo normalization live on a successful custom compact\+ co.*$/i,
		replacement:
			"Tighten persisted focus echo normalization for /compact-plus status",
	},
	{
		name: "objective-027-tighten-persisted-focus-echo-normalization-for-c",
		pattern:
			/^tighten persisted focus-?echo normalization(?:\s+in\s+\S+)?\s+for the new(?:ly|est) pasted live focus echo(?:\s*\/\s*post-compaction summary)? shape so\s+\/compact-plus status.*$/i,
		replacement:
			"Tighten persisted focus echo normalization for /compact-plus status",
	},
	{
		name: "objective-028-tighten-persisted-focus-echo-normalization-for-c",
		pattern:
			/^finali[sz]e the persisted focus-?echo normalization fixes(?:\s+in\s+\S+)?\s+for the new(?:ly|est) pasted live focus echo(?:\s*\/\s*post-c.*)?$/i,
		replacement:
			"Tighten persisted focus echo normalization for /compact-plus status",
	},
	{
		name: "objective-029-tighten-persisted-focus-echo-normalization-for-c",
		pattern:
			/^use the self-improvement workflow to finali[sz]e the persisted focus-?echo normalization fixes(?:\s+in\s+\S+)?(?:,\s*specifically)?\s+for the new(?:ly|est) pasted live\s+(?:last\s+)?focus echo(?:\s*\/\s*post-compaction summary)? shape so\s+\/compact-plus status.*$/i,
		replacement:
			"Tighten persisted focus echo normalization for /compact-plus status",
	},
	{
		name: "objective-030-tighten-persisted-focus-echo",
		pattern:
			/^tighten persisted focus echo\s*:\s*shorten objective, compress blockers, prune dependency chain\b/i,
		replacement: "Tighten persisted focus echo",
	},
];

/** Next-step cleanup rules collapse live-regression instructions into concise actionable follow-ups. */
export const NEXT_STEP_NORMALIZATION_RULES: readonly TextReplacementRule[] = [
	{
		name: "next-step-001-refine",
		pattern: /^inspect(?:ing)?\s+[^ ]+\s+and\s+refin(?:e|ing)\s+/i,
		replacement: "refine ",
	},
	{
		name: "next-step-002-continue-in-s-s-to-i",
		pattern: /^continue in\s+\S+\s+to\s+/i,
		replacement: "",
	},
	{
		name: "next-step-003-continue-with-i",
		pattern: /^continue with\s+/i,
		replacement: "",
	},
	{
		name: "next-step-004-use-live-compact-plus-status-output-to-refine-ob",
		pattern:
			/^refine\s+\S+\s+using the latest live\s+\/compact-plus status output so\s+objective\b.*$/i,
		replacement:
			"use live /compact-plus status output to refine Objective, Blockers, Dependency chain, and Next step.",
	},
	{
		name: "next-step-005-refine-buildpersistedfocusecho-summarytext-norma",
		pattern:
			/^refine\s+src\/reorder\.ts\s+around\s+buildPersistedFocusEcho\(summaryText\)\s+using the captured live\s+(?:last\s+)?focus echo,\s+specifically\b.*$/i,
		replacement:
			"refine buildPersistedFocusEcho(summaryText) normalization in src/reorder.ts against the captured live focus echo.",
	},
	{
		name: "next-step-006-refine-src-reorder-ts-using-the-newly-pasted-liv",
		pattern:
			/^refine\s+src\/reorder\.ts\s+again\s+using the newly pasted live\s+(?:last\s+)?focus echo,\s+targeting\s+the\s+still-noisy\s+objective,\s+blockers,?.*$/i,
		replacement:
			"refine src/reorder.ts using the newly pasted live focus echo to clean Objective and Blockers.",
	},
	{
		name: "next-step-007-reproduce-the-live-focus-echo-in-test-index-test",
		pattern:
			/^reproduce the new(?:ly|est) pasted live\s+(?:last\s+)?focus echo exactly in test\/index\.test\.ts.*buildPersistedFocusEcho\(summaryText\).*(?:objective|blockers).*$/i,
		replacement:
			"reproduce the live focus echo in test/index.test.ts and refine buildPersistedFocusEcho(summaryText).",
	},
	{
		name: "next-step-008-re-run-targeted-validation-after-the-newest-echo",
		pattern:
			/^re-run\s+vitest run test\/index\.test\.ts,\s+tsc --noemit,\s+and\s+biome check src\/reorder\.ts test\/index\.test\.ts\s+against the newest.*$/i,
		replacement:
			"re-run targeted validation after the newest echo-normalization edits.",
	},
	{
		name: "next-step-009-inspect-buildpersistedfocusecho-summary-output-f",
		pattern:
			/^inspect the actual buildPersistedFocusEcho\(summary\) output from the failing\s+normalizes newly pasted post-compaction live snapshots\s+case.*$/i,
		replacement:
			"inspect buildPersistedFocusEcho(summary) output for the failing live-snapshot regression.",
	},
	{
		name: "next-step-010-compare-the-live-focus-echo-against-buildpersist",
		pattern:
			/^compare the newly pasted live\s+(?:last\s+)?focus echo against current buildPersistedFocusEcho\(summary\)\s*\/\s*parseFocusEcho\(\)\s+behaviou?r.*$/i,
		replacement:
			"compare the live focus echo against buildPersistedFocusEcho(summary)/parseFocusEcho() behavior.",
	},
	{
		name: "next-step-011-update-test-index-test-ts-expectations-for-curre",
		pattern:
			/^reconcile the \d+ failing vitest expectations in test\/index\.test\.ts with the new src\/reorder\.ts behavior.*$/i,
		replacement:
			"update test/index.test.ts expectations for current src/reorder.ts behavior.",
	},
	{
		name: "next-step-012-add-regression-coverage-in-test-index-test-ts-fo",
		pattern:
			/^add\/update test\/index\.test\.ts regression coverage for the newest pasted live\s+(?:last\s+)?focus echo\s*\/\s*post-compaction summary shape.*$/i,
		replacement:
			"add regression coverage in test/index.test.ts for the newest live echo shape.",
	},
	{
		name: "next-step-013-add-regression-coverage-in-test-index-test-ts-fo",
		pattern:
			/^add\/update test\/index\.test\.ts with a regression for the newest pasted live\s+(?:last\s+)?focus echo shape beginning use the latest live\s+\/compact-plus status output as the source of truth.*$/i,
		replacement:
			"add regression coverage in test/index.test.ts for the newest live-source-of-truth echo shape.",
	},
	{
		name: "next-step-014-add-regression-coverage-in-test-index-test-ts-fo",
		pattern:
			/^add a focused regression in test\/index\.test\.ts for the just-pasted live\s+(?:last\s+)?focus echo(?: shape)? whose objective starts(?: with)?.*$/i,
		replacement:
			"add regression coverage in test/index.test.ts for the newest live-source-of-truth echo shape.",
	},
	{
		name: "next-step-015-add-regression-coverage-in-test-index-test-ts-fo",
		pattern:
			/^add a focused regression in test\/index\.test\.ts for the new(?:ly|est) live\s+(?:last\s+)?focus echo\s*\/\s*post-compaction summary shape whose objective(?: still carries| starts(?: with)?)?.*$/i,
		replacement:
			"add regression coverage in test/index.test.ts for the newest live-source-of-truth echo shape.",
	},
	{
		name: "next-step-016-use-the-self-improvement-workflow-to-finalize-th",
		pattern:
			/^use the self-improvement workflow to finali[sz]e this task, starting with the relevant workflow\/playbook context in\s+\S+.*$/i,
		replacement:
			"use the self-improvement workflow to finalize the remaining echo-normalization fixes.",
	},
	{
		name: "next-step-017-use-the-self-improvement-workflow-to-finalize-th",
		pattern:
			/^switch fully into the self-improvement workflow for\s+[A-Za-z0-9-]+,\s+using the newly added siw trigger guidance as.*$/i,
		replacement:
			"use the self-improvement workflow to finalize the remaining echo-normalization fixes.",
	},
	{
		name: "next-step-018-use-live-compact-plus-status-output-to-isolate-t",
		pattern:
			/^use the just-pasted live .*compact\+ status\s*\/\s*last focus echo as the newest source of truth and isolate the still-leaki.*$/i,
		replacement:
			"use live /compact-plus status output to isolate the remaining echo leaks.",
	},
	{
		name: "next-step-019-retry-compact-plus-standard-until-custom-path-pr",
		pattern: /^retry \/compact-plus standard until the pasted status shows.*$/i,
		replacement:
			"retry /compact-plus standard until custom path produces a clean Last focus echo.",
	},
	{
		name: "next-step-020-add-regression-coverage-in-test-index-test-ts-fo",
		pattern:
			/^add a focused regression in test\/index\.test\.ts for the new(?:ly|est) live\s+(?:last\s+)?focus echo\s*\/\s*post-compaction summary shape.*$/i,
		replacement:
			"add regression coverage in test/index.test.ts for the newest live echo shape.",
	},
	{
		name: "next-step-021-run-targeted-vitest-coverage-for-test-index-test",
		pattern:
			/^run targeted vitest coverage for test\/index\.test\.ts, especially the new normalizes latest live-status snapshot source-of-truth summaries case.*$/i,
		replacement: "run targeted vitest coverage for test/index.test.ts.",
	},
	{
		name: "next-step-022-validate",
		pattern: /^validate the new\s+/i,
		replacement: "validate ",
	},
	{
		name: "next-step-023-further-i",
		pattern: /^further\s+/i,
		replacement: "",
	},
	{
		name: "next-step-024-shorten-objective",
		pattern: /^shorten live persisted-focus echo objective,\s+/i,
		replacement: "shorten Objective, ",
	},
	{
		name: "next-step-025-shorten-objective",
		pattern: /^shorten live persisted-echo objective,\s+/i,
		replacement: "shorten Objective, ",
	},
	{
		name: "next-step-026-against-live-compact-plus-status-output",
		pattern: /\bagainst \/compact-plus status output\b/i,
		replacement: "against live /compact-plus status output",
	},
	{
		name: "next-step-027-to-confirm-i",
		pattern: /\s+to confirm\b.*$/i,
		replacement: "",
	},
	{
		name: "next-step-028-using-live-compact-plus-status-output",
		pattern:
			/\busing the actual\s+\/compact-plus status output as the target\.?$/i,
		replacement: "using live /compact-plus status output.",
	},
	{
		name: "next-step-029-from-live-compact-plus-status",
		pattern: /\busing live \/compact-plus status output\.$/i,
		replacement: "from live /compact-plus status.",
	},
];
