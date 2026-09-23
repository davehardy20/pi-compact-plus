import { describe, expect, it } from "vitest";
import { __test__ as compactTest } from "../src/compact.js";

const { normalizeStructuredSummary } = compactTest;

function activeFileSummary(lineCount = 15): string {
	return [
		"## Active File Set",
		...Array.from(
			{ length: lineCount },
			(_, index) => `line-${String(index + 1).padStart(2, "0")}`,
		),
	].join("\n");
}

describe("normalizeStructuredSummary rebuild characterization", () => {
	it("trims a summary that is already within the maximum", () => {
		expect(normalizeStructuredSummary("short  \r\n", 10, 5)).toBe("short");
	});

	it("normalizes and truncates an oversized summary without sections", () => {
		expect(normalizeStructuredSummary("alpha\r\nbeta\r\ngamma", 1, 3)).toBe(
			"alpha\nbeta\n…",
		);
	});

	it.each([
		{ targetTokens: 32.5, bodyLines: 14 },
		{ targetTokens: 24.5, bodyLines: 10 },
		{ targetTokens: 18.5, bodyLines: 7 },
		{ targetTokens: 12.5, bodyLines: 4 },
	])(
		"uses the first body-limit multiplier fitting $targetTokens tokens",
		({ targetTokens, bodyLines }) => {
			const summary = activeFileSummary();
			const expected = activeFileSummary(bodyLines);

			expect(normalizeStructuredSummary(summary, 1, targetTokens)).toBe(
				expected,
			);
		},
	);

	it("uses the final multiplier before boundary truncation", () => {
		expect(normalizeStructuredSummary(activeFileSummary(), 1, 10)).toBe(
			"## Active File Set\nline-01\nline-02\n…",
		);
	});

	it("keeps the minimum two body lines at small multipliers", () => {
		const summary = [
			"## Current Objective",
			"line-01",
			"line-02",
			"line-03",
			"line-04",
			"line-05",
		].join("\n");

		expect(normalizeStructuredSummary(summary, 1, 9)).toBe(
			"## Current Objective\nline-01\nline-02",
		);
	});

	it("does not spend optional section slots on blanks between real lines", () => {
		const lines = Array.from({ length: 14 }, (_, index) => `file-${index}`);
		const summary = [
			"## Active File Set",
			...lines.flatMap((line) => [line, ""]),
		].join("\n");

		expect(normalizeStructuredSummary(summary, 1, 10_000)).toBe(
			["## Active File Set", ...lines].join("\n"),
		);
	});

	it("drops a pending blank but preserves the following critical line", () => {
		const summary = ["## Current Objective", "a", "b", "c", "", "d"].join("\n");

		expect(normalizeStructuredSummary(summary, 1, 100)).toBe(
			"## Current Objective\na\nb\nc\nd",
		);
	});

	it("preserves section order while normalizing lines and blanks", () => {
		const longLine = "x".repeat(260);
		const summary = [
			"ignored preamble",
			"## Unknown Section   ",
			"",
			"alpha   ",
			"",
			"",
			longLine,
			"omega",
			"",
			"## Current Objective   ",
			"",
			"objective-1",
			"",
			"objective-2",
			"",
		].join("\r\n");
		const expected = [
			"## Unknown Section",
			"alpha",
			"",
			`${"x".repeat(239)}…`,
			"omega",
			"",
			"## Current Objective",
			"objective-1",
			"",
			"objective-2",
		].join("\n");

		expect(normalizeStructuredSummary(summary, 1, 10_000)).toBe(expected);
	});
});
