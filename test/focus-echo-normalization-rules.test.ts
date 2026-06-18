import { describe, expect, it } from "vitest";

import * as normalizationRules from "../src/focus-echo/rules/index.js";
import {
	normalizeActiveFiles,
	normalizeBlockers,
	normalizeDecisions,
	normalizeDependencyChain,
	normalizeNextStep,
	normalizeObjective,
} from "../src/focus-echo/rules/index.js";

describe("focus echo normalization rules", () => {
	it("keeps raw rule taxonomy private behind semantic helpers", () => {
		expect(Object.keys(normalizationRules).sort()).toEqual([
			"normalizeActiveFiles",
			"normalizeBlockers",
			"normalizeDecisions",
			"normalizeDependencyChain",
			"normalizeNextStep",
			"normalizeObjective",
		]);
	});

	it("exposes semantic helpers for field-level normalization", () => {
		expect(
			normalizeObjective(
				"Use the latest live /compact-plus status output as the source of truth to further refining persisted focus echo normalization so /compact-plus status renders cleaner objective, blockers, dependency chain, and next step text after compaction.",
			),
		).toBe(
			"Refine persisted focus echo normalization for /compact-plus status",
		);
		expect(
			normalizeBlockers(
				[
					"- Latest pasted live /compact+ status shows a noisy/stale persisted last focus echo with objective leaks; blockers leak stale/literal text: raw pasted summary",
					"- No known blocker",
				],
				[
					"- Objective: Fix seeds issue pi-compact-plus-1234 in /Users/dave/tools/pi-compact-plus by updating src/focus-echo/normalizer.ts",
				],
			),
		).toEqual([
			"Live /compact-plus status shows noisy persisted echo content",
			"Blockers retains stale/literal text",
			"Objective still includes issue boilerplate/path noise",
		]);
		expect(
			normalizeActiveFiles([
				"- files read that still matter",
				"- /Users/dave/tools/pi-compact-plus/README.md",
				"- files modified",
				"- package.json",
				"- /Users/dave/tools/pi-compact-plus/src/focus-echo/normalizer.ts",
				"- likely next files to inspect/edit",
				"- ./test/focus-echo-normalization-rules.test.ts",
				"- notes without a file reference",
			]),
		).toEqual([
			"src/focus-echo/normalizer.ts",
			"test/focus-echo-normalization-rules.test.ts",
		]);
		expect(
			normalizeDecisions([
				"- **Keep the normalizer seam**: callers continue through normalizeFocusEchoDraft.",
				"- Continue testing through the public FocusEchoDraft seam.",
				"- **Keep the normalizer seam**: duplicate should be removed.",
				"- No further decision.",
			]),
		).toEqual([
			"Keep the normalizer seam",
			"Continue testing through the public FocusEchoDraft seam.",
		]);
		expect(
			normalizeDependencyChain([
				"- release checklist",
				"-> docs",
				"- buildPersistedFocusEcho(summaryText) / parseFocusEcho() in src/reorder.ts normalize summary fields",
				"-> remaining status validation",
			]),
		).toEqual([
			// dependency-005 was pruned in plan pl-874d step 4 (src/reorder.ts deleted in
			// slice 0; the rule rewrote to a dead-path output). With the rule gone, this
			// reorder.ts-referencing input passes through unchanged (see behavior_invariant).
			"buildPersistedFocusEcho(summaryText) / parseFocusEcho() in src/reorder.ts normalize summary fields",
			"status validation",
		]);
		expect(
			normalizeNextStep(
				"Inspecting src/reorder.ts and refining normalization after the newest echo-normalization edits.",
			),
		).toBe("Refine normalization after the newest echo-normalization edits.");
	});
});
