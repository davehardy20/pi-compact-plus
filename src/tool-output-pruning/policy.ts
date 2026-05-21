import type { ToolOutputPruningSettings } from "./types.js";

/**
 * Determine whether tool-output pruning is effectively enabled.
 *
 * Requires:
 *   1. experimentalToolOutputPruning === true
 *   2. mode === "agent-message"
 *   3. summaryStrategy === "llm"
 *   4. pruneStrategy === "stub"
 */
export function isToolOutputPruningEnabled(
	settings: Pick<
		ToolOutputPruningSettings,
		| "experimentalToolOutputPruning"
		| "toolOutputPruningMode"
		| "toolOutputSummaryStrategy"
		| "toolOutputPruneStrategy"
	>,
): boolean {
	return (
		settings.experimentalToolOutputPruning === true &&
		settings.toolOutputPruningMode === "agent-message" &&
		settings.toolOutputSummaryStrategy === "llm" &&
		settings.toolOutputPruneStrategy === "stub"
	);
}

export interface ToolOutputPruningStatusLineArgs {
	enabled: boolean;
	mode: string;
	strategy: string;
	activeRecordCount: number;
	lastPrunedCount: number;
	lastSummaryStatus: string | null;
	lastSummaryTime: number | null;
}

export function formatToolOutputPruningStatusLine(
	args: ToolOutputPruningStatusLineArgs,
): string {
	if (!args.enabled) {
		return "  Tool-output pruning: off (experimental)";
	}
	const parts: string[] = [
		"on",
		`mode=${args.mode}`,
		`strategy=${args.strategy}`,
		`indexed=${args.activeRecordCount}`,
		`lastPruned=${args.lastPrunedCount}`,
	];
	if (args.lastSummaryStatus) {
		parts.push(`lastSummary=${args.lastSummaryStatus}`);
	}
	if (args.lastSummaryTime) {
		const ago = Math.round((Date.now() - args.lastSummaryTime) / 1000);
		parts.push(`lastSummaryAgo=${ago}s`);
	}
	return `  Tool-output pruning: ${parts.join(", ")}`;
}
