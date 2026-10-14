import { describe, expect, it } from "vitest";
import {
	classifySummarizationFailure,
	SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
	summarizationFailureReason,
} from "../src/summarization-overflow.js";
import {
	PI_OUTPUT_CAP_FAILURE,
	STRATA_CONTEXT_OVERFLOW,
	STRATA_CONTEXT_OVERFLOW_SMALL_WINDOW,
	TRANSIENT_FAILURES,
} from "./fixtures/summarization-errors.js";

describe("classifySummarizationFailure", () => {
	it.each([
		["Error", new Error(STRATA_CONTEXT_OVERFLOW)],
		["string", STRATA_CONTEXT_OVERFLOW],
	])("classifies the Strata context rejection from a %s", (_label, error) => {
		expect(classifySummarizationFailure(error)).toBe("context-overflow");
	});

	it("classifies the same rejection shape at a smaller context window", () => {
		expect(
			classifySummarizationFailure(
				new Error(STRATA_CONTEXT_OVERFLOW_SMALL_WINDOW),
			),
		).toBe("context-overflow");
	});

	it("classifies a clamped-output summarisation failure as an output cap", () => {
		expect(classifySummarizationFailure(new Error(PI_OUTPUT_CAP_FAILURE))).toBe(
			"output-cap",
		);
	});

	it.each(TRANSIENT_FAILURES)(
		"does not classify %j as a context overflow",
		(message) => {
			expect(classifySummarizationFailure(new Error(message))).toBe(
				"provider-error",
			);
		},
	);

	it("fails closed to provider-error for unusable thrown values", () => {
		for (const value of [undefined, null, 42, {}, [], new Error("")]) {
			expect(classifySummarizationFailure(value)).toBe("provider-error");
		}
	});

	it("maps each class to a stable reason that never carries provider text", () => {
		expect(summarizationFailureReason("context-overflow")).toBe(
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
		);
		expect(summarizationFailureReason("output-cap")).toBe(
			SUMMARIZATION_OUTPUT_CAP_REASON,
		);
		expect(summarizationFailureReason("provider-error")).toBeNull();

		for (const reason of [
			SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
			SUMMARIZATION_OUTPUT_CAP_REASON,
		]) {
			expect(reason).not.toMatch(/\d/);
			expect(reason).not.toContain("sentinel-secret");
			expect(reason).not.toContain("fit_max_tokens");
		}
	});
});
