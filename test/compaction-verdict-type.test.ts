import { describe, expect, it } from "vitest";

import {
	COMPACTION_VERDICT_KINDS,
	compactionVerdictFromReason,
	compactionVerdictKindForReason,
	completedCompactionVerdict,
	isCompactionVerdict,
	trimmedCompactionVerdict,
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
			"completed",
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
			["compact returned undefined", "declined"],
			["auth unavailable", "declined"],
			["model unavailable", "declined"],
			["compact error: provider request failed", "declined"],
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
		expect(compactionVerdictKindForReason(invalid)).toBe("declined");
	});

	it("treats no reason as a completed compaction", () => {
		expect(compactionVerdictKindForReason(null)).toBe("completed");
	});

	it("treats an unmapped reason as a decline and keeps the prose", () => {
		const verdict = compactionVerdictFromReason("some future refusal");
		expect(verdict.kind).toBe("declined");
		expect(verdict.reason).toBe("some future refusal");
	});

	it("keeps compatibility prose out of the decision kinds it does not describe", () => {
		// The registry route is a routing note recorded as compatibilityReason, never as a
		// decision, so it reaches the mapper only through the documented default.
		expect(REGISTRY_STREAM_REASON).not.toBe(NATIVE_FALLBACK_REASON);
		expect(compactionVerdictKindForReason(REGISTRY_STREAM_REASON)).toBe(
			"declined",
		);
		expect(compactionVerdictKindForReason(NATIVE_FALLBACK_REASON)).toBe(
			"deferred",
		);
	});
});

describe("verdict construction", () => {
	it("carries the trimmed turn count and the trimmed reason together", () => {
		const verdict = trimmedCompactionVerdict(3, {
			contextWindow: 1000,
			usageTokens: 900,
		});
		expect(verdict).toEqual({
			kind: "trimmed",
			reason: SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
			evidenceTrimmedTurns: 3,
			contextWindow: 1000,
			usageTokens: 900,
		});
	});

	it("omits evidence keys that were not measured", () => {
		const verdict = completedCompactionVerdict({ usageTokens: 1200 });
		expect(verdict.kind).toBe("completed");
		expect(verdict.reason).toBeNull();
		expect("contextWindow" in verdict).toBe(false);
		expect("evidenceTrimmedTurns" in verdict).toBe(false);
		expect(verdict.usageTokens).toBe(1200);
	});

	it("preserves the reason when built from a reason", () => {
		const verdict = compactionVerdictFromReason(
			SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
			{ contextWindow: 262144, usageTokens: 4096 },
		);
		expect(verdict.kind).toBe("deferred");
		expect(verdict.reason).toBe(SUMMARIZATION_SUSPECT_ESTIMATE_REASON);
		expect(verdict.contextWindow).toBe(262144);
		expect(verdict.usageTokens).toBe(4096);
	});
});

describe("verdict guard", () => {
	it("accepts a well-formed verdict", () => {
		expect(isCompactionVerdict(trimmedCompactionVerdict(1))).toBe(true);
		expect(isCompactionVerdict(completedCompactionVerdict())).toBe(true);
	});

	it("rejects values that are not verdicts", () => {
		const rejected: unknown[] = [
			null,
			"declined",
			{ kind: "refused", reason: null },
			{ kind: "declined", reason: 7 },
			{ kind: "trimmed", reason: null, evidenceTrimmedTurns: -1 },
			{ kind: "trimmed", reason: null, evidenceTrimmedTurns: 1.5 },
			{ kind: "declined", reason: "x", contextWindow: "1000" },
		];
		for (const value of rejected) {
			expect(isCompactionVerdict(value)).toBe(false);
		}
	});
});
