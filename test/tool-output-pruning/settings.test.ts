import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACT_PLUS_SETTINGS,
	parseEnvBool,
	parseEnvStringArray,
	resolveCompactPlusSettings,
} from "../../src/settings.js";

describe("tool-output pruning settings", () => {
	it("is disabled by default", () => {
		const settings = resolveCompactPlusSettings({}, {});
		expect(settings.experimentalToolOutputPruning).toBe(false);
		expect(settings.toolOutputPruningMode).toBe("off");
		expect(settings.toolOutputSummaryStrategy).toBe("llm");
		expect(settings.toolOutputPruneStrategy).toBe("stub");
	});

	it("can be enabled via env", () => {
		const settings = resolveCompactPlusSettings(
			{
				COMPACT_PLUS_EXPERIMENTAL_TOOL_OUTPUT_PRUNING: "true",
				COMPACT_PLUS_TOOL_OUTPUT_PRUNING_MODE: "agent-message",
				COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_STRATEGY: "llm",
				COMPACT_PLUS_TOOL_OUTPUT_PRUNE_STRATEGY: "stub",
			},
			{},
		);
		expect(settings.experimentalToolOutputPruning).toBe(true);
		expect(settings.toolOutputPruningMode).toBe("agent-message");
		expect(settings.toolOutputSummaryStrategy).toBe("llm");
		expect(settings.toolOutputPruneStrategy).toBe("stub");
	});

	it("can be enabled via file settings", () => {
		const settings = resolveCompactPlusSettings(
			{},
			{
				experimentalToolOutputPruning: true,
				toolOutputPruningMode: "agent-message",
				toolOutputSummaryStrategy: "llm",
				toolOutputPruneStrategy: "stub",
			},
		);
		expect(settings.experimentalToolOutputPruning).toBe(true);
		expect(settings.toolOutputPruningMode).toBe("agent-message");
		expect(settings.toolOutputSummaryStrategy).toBe("llm");
		expect(settings.toolOutputPruneStrategy).toBe("stub");
	});

	it("env overrides file settings", () => {
		const settings = resolveCompactPlusSettings(
			{
				COMPACT_PLUS_EXPERIMENTAL_TOOL_OUTPUT_PRUNING: "false",
				COMPACT_PLUS_TOOL_OUTPUT_PRUNING_MODE: "off",
			},
			{
				experimentalToolOutputPruning: true,
				toolOutputPruningMode: "agent-message",
			},
		);
		expect(settings.experimentalToolOutputPruning).toBe(false);
		expect(settings.toolOutputPruningMode).toBe("off");
	});

	it("falls back safely for invalid env values", () => {
		const settings = resolveCompactPlusSettings(
			{
				COMPACT_PLUS_EXPERIMENTAL_TOOL_OUTPUT_PRUNING: "maybe",
				COMPACT_PLUS_TOOL_OUTPUT_PRUNING_MODE: "every-turn",
				COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_STRATEGY: "deterministic",
				COMPACT_PLUS_TOOL_OUTPUT_PRUNE_STRATEGY: "truncate",
				COMPACT_PLUS_TOOL_OUTPUT_PRUNE_MIN_CHARS: "abc",
				COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_MAX_CHARS: "-10",
				COMPACT_PLUS_TOOL_OUTPUT_QUERY_MAX_CHARS: "0",
			},
			{},
		);
		expect(settings.experimentalToolOutputPruning).toBe(false);
		expect(settings.toolOutputPruningMode).toBe("off");
		expect(settings.toolOutputSummaryStrategy).toBe("llm");
		expect(settings.toolOutputPruneStrategy).toBe("stub");
		expect(settings.toolOutputPruneMinChars).toBe(
			DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputPruneMinChars,
		);
		expect(settings.toolOutputSummaryMaxChars).toBe(
			DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputSummaryMaxChars,
		);
		expect(settings.toolOutputQueryMaxChars).toBe(
			DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputQueryMaxChars,
		);
	});

	it("falls back safely for invalid file values", () => {
		const settings = resolveCompactPlusSettings(
			{},
			{
				experimentalToolOutputPruning: "yes" as unknown as boolean,
				toolOutputPruningMode: 123 as unknown as string,
				toolOutputSummaryStrategy: null as unknown as string,
				toolOutputPruneStrategy: undefined,
				toolOutputPruneMinChars: null,
				toolOutputSummaryMaxChars: "abc",
				toolOutputQueryMaxChars: [],
			},
		);
		expect(settings.experimentalToolOutputPruning).toBe(false);
		expect(settings.toolOutputPruningMode).toBe("off");
		expect(settings.toolOutputSummaryStrategy).toBe("llm");
		expect(settings.toolOutputPruneStrategy).toBe("stub");
		expect(settings.toolOutputPruneMinChars).toBe(
			DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputPruneMinChars,
		);
		expect(settings.toolOutputSummaryMaxChars).toBe(
			DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputSummaryMaxChars,
		);
		expect(settings.toolOutputQueryMaxChars).toBe(
			DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputQueryMaxChars,
		);
	});

	it("delete mode is parsed but does not affect default stub selection", () => {
		const settings = resolveCompactPlusSettings(
			{
				COMPACT_PLUS_TOOL_OUTPUT_PRUNE_STRATEGY: "delete",
			},
			{},
		);
		expect(settings.toolOutputPruneStrategy).toBe("delete");
	});

	it("default excluded tools include read, read_hashed, hashline_edit, and query tool", () => {
		const settings = resolveCompactPlusSettings({}, {});
		expect(settings.toolOutputPruneExcludedTools).toContain("read");
		expect(settings.toolOutputPruneExcludedTools).toContain("read_hashed");
		expect(settings.toolOutputPruneExcludedTools).toContain("hashline_edit");
		expect(settings.toolOutputPruneExcludedTools).toContain(
			"compact_plus_query_tool_output",
		);
	});

	it("env comma list sets excluded tools", () => {
		const settings = resolveCompactPlusSettings(
			{
				COMPACT_PLUS_TOOL_OUTPUT_PRUNE_EXCLUDED_TOOLS: "bash,read,edit",
			},
			{},
		);
		expect(settings.toolOutputPruneExcludedTools).toEqual([
			"bash",
			"read",
			"edit",
		]);
	});

	it("env comma list sets included tools", () => {
		const settings = resolveCompactPlusSettings(
			{
				COMPACT_PLUS_TOOL_OUTPUT_PRUNE_INCLUDED_TOOLS: "bash,web_search",
			},
			{},
		);
		expect(settings.toolOutputPruneIncludedTools).toEqual([
			"bash",
			"web_search",
		]);
	});

	it("clamps min char settings to safe ranges", () => {
		const settings = resolveCompactPlusSettings(
			{
				COMPACT_PLUS_TOOL_OUTPUT_PRUNE_MIN_CHARS: "10",
				COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_MAX_CHARS: "50",
				COMPACT_PLUS_TOOL_OUTPUT_QUERY_MAX_CHARS: "50",
			},
			{},
		);
		expect(settings.toolOutputPruneMinChars).toBe(100);
		expect(settings.toolOutputSummaryMaxChars).toBe(100);
		expect(settings.toolOutputQueryMaxChars).toBe(100);
	});

	it("clamps max char settings to safe ranges", () => {
		const settings = resolveCompactPlusSettings(
			{
				COMPACT_PLUS_TOOL_OUTPUT_PRUNE_MIN_CHARS: "100000",
				COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_MAX_CHARS: "50000",
				COMPACT_PLUS_TOOL_OUTPUT_QUERY_MAX_CHARS: "500000",
			},
			{},
		);
		expect(settings.toolOutputPruneMinChars).toBe(50000);
		expect(settings.toolOutputSummaryMaxChars).toBe(10000);
		expect(settings.toolOutputQueryMaxChars).toBe(100000);
	});

	it("parses env bool variants", () => {
		expect(parseEnvBool("true", false)).toBe(true);
		expect(parseEnvBool("1", false)).toBe(true);
		expect(parseEnvBool("yes", false)).toBe(true);
		expect(parseEnvBool("TRUE", false)).toBe(true);
		expect(parseEnvBool("false", true)).toBe(false);
		expect(parseEnvBool("0", true)).toBe(false);
		expect(parseEnvBool("no", true)).toBe(false);
		expect(parseEnvBool("NO", true)).toBe(false);
		expect(parseEnvBool(undefined, true)).toBe(true);
		expect(parseEnvBool("maybe", false)).toBe(false);
	});

	it("parses env string array", () => {
		expect(parseEnvStringArray("a,b,c", [])).toEqual(["a", "b", "c"]);
		expect(parseEnvStringArray(" a , b ", [])).toEqual(["a", "b"]);
		expect(parseEnvStringArray(undefined, ["default"])).toEqual(["default"]);
		expect(parseEnvStringArray("", ["default"])).toEqual(["default"]);
	});
});
