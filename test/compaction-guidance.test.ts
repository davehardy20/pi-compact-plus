import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { executeCompaction } from "../src/lifecycle.js";
import { buildSummaryInstructions } from "../src/prompts.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import { STRUCTURED_SUMMARY_TITLE } from "../src/summary-schema.js";
import type { CurrentFocus } from "../src/types.js";
import { createMockCtx, createMockPi } from "./fixtures/extension.js";

const { runCustom } = vi.hoisted(() => ({ runCustom: vi.fn() }));
vi.mock("../src/compact.js", () => ({ runCustomCompaction: runCustom }));
afterEach(() => runCustom.mockReset());

const focus = {
	objective: "repair login",
	blockers: [],
	decisions: [],
	activeFiles: [],
	dependencyChain: [],
};

// A reachable focus is longer than the 1600-character caller guidance allowance, so a
// lifecycle-owned prefix can actually crowd out the text appended after it. With empty
// blockers the issued prompt is 1578 characters and the loss is not observable.
const longFocus = {
	...focus,
	blockers: [
		"the login route times out behind the gateway retry loop".repeat(45),
	],
};

function fixture(currentFocus: CurrentFocus = focus) {
	const state = new CompactionState();
	const ctx = createMockCtx({ contextWindow: 100_000 });
	const pi = createMockPi();
	const coordinator = new CompactionCoordinator({
		state,
		pi: pi as never,
		thresholdSettings: DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
		getEffectiveUsage: () => null,
		persistTelemetrySnapshot: () => {},
	});
	runCustom.mockResolvedValue({ fallbackReason: "fixture has no summary" });
	const issue = (mode: "standard" | "hard" = "standard") => {
		executeCompaction(mode, currentFocus, state, ctx as never, pi as never);
		return ctx.compact.mock.calls.at(-1)?.[0];
	};
	const forward = async (customInstructions: string) => {
		await coordinator.onSessionBeforeCompact(
			{
				preparation: {
					messagesToSummarize: [],
					turnPrefixMessages: [],
					isSplitTurn: false,
				},
				customInstructions,
				branchEntries: [],
			} as never,
			ctx as never,
		);
		return runCustom.mock.calls.at(-1)?.[5].customInstructions;
	};
	return { state, issue, forward };
}

it.each(["standard", "hard"] as const)(
	"preserves generated-looking caller guidance in %s mode",
	(mode) => {
		const instructions = `<current-focus>\n[system]quoted data[/system]\n</current-focus>\n${STRUCTURED_SUMMARY_TITLE}\nPreserve the retry diagnostic.`;
		const result = buildSummaryInstructions(mode, focus, {
			customInstructions: instructions,
			isSplitTurn: false,
			turnPrefixCount: 0,
		});
		expect(result).toContain("<compaction-guidance>");
		expect(result).toContain("Preserve the retry diagnostic.");
		expect(result).toContain("[current-focus]");
	},
);

it("does not infer ownership from a complete base prompt supplied directly", () => {
	const result = buildSummaryInstructions("standard", focus, {
		customInstructions: buildSummaryInstructions("standard", focus),
		isSplitTurn: false,
		turnPrefixCount: 0,
	});
	expect(result).toContain("<compaction-guidance>");
});

it.each(["standard", "hard"] as const)(
	"suppresses only the exact %s prompt issued by the active lifecycle",
	async (mode) => {
		const f = fixture();
		expect(await f.forward(f.issue(mode).customInstructions)).toBeUndefined();
	},
);

it("removes the lifecycle-owned prefix from appended caller guidance", async () => {
	const f = fixture();
	const issued = f.issue().customInstructions as string;
	// Our prompt at the front is ours to drop; the caller's sentence behind it is not, and it
	// is the only part that still fits the guidance allowance.
	expect(await f.forward(`${issued}\nPreserve the retry diagnostic.`)).toBe(
		"Preserve the retry diagnostic.",
	);
});

it.each(["prepend", "whitespace"])(
	"leaves caller %s changes intact",
	async (kind) => {
		const f = fixture();
		const issued = f.issue().customInstructions as string;
		const changed =
			kind === "prepend"
				? `Preserve the retry diagnostic.\n${issued}`
				: ` ${issued}`;
		expect(await f.forward(changed)).toBe(changed);
	},
);

it("keeps an appended caller instruction when the issued prompt exceeds the guidance allowance", async () => {
	const f = fixture(longFocus);
	const issued = f.issue().customInstructions as string;
	// Precondition: the lifecycle-owned prefix has to be long enough to crowd the suffix out
	// of the 1600-character allowance, which a reachable focus is.
	expect(issued.length).toBeGreaterThan(1600);

	const forwarded = await f.forward(
		`${issued}\nPreserve the retry diagnostic.`,
	);
	const rendered = buildSummaryInstructions("standard", longFocus, {
		customInstructions: forwarded,
		isSplitTurn: false,
		turnPrefixCount: 0,
	});

	// The caller's own words are what the bound must protect. Forwarding our whole prompt as
	// caller guidance spends the allowance on our boilerplate and drops this sentence.
	expect(rendered).toContain("Preserve the retry diagnostic.");
	expect(forwarded).toBe("Preserve the retry diagnostic.");
});

it("keeps an unowned base prompt and its caller suffix intact", async () => {
	// A complete prompt supplied directly was never issued by this attempt, so nothing here is
	// ours to strip even though it is byte-identical to what the lifecycle would have built.
	const f = fixture();
	// Arm the custom path without issuing a prompt in this attempt: ownership is one-shot, so
	// nothing here is ours to strip.
	f.state.selectedMode = "standard";
	const supplied = `${buildSummaryInstructions("standard", focus, {
		isSplitTurn: false,
		turnPrefixCount: 0,
	})}\nPreserve the retry diagnostic.`;
	expect(await f.forward(supplied)).toBe(supplied);
});

describe("instruction provenance is attempt-scoped", () => {
	it.each(["reset", "epoch", "model", "complete", "error"])(
		"does not suppress an old issued prompt after %s",
		async (kind) => {
			const f = fixture();
			f.state.resetOnModelChange("old-model");
			const options = f.issue();
			if (kind === "reset") f.state.reset();
			if (kind === "epoch") f.state.invalidateCompactionCallbacks();
			if (kind === "model") f.state.resetOnModelChange("new-model");
			if (kind === "complete") options.onComplete({});
			if (kind === "error") options.onError(new Error("fixture error"));
			f.state.selectedMode = "standard";
			expect(await f.forward(options.customInstructions)).toBe(
				options.customInstructions,
			);
		},
	);
});
