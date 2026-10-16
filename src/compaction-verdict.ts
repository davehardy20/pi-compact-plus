/**
 * The typed verdict of one Compact+ compaction decision.
 *
 * Compact+ decides whether a compaction runs, runs with less of its own optional
 * evidence, or does not run at all. The decision used to survive only as a free-text
 * prose string plus a UI notice, so a caller could not ask "what just happened?" without
 * matching prose.
 *
 * The verdict is the decision, not a log line. `kind` is the closed set of outcomes
 * Compact+ can produce, `reason` is the unchanged prose for that outcome, and the
 * optional evidence fields carry the numbers behind a budget decision.
 *
 * `reason` is never rewritten and never embeds provider text, so the status fallback line and
 * the persisted telemetry prose can render it verbatim without either becoming a second source
 * of truth.
 *
 * The mapper and the runtime guard are used at the telemetry read boundary in `src/events.ts`,
 * where a persisted reason is mapped and guarded before the coordinator records it. Only the
 * verdict types and the closed kind set are re-exported from the extension entry point.
 */

import { NATIVE_FALLBACK_REASON } from "./compatibility.js";
import {
	SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
	SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
	SUMMARIZATION_INTENT_EVIDENCE_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
	SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
} from "./summarization-overflow.js";

/**
 * - `accepted`: the request was accepted and a compaction was produced.
 * - `trimmed`: a compaction was produced, but Compact+ dropped some of the additional
 *   intent evidence it adds itself. The transcript was not cut further.
 * - `deferred`: Compact+ did not produce its own compaction and stepped aside so Pi's
 *   compaction handles the request: its estimate was contradicted by provider-reported
 *   usage, the runtime could not give it a stream-aware route, or its own summarization
 *   was unavailable on a path where Pi still compacts.
 * - `declined`: Compact+ refused this compaction request before its own attempt could
 *   produce a result, or its own attempt could not be carried out safely. Pi may still
 *   compact natively.
 * - `cancelled`: Compact+ stopped an attempt it had started and was itself running: an
 *   abort, a superseded context, or an attempt it cancelled after measuring it.
 */
export type CompactionVerdictKind =
	| "accepted"
	| "trimmed"
	| "deferred"
	| "declined"
	| "cancelled";

export const COMPACTION_VERDICT_KINDS: readonly CompactionVerdictKind[] = [
	"accepted",
	"trimmed",
	"deferred",
	"declined",
	"cancelled",
];

export interface CompactionVerdict {
	kind: CompactionVerdictKind;
	/** Unchanged Compact+ prose for this outcome. Null when nothing was dropped or refused. */
	reason: string | null;
	/** Set only when Compact+ dropped its own optional intent evidence. */
	evidenceTrimmedTurns?: number;
	/**
	 * Usage in effect when the decision was made (provider-reported or estimated). Attached at
	 * every write site that had a measurement in scope: the guard cascade, an attempt cancel, a
	 * deferral, a settled attempt, the overflow report, and the safe-boundary failure. An attempt
	 * aborted before any usage was computed carries no usage.
	 */
	usageTokens?: number;
}

export interface CompactionVerdictEvidence {
	evidenceTrimmedTurns?: number;
	usageTokens?: number;
}

/**
 * Every reason Compact+ writes, mapped to the decision it describes. The summarization and
 * compatibility keys are the same constants the writers import, so renaming one breaks this
 * table at compile time; the generic reason strings are duplicated literals, pinned by
 * test/compaction-verdict-type.test.ts rather than by the compiler. A reason that reaches
 * Compact+ on exactly one path is mapped to the kind that path records, so a verdict read
 * back from telemetry classifies the same way as the live decision did.
 */
const REASON_KINDS: ReadonlyMap<string, CompactionVerdictKind> = new Map([
	["compaction aborted", "cancelled"],
	["compaction context changed", "cancelled"],
	["custom compaction cancelled", "cancelled"],
	["custom summarization unavailable", "deferred"],
	["safe turn-boundary compaction unavailable", "declined"],
	["compact returned undefined", "deferred"],
	["auth unavailable", "deferred"],
	["model unavailable", "deferred"],
	["compact error: provider request failed", "deferred"],
	[SUMMARIZATION_CONTEXT_OVERFLOW_REASON, "declined"],
	[SUMMARIZATION_OUTPUT_CAP_REASON, "cancelled"],
	[SUMMARIZATION_INTENT_EVIDENCE_REASON, "cancelled"],
	[SUMMARIZATION_EVIDENCE_TRIMMED_REASON, "trimmed"],
	[SUMMARIZATION_SUSPECT_ESTIMATE_REASON, "deferred"],
	[NATIVE_FALLBACK_REASON, "deferred"],
]);

