/**
 * The typed verdict of one Compact+ compaction decision.
 *
 * Compact+ decides whether a compaction runs, runs with less of its own optional
 * evidence, or does not run at all. Until now that decision survived only as a
 * free-text `state.lastFallbackReason` string plus a UI notice, so a caller could
 * not ask "what just happened?" without matching prose.
 *
 * The verdict is the decision, not a log line. `kind` is the closed set of outcomes
 * Compact+ can produce, `reason` is the unchanged prose for that outcome, and the
 * optional evidence fields carry the numbers behind a budget decision.
 *
 * `reason` is never rewritten and never embeds provider text, so existing consumers
 * (status output, telemetry) can keep reading it verbatim while the verdict is being
 * introduced.
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
 *   produce a result. Pi may still compact natively.
 * - `cancelled`: Compact+ stopped an attempt it had already started: an abort, a
 *   superseded context, or an attempt that failed mid-flight.
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
	/** Model context window in effect when the decision was made. */
	contextWindow?: number;
	/** Provider-reported usage in effect when the decision was made. */
	usageTokens?: number;
}

export interface CompactionVerdictEvidence {
	evidenceTrimmedTurns?: number;
	contextWindow?: number;
	usageTokens?: number;
}

/**
 * Every reason Compact+ writes, mapped to the decision it describes. Keys are the
 * same constants the writers use, so a renamed reason breaks this table at compile
 * time instead of silently reclassifying a verdict. A reason that reaches Compact+
 * on exactly one path is mapped to the kind that path records, so a verdict read
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
	[SUMMARIZATION_OUTPUT_CAP_REASON, "declined"],
	[SUMMARIZATION_INTENT_EVIDENCE_REASON, "declined"],
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
 * reason, a status line, or a log line. Two reasons (the intent-evidence reason and the
 * request-overflow reasons) reach Compact+ on more than one path, and are mapped here to
 * the guard-path kind; the coordinator passes the path's own kind explicitly at those
 * write sites. An unmapped non-null reason is treated as `declined`: every reason
 * Compact+ writes that is not a cancel, a trim, or a deferral comes from a path that
 * declined to run its own compaction. The raw reason is always preserved on the verdict,
 * so a mapping gap loses no information.
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
	evidence?: CompactionVerdictEvidence,
): Omit<CompactionVerdict, "kind" | "reason"> {
	if (!evidence) return {};
	return {
		...(evidence.evidenceTrimmedTurns === undefined
			? {}
			: { evidenceTrimmedTurns: evidence.evidenceTrimmedTurns }),
		...(evidence.contextWindow === undefined
			? {}
			: { contextWindow: evidence.contextWindow }),
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
	return { kind, reason, ...withEvidence(evidence) };
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
	if (candidate.reason !== null) {
		if (typeof candidate.reason !== "string" || candidate.reason === "") {
			return false;
		}
	} else if (kind !== "accepted") {
		// Only an accepted compaction can have dropped nothing.
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
	for (const key of ["contextWindow", "usageTokens"] as const) {
		const field = candidate[key];
		if (field === undefined) continue;
		if (
			typeof field !== "number" ||
			!Number.isSafeInteger(field) ||
			field < 0
		) {
			return false;
		}
	}
	return true;
}
