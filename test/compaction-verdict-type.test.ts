import { describe, expect, it } from "vitest";

import {
	COMPACTION_VERDICT_KINDS,
	compactionVerdict,
	compactionVerdictFromReason,
	compactionVerdictKindForReason,
	isCompactionVerdict,
} from "../src/compaction-verdict.js";
import {
	NATIVE_FALLBACK_REASON,
	REGISTRY_STREAM_REASON,
} from "../src/compatibility.js";
import {
	SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
	SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
	SUMMARIZATION_INTENT_EVIDENCE_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
	SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
} from "../src/summarization-overflow.js";

describe("compaction verdict kinds", () => {
	it("is the closed set of outcomes Compact+ can produce", () => {
		expect(COMPACTION_VERDICT_KINDS).toEqual([
			"accepted",
			"trimmed",
			"deferred",
			"declined",
			"cancelled",
		]);
	});
});

describe("reason to kind mapping", () => {
	it("classifies every reason Compact+ writes", () => {
		const expected: Array<[string, string]> = [
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
		];
		for (const [reason, kind] of expected) {
			expect(compactionVerdictKindForReason(reason), reason).toBe(kind);
		}
	});

	it("classifies the variable-suffix summary validation reasons", () => {
		const invalid = "compaction summary invalid: summary is empty";
		expect(compactionVerdictKindForReason(invalid)).toBe("deferred");
	});

	it("treats no reason as an accepted compaction", () => {
		expect(compactionVerdictKindForReason(null)).toBe("accepted");
	});

	it("treats an unmapped reason as a decline and keeps the prose", () => {
		const verdict = compactionVerdictFromReason("some future refusal");
		expect(verdict.kind).toBe("declined");
		expect(verdict.reason).toBe("some future refusal");
	});

	it("keeps compatibility prose out of the decision kinds it does not describe", () => {
		// The registry route is a routing note recorded as compatibilityReason, never as
		// a decision, so it reaches the mapper only through the documented default.
		expect(REGISTRY_STREAM_REASON).not.toBe(NATIVE_FALLBACK_REASON);
		expect(compactionVerdictKindForReason(REGISTRY_STREAM_REASON)).toBe(
			"declined",
		);
		expect(compactionVerdictKindForReason(NATIVE_FALLBACK_REASON)).toBe(
			"deferred",
		);
	});

	// The property that a reason maps to the kind its writer records is proven against the
	// real writers in test/compaction-verdict-interface.test.ts, not against this mapper twice.
});

describe("verdict construction", () => {
	it("carries the trimmed turn count and the trimmed reason together", () => {
		const verdict = compactionVerdict(
			"trimmed",
			SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
			{ evidenceTrimmedTurns: 3, usageTokens: 900 },
		);
		expect(verdict).toEqual({
			kind: "trimmed",
			reason: SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
			evidenceTrimmedTurns: 3,
			usageTokens: 900,
		});
	});

	it("omits evidence keys that were not measured", () => {
		const verdict = compactionVerdict("accepted", null, { usageTokens: 1200 });
		expect(verdict.kind).toBe("accepted");
		expect(verdict.reason).toBeNull();
		expect("evidenceTrimmedTurns" in verdict).toBe(false);
		expect(verdict.usageTokens).toBe(1200);
	});

	it("drops evidence the kind cannot carry, so it cannot build a rejected verdict", () => {
		const verdict = compactionVerdict("accepted", null, {
			evidenceTrimmedTurns: 2,
		});
		expect("evidenceTrimmedTurns" in verdict).toBe(false);
		expect(isCompactionVerdict(verdict)).toBe(true);
	});

	it("preserves the reason when built from a reason", () => {
		const verdict = compactionVerdictFromReason(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
			{ usageTokens: 4096 },
		);
		expect(verdict.kind).toBe("deferred");
		expect(verdict.reason).toBe(SUMMARIZATION_SUSPECT_ESTIMATE_REASON);
		expect(verdict.usageTokens).toBe(4096);
	});
});

describe("verdict guard", () => {
	it("accepts a well-formed verdict", () => {
		expect(
			isCompactionVerdict(
				compactionVerdict("trimmed", SUMMARIZATION_EVIDENCE_TRIMMED_REASON, {
					evidenceTrimmedTurns: 1,
				}),
			),
		).toBe(true);
		expect(isCompactionVerdict(compactionVerdict("accepted", null))).toBe(true);
	});

	it("rejects values that are not verdicts", () => {
		const rejected: unknown[] = [
			null,
			"declined",
			{ kind: "refused", reason: null },
			{ kind: "declined", reason: 7 },
			{ kind: "declined", reason: "" },
			// Only an accepted compaction may report that it dropped nothing.
			{ kind: "deferred", reason: null },
			{ kind: "trimmed", reason: null, evidenceTrimmedTurns: -1 },
			{ kind: "trimmed", reason: null, evidenceTrimmedTurns: 1.5 },
			// A trim count belongs to a trimmed verdict only.
			{ kind: "accepted", reason: null, evidenceTrimmedTurns: 2 },
			{ kind: "accepted", reason: null, usageTokens: -1 },
		];
		for (const value of rejected) {
			expect(isCompactionVerdict(value), JSON.stringify(value)).toBe(false);
		}
	});
});