type ReasonPrefixKind = readonly [string, CompactionVerdictKind];

/** Reasons that carry a variable detail suffix. */
const REASON_PREFIX_KINDS: ReadonlyArray<ReasonPrefixKind> = [
	["compaction summary invalid:", "deferred"],
];

/**
 * Map a reason to its kind when the reason is all that is known: a restored telemetry
 * reason, a status line, or a log line. A reason Compact+ reaches on exactly one path is
 * mapped to the kind that path records, so a verdict read back from telemetry classifies the
 * same way the live decision did. Two reasons reach Compact+ on more than one path:
 * `SUMMARIZATION_CONTEXT_OVERFLOW_REASON` (guard decline, cancelled attempt, or a deferral
 * that still reports the overflow) and `SUMMARIZATION_OUTPUT_CAP_REASON` (cancelled attempt, or
 * a deferral after the provider confirmed the failure). They are mapped to one of their live
 * kinds - the guard-decline kind and the cancelled-attempt kind - so a restored verdict can
 * differ from the kind the live decision recorded; the coordinator passes each path's own kind
 * explicitly at its write sites and both divergences are pinned by test. An unmapped non-null
 * reason is treated as `declined`: every reason Compact+ writes that is not a cancel, a trim, or
 * a deferral comes from a path that declined to run its own compaction, so a future cancel
 * reason added without a table entry would be misclassified here rather than crash. The raw
 * reason is always preserved on the verdict, so a mapping gap loses no information.
 *
 * A third class of divergence is not a mapping gap and cannot be fixed by the table: when
 * Compact+ defers and Pi then settles a compaction, the live session's newest verdict becomes
 * `accepted` (or `trimmed`) while the prose that deferral wrote still classifies as `deferred`
 * on restore. Only the newest decision is kept, and a restore cannot see the settlement that
 * followed it.
 */
export function compactionVerdictKindForReason(
	reason: string | null,
): CompactionVerdictKind {
	if (reason === null) return "accepted";
	const exact = REASON_KINDS.get(reason);
	if (exact) return exact;
	for (const [prefix, kind] of REASON_PREFIX_KINDS) {
		if (reason.startsWith(prefix)) return kind;
	}
	return "declined";
}

function withEvidence(
	kind: CompactionVerdictKind,
	evidence?: CompactionVerdictEvidence,
): Omit<CompactionVerdict, "kind" | "reason"> {
	if (!evidence) return {};
	return {
		// A trim count belongs to a trimmed verdict, so the constructor cannot build a verdict
		// its own guard would reject.
		...(evidence.evidenceTrimmedTurns === undefined || kind !== "trimmed"
			? {}
			: { evidenceTrimmedTurns: evidence.evidenceTrimmedTurns }),
		...(evidence.usageTokens === undefined
			? {}
			: { usageTokens: evidence.usageTokens }),
	};
}

export function compactionVerdict(
	kind: CompactionVerdictKind,
	reason: string | null,
	evidence?: CompactionVerdictEvidence,
): CompactionVerdict {
	return { kind, reason, ...withEvidence(kind, evidence) };
}

export function compactionVerdictFromReason(
	reason: string | null,
	evidence?: CompactionVerdictEvidence,
): CompactionVerdict {
	return compactionVerdict(
		compactionVerdictKindForReason(reason),
		reason,
		evidence,
	);
}

/** Runtime guard for a verdict that crossed a boundary (telemetry, persisted state). */
export function isCompactionVerdict(
	value: unknown,
): value is CompactionVerdict {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<CompactionVerdict>;
	const kind = candidate.kind as CompactionVerdictKind | undefined;
	if (kind === undefined || !COMPACTION_VERDICT_KINDS.includes(kind)) {
		return false;
	}
	// A decision may legitimately carry no prose: an accepted compaction that dropped nothing,
	// or a deferral whose runtime reported no compatibility reason.
	if (
		candidate.reason !== null &&
		(typeof candidate.reason !== "string" || candidate.reason === "")
	) {
		return false;
	}
	if (candidate.evidenceTrimmedTurns !== undefined) {
		const turns = candidate.evidenceTrimmedTurns;
		if (kind !== "trimmed") return false;
		if (
			typeof turns !== "number" ||
			!Number.isSafeInteger(turns) ||
			turns < 0
		) {
			return false;
		}
	}
	const usageTokens = candidate.usageTokens;
	if (
		usageTokens !== undefined &&
		(typeof usageTokens !== "number" ||
			!Number.isSafeInteger(usageTokens) ||
			usageTokens < 0)
	) {
		return false;
	}
	return true;
}
