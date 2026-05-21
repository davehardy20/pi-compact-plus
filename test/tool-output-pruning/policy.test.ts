import { describe, expect, it } from "vitest";
import {
	formatToolOutputPruningStatusLine,
	isToolOutputPruningEnabled,
} from "../../src/tool-output-pruning/policy.js";

describe("isToolOutputPruningEnabled", () => {
	it("returns false when experimental flag is false", () => {
		expect(
			isToolOutputPruningEnabled({
				experimentalToolOutputPruning: false,
				toolOutputPruningMode: "agent-message",
				toolOutputSummaryStrategy: "llm",
				toolOutputPruneStrategy: "stub",
			}),
		).toBe(false);
	});

	it("returns false when mode is off", () => {
		expect(
			isToolOutputPruningEnabled({
				experimentalToolOutputPruning: true,
				toolOutputPruningMode: "off",
				toolOutputSummaryStrategy: "llm",
				toolOutputPruneStrategy: "stub",
			}),
		).toBe(false);
	});

	it("returns false when summary strategy is not llm", () => {
		expect(
			isToolOutputPruningEnabled({
				experimentalToolOutputPruning: true,
				toolOutputPruningMode: "agent-message",
				toolOutputSummaryStrategy: "deterministic" as "llm",
				toolOutputPruneStrategy: "stub",
			}),
		).toBe(false);
	});

	it("returns false when prune strategy is delete", () => {
		expect(
			isToolOutputPruningEnabled({
				experimentalToolOutputPruning: true,
				toolOutputPruningMode: "agent-message",
				toolOutputSummaryStrategy: "llm",
				toolOutputPruneStrategy: "delete",
			}),
		).toBe(false);
	});

	it("returns true when all conditions are met", () => {
		expect(
			isToolOutputPruningEnabled({
				experimentalToolOutputPruning: true,
				toolOutputPruningMode: "agent-message",
				toolOutputSummaryStrategy: "llm",
				toolOutputPruneStrategy: "stub",
			}),
		).toBe(true);
	});
});

describe("formatToolOutputPruningStatusLine", () => {
	it("formats off state", () => {
		const line = formatToolOutputPruningStatusLine({
			enabled: false,
			mode: "off",
			strategy: "stub",
			activeRecordCount: 0,
			lastPrunedCount: 0,
			lastSummaryStatus: null,
			lastSummaryTime: null,
		});
		expect(line).toBe("  Tool-output pruning: off (experimental)");
	});

	it("formats enabled state with basic info", () => {
		const line = formatToolOutputPruningStatusLine({
			enabled: true,
			mode: "agent-message",
			strategy: "stub",
			activeRecordCount: 3,
			lastPrunedCount: 2,
			lastSummaryStatus: "ok",
			lastSummaryTime: null,
		});
		expect(line).toContain("on");
		expect(line).toContain("mode=agent-message");
		expect(line).toContain("strategy=stub");
		expect(line).toContain("indexed=3");
		expect(line).toContain("lastPruned=2");
		expect(line).toContain("lastSummary=ok");
	});

	it("formats enabled state with summary time", () => {
		const now = Date.now();
		const line = formatToolOutputPruningStatusLine({
			enabled: true,
			mode: "agent-message",
			strategy: "stub",
			activeRecordCount: 5,
			lastPrunedCount: 4,
			lastSummaryStatus: "ok",
			lastSummaryTime: now - 5000,
		});
		expect(line).toContain("indexed=5");
		expect(line).toContain("lastSummary=ok");
		expect(line).toContain("lastSummaryAgo=");
	});
});
