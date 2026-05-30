import { describe, expect, it } from "vitest";

import {
	ACTIVE_FILE_CANDIDATE_PATTERN,
	ACTIVE_FILE_GROUP_PRIORITY,
	BLOCKER_NORMALIZATION_RULES,
	DEPENDENCY_NORMALIZATION_RULES,
	NEXT_STEP_NORMALIZATION_RULES,
	OBJECTIVE_NORMALIZATION_RULES,
	OBJECTIVE_PRE_COLON_RULES,
	OBJECTIVE_SOURCE_OF_TRUTH_RULES,
} from "../src/focus-echo/normalization-rules.js";

const RULE_GROUPS = [
	BLOCKER_NORMALIZATION_RULES,
	DEPENDENCY_NORMALIZATION_RULES,
	NEXT_STEP_NORMALIZATION_RULES,
	OBJECTIVE_NORMALIZATION_RULES,
	OBJECTIVE_PRE_COLON_RULES,
	OBJECTIVE_SOURCE_OF_TRUTH_RULES,
];

describe("focus echo normalization rules", () => {
	it("keeps parser replacement rules named for reviewable golden-driven edits", () => {
		for (const group of RULE_GROUPS) {
			expect(group.length).toBeGreaterThan(0);
			const names = group.map((rule) => rule.name);
			expect(new Set(names).size).toBe(names.length);
			expect(names.every((name) => name.length > 0)).toBe(true);
		}
	});

	it("keeps active-file rules path-first and path-shaped", () => {
		expect(ACTIVE_FILE_GROUP_PRIORITY).toEqual([
			"files modified",
			"likely next files to inspect/edit",
			"files read that still matter",
			"default",
		]);
		expect(
			"src/focus-echo/parser.ts".match(ACTIVE_FILE_CANDIDATE_PATTERN)?.[1],
		).toBe("src/focus-echo/parser.ts");
	});
});
