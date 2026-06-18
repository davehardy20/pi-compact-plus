import { describe, expect, it } from "vitest";

import type { FocusEchoDraft } from "../src/focus-echo/index.js";
import { normalizeFocusEchoDraft } from "../src/focus-echo/index.js";

function draft(overrides: Partial<FocusEchoDraft>): FocusEchoDraft {
	return {
		objective: "",
		activeFiles: [],
		blockers: [],
		errors: [],
		decisions: [],
		dependencyChain: [],
		nextStep: "",
		...overrides,
	};
}

describe("focus echo normalizer characterization", () => {
	it("documents field-level cleanup applied across a raw focus echo draft", () => {
		const normalized = normalizeFocusEchoDraft(
			draft({
				objective:
					"Use the latest live /compact-plus status output as the source of truth to further refining persisted focus echo normalization so /compact-plus status renders cleaner objective, blockers, dependency chain, and next step text after compaction.",
				activeFiles: [
					"- files read that still matter",
					"- /Users/dave/tools/pi-compact-plus/README.md",
					"- files modified",
					"- package.json",
					"- /Users/dave/tools/pi-compact-plus/src/focus-echo/normalizer.ts",
					"- likely next files to inspect/edit",
					"- ./test/focus-echo-normalization-rules.test.ts",
					"- notes without a file reference",
				],
				blockers: [
					"- Latest pasted live /compact+ status shows a noisy/stale persisted last focus echo with objective leaks; blockers leak stale/literal text: raw pasted summary",
					"- No known blocker",
				],
				errors: [
					"- Objective: Fix seeds issue pi-compact-plus-1234 in /Users/dave/tools/pi-compact-plus by updating src/focus-echo/normalizer.ts",
				],
				decisions: [
					"- **Keep the normalizer seam**: callers continue through normalizeFocusEchoDraft.",
					"- Continue testing through the public FocusEchoDraft seam.",
					"- **Keep the normalizer seam**: duplicate should be removed.",
					"- No further decision.",
				],
				dependencyChain: [
					"- release checklist",
					"-> docs",
					"- buildPersistedFocusEcho(summaryText) / parseFocusEcho() in src/reorder.ts normalize summary fields",
					"-> remaining status validation",
				],
				nextStep:
					"Inspecting src/reorder.ts and refining normalization after the newest echo-normalization edits.",
			}),
		);

		expect(normalized).toEqual({
			objective:
				"Refine persisted focus echo normalization for /compact-plus status",
			blockers: [
				"Live /compact-plus status shows noisy persisted echo content",
				"Blockers retains stale/literal text",
				"Objective still includes issue boilerplate/path noise",
			],
			activeFiles: [
				"src/focus-echo/normalizer.ts",
				"test/focus-echo-normalization-rules.test.ts",
			],
			decisions: [
				"Keep the normalizer seam",
				"Continue testing through the public FocusEchoDraft seam.",
			],
			dependencyChain: [
				// dependency-005 pruned in plan pl-874d step 4 (src/reorder.ts deleted in
				// slice 0; rule output named a dead path). Reorder.ts-referencing input now
				// passes through unchanged per the behavior_invariant.
				"buildPersistedFocusEcho(summaryText) / parseFocusEcho() in src/reorder.ts normalize summary fields",
				"status validation",
			],
			nextStep:
				"Refine normalization after the newest echo-normalization edits.",
		});
	});

	it("keeps current list caps, dedupe, filtering, and truncation behavior", () => {
		const longObjective = `Adding ${"normalized wording ".repeat(12)}`;
		const normalized = normalizeFocusEchoDraft(
			draft({
				objective: longObjective,
				activeFiles: [
					"- files modified",
					"- src/a.ts",
					"- src/a.ts",
					"- src/b.ts",
					"- src/c.ts",
					"- src/d.ts",
					"- src/e.ts",
				],
				blockers: [
					"- blockers leak stale/literal text: old summary",
					"- blockers leak stale/literal text: old summary",
					"- dependency chain and next step remain overly verbose/truncated",
					"- next step still includes literal command text: npm test",
					"- objective is verbose/truncated: old live text",
				],
				decisions: [
					"- First decision.",
					"- First decision.",
					"- Second decision.",
					"- Third decision.",
					"- Fourth decision.",
				],
				dependencyChain: [
					"- custom compaction summary in src/summary.ts",
					"-> global pi settings in /Users/dave/.pi/settings.json",
					"-> remaining status checks",
					"-> persisted last focus echo",
					"-> final verification",
				],
			}),
		);

		expect(normalized.objective).toHaveLength(120);
		expect(normalized.objective).toBe(
			"Add normalized wording normalized wording normalized wording normalized wording normalized wording normalized wording n…",
		);
		expect(normalized.activeFiles).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
		]);
		expect(normalized.blockers).toEqual([
			"Blockers retains stale/literal text",
			"Dependency chain and Next step need shortening",
			"Next step includes literal command text",
		]);
		expect(normalized.decisions).toEqual([
			"First decision.",
			"Second decision.",
			"Third decision.",
		]);
		expect(normalized.dependencyChain).toEqual([
			"src/summary.ts",
			".pi/settings.json",
			"status checks",
			"persisted focus echo",
		]);
	});
});
