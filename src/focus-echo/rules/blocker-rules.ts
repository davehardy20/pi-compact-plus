import { MAX_BLOCKERS } from "../model.js";
import {
	capitalizeSentence,
	hasIssueBoilerplate,
	normalizeInlineSummaryText,
	splitSummaryClauses,
	stripListPrefix,
	truncateLine,
} from "./shared.js";
import {
	applyTextReplacementRules,
	type TextReplacementRule,
} from "./types.js";

/** Blocker cleanup rules are ordered from live-status source-of-truth phrases to generic noise pruning. */
const BLOCKER_NORMALIZATION_RULES: readonly TextReplacementRule[] = [
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
	// blocker-028 (regex-cleanup-flow-in-src-reorder-ts) pruned in plan pl-874d step 4:
	// src/reorder.ts was deleted in slice 0, so this rule was anchored to a dead path
	// and produced output naming a file that no longer exists. See test goldens for rationale.
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

export function normalizeBlockers(
	blockers: string[],
	errors: string[],
): string[] {
	const items = [...blockers, ...errors]
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

function summarizeEmbeddedEchoFieldAsBlocker(line: string): string | null {
	const cleaned = normalizeInlineSummaryText(line);
	const objective = cleaned.match(/^objective:\s+(.+)$/i);
	if (objective) {
		const objectiveText = objective[1];
		const hasBoilerplate = hasIssueBoilerplate(objectiveText);
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
