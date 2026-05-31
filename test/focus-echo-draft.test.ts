import { describe, expect, it } from "vitest";

import {
	extractFocusEchoDraft,
	type FocusEchoDraft,
	normalizeFocusEchoDraft,
	parseFocusEcho,
} from "../src/reorder.js";
import { SOURCE_OF_TRUTH_STATUS_SUMMARY } from "./fixtures/focus-echo-goldens.js";

describe("FocusEchoDraft seam", () => {
	it("extracts raw summary-section data before focus-echo normalization", () => {
		const draft = extractFocusEchoDraft(SOURCE_OF_TRUTH_STATUS_SUMMARY);
		const typedDraft: FocusEchoDraft = draft;

		expect(typedDraft).toMatchObject({
			objective:
				"Use the latest live /compact-plus status output as the source of truth to further tighten persisted focus echo normalization in src/reorder.ts for the newest pasted live focus echo shape so /compact-plus status renders cleaner objective, blockers, dependency chain, and next step text.",
			activeFiles: [
				"- files read that still matter",
				"- package.json",
				"- README.md",
				"- files modified",
				"- package.json",
				"- src/reorder.ts",
				"- test/index.test.ts",
				"- likely next files to inspect/edit",
				"- src/policy.ts",
				"- docs/refactor-inventory.md",
			],
			blockers: [
				"- Latest pasted live /compact-plus status shows a noisy/stale persisted last focus echo around objective, blockers, dependency chain, and next step.",
				"- Need regression coverage in test/index.test.ts for the newest pasted live echo / post-compaction summary shape.",
			],
			errors: ["- No current errors."],
			decisions: [
				"- Use the latest successful custom-path Compact+ status echo as the source of truth.",
			],
			dependencyChain: [
				"- Custom compaction summary in src/index.ts -> buildPersistedFocusEcho(summaryText) / parseFocusEcho() in src/reorder.ts -> targeted test/index.test.ts coverage -> live /compact-plus status validation",
			],
			nextStep:
				"Add/update test/index.test.ts regression coverage for the newest pasted live focus echo / post-compaction summary shape, then run validation.",
		});
	});

	it("normalizes active files with path-bearing items preferred over root filenames", () => {
		const echo = normalizeFocusEchoDraft({
			objective: "Keep current focus concise.",
			activeFiles: [
				"- files read that still matter",
				"- package.json",
				"- README.md",
				"- files modified",
				"- /Users/dave/tools/pi-compact-plus/src/reorder.ts",
				"- /Users/dave/tools/pi-compact-plus/test/focus-echo-draft.test.ts",
				"- likely next files to inspect/edit",
				"- /Users/dave/tools/pi-compact-plus/src/index.ts",
			],
			blockers: [],
			errors: [],
			decisions: [],
			dependencyChain: [],
			nextStep: "",
		});

		expect(echo.activeFiles).toEqual([
			"src/reorder.ts",
			"test/focus-echo-draft.test.ts",
			"src/index.ts",
		]);
	});

	it("normalizes drafts into the approved small focus-echo output shape", () => {
		const echo = normalizeFocusEchoDraft({
			objective:
				"Use the latest live /compact-plus status output as the source of truth to further tighten persisted focus echo normalization in src/reorder.ts for the newest pasted live focus echo shape so /compact-plus status renders cleaner objective text.",
			activeFiles: [
				"- files modified",
				"- /Users/dave/tools/pi-compact-plus/src/focus-echo/parser.ts",
			],
			blockers: [
				"- Objective: issue pi-compact-plus-c960 remains noisy in src/reorder.ts.",
				"- No current blockers.",
			],
			errors: ["- No current errors."],
			decisions: [
				"- **Seam**: keep normalization behind normalizeFocusEchoDraft.",
			],
			dependencyChain: [
				"- Custom compaction summary in src/index.ts -> buildPersistedFocusEcho(summaryText) / parseFocusEcho() in src/reorder.ts normalize summary fields -> targeted test/index.test.ts coverage -> live /compact-plus status validation",
			],
			nextStep:
				"Add/update test/index.test.ts regression coverage for the newest pasted live focus echo / post-compaction summary shape, then run validation.",
		});

		expect(echo).toMatchObject({
			objective:
				"Tighten persisted focus echo normalization in src/reorder.ts for the newest pasted live focus echo shape so /compact-pl…",
			activeFiles: ["src/focus-echo/parser.ts"],
			blockers: ["Objective still includes issue boilerplate/path noise"],
			decisions: ["Seam"],
			dependencyChain: [
				"src/index.ts",
				"buildPersistedFocusEcho()/parseFocusEcho() in src/reorder.ts",
				"targeted test/index.test.ts coverage",
				"live /compact-plus status validation",
			],
			nextStep:
				"Add regression coverage in test/index.test.ts for the newest live echo shape.",
		});
	});

	it("keeps parseFocusEcho as the stable normalized caller interface", () => {
		const echo = parseFocusEcho(SOURCE_OF_TRUTH_STATUS_SUMMARY);

		expect(echo.objective).toBe(
			"Tighten persisted focus echo normalization in src/reorder.ts for the newest pasted live focus echo shape so /compact-pl…",
		);
		expect(echo.blockers).toEqual([
			"Latest pasted live /compact-plus status shows a noisy/stale persisted last focus echo around objective, blockers, depen…",
			"Add regression coverage for the newest live echo shape",
		]);
	});
});
