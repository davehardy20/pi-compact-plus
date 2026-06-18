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

/** Objective rules that must run before optional status/check prefix splitting. */
const OBJECTIVE_PRE_COLON_RULES: readonly TextReplacementRule[] = [
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
const OBJECTIVE_SOURCE_OF_TRUTH_RULES: readonly TextReplacementRule[] = [
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
const OBJECTIVE_NORMALIZATION_RULES: readonly TextReplacementRule[] = [
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

export function normalizeObjective(value: string): string {
	let cleaned = stripIssueBoilerplate(normalizeInlineSummaryText(value)).trim();
	cleaned = applyTextReplacementRules(cleaned, OBJECTIVE_PRE_COLON_RULES);
	const colonSplit = cleaned.match(/^(.*?):\s+(.*)$/);
	if (
		colonSplit &&
		/(follow-up|requested|status check|carry out)/i.test(colonSplit[1])
	) {
		cleaned = colonSplit[2];
	}
	cleaned = applyTextReplacementRules(cleaned, OBJECTIVE_SOURCE_OF_TRUTH_RULES);
	cleaned = stripIssueBoilerplate(cleaned).trim();
	cleaned = applyTextReplacementRules(cleaned, OBJECTIVE_NORMALIZATION_RULES);
	return truncateLine(rewriteLeadingGerund(cleaned));
}
