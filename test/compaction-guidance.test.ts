import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { executeCompaction } from "../src/lifecycle.js";
import { buildSummaryInstructions } from "../src/prompts.js";
import { DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS } from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import { STRUCTURED_SUMMARY_TITLE } from "../src/summary-schema.js";
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

function fixture() {
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
		executeCompaction(mode, focus, state, ctx as never, pi as never);
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

it.each(["append", "prepend", "whitespace"])(
	"preserves caller %s changes",
	async (kind) => {
		const f = fixture();
		const issued = f.issue().customInstructions as string;
		const changed =
			kind === "append"
				? `${issued}\nPreserve the retry diagnostic.`
				: kind === "prepend"
					? `Preserve the retry diagnostic.\n${issued}`
					: ` ${issued}`;
		expect(await f.forward(changed)).toBe(changed);
	},
);

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
