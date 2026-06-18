import {
	normalizeInlineSummaryText,
	rewriteLeadingGerund,
	stripIssueBoilerplate,
	truncateLine,
} from "./shared.js";
import {
	applyTextReplacementRules,
	type TextReplacementRule,
} from "./types.js";

/** Next-step cleanup rules collapse live-regression instructions into concise actionable follow-ups. */
const NEXT_STEP_NORMALIZATION_RULES: readonly TextReplacementRule[] = [
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
	// next-step-005, next-step-006, and next-step-011 pruned in plan pl-874d step 4:
	// all three produced output naming src/reorder.ts, which was deleted in slice 0.
	// The rules were path-specific and non-generalizable. See test goldens for rationale.
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

export function normalizeNextStep(value: string): string {
	let cleaned = stripIssueBoilerplate(normalizeInlineSummaryText(value));
	cleaned = applyTextReplacementRules(cleaned, NEXT_STEP_NORMALIZATION_RULES);
	return truncateLine(rewriteLeadingGerund(cleaned));
}
