/**
 * Command helpers for Compact+ experimental tool-output pruning.
 *
 * Provides status formatting, manual flush, and toggle helpers
 * that can be wired into Pi commands or UI notifications.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FlushResult, flushPendingBatches } from "./lifecycle.js";
import { isToolOutputPruningEnabled } from "./policy.js";
import {
	PROTECTED_EXCLUDED_TOOLS,
	type ToolOutputBranchEntry,
} from "./record-identity.js";
import type { ToolOutputPruningState } from "./state.js";
import type { ToolOutputPruningSettings } from "./types.js";

export interface PruningStatusDetail {
	enabled: boolean;
	mode: string;
	strategy: string;
	summaryStrategy: string;
	activeRecordCount: number;
	pendingBatchCount: number;
	pendingRecordCount: number;
	isFlushing: boolean;
	lastPrunedCount: number;
	lastSummaryStatus: string | null;
	lastSummaryTime: number | null;
	lastReconstructionStatus: string | null;
	lastReconstructionTime: number | null;
	lastReconstructionError: string | null;
	lastReconstructionScannedEntries: number;
	lastReconstructionScannedBytes: number;
	lastReconstructionSkippedEntries: number;
	lastReconstructedCount: number;
	excludedTools: string[];
	protectedExcludedTools: string[];
	includedTools: string[];
	minChars: number;
	maxSummaryChars: number;
	maxQueryChars: number;
	summarizerModel: string;
	summarizerThinking: string;
}

export interface BuildStatusOptions {
	state: ToolOutputPruningState;
	settings: ToolOutputPruningSettings;
}

/**
 * Build a detailed pruning status snapshot from state and settings.
 */
export function buildPruningStatusDetail(
	opts: BuildStatusOptions,
): PruningStatusDetail {
	const { state, settings } = opts;
	const pending = state.pendingSnapshot();
	const status = state.statusSnapshot();
	return {
		enabled: isToolOutputPruningEnabled(settings),
		mode: settings.toolOutputPruningMode,
		strategy: settings.toolOutputPruneStrategy,
		summaryStrategy: settings.toolOutputSummaryStrategy,
		activeRecordCount: state.activeRecordCount,
		pendingBatchCount: pending.pendingBatches.length,
		pendingRecordCount: pending.pendingRecords.length,
		isFlushing: status.isFlushing,
		lastPrunedCount: status.lastPrunedCount,
		lastSummaryStatus: status.lastSummaryStatus,
		lastSummaryTime: status.lastSummaryTime,
		lastReconstructionStatus: status.lastReconstructionStatus,
		lastReconstructionTime: status.lastReconstructionTime,
		lastReconstructionError: status.lastReconstructionError,
		lastReconstructionScannedEntries: status.lastReconstructionScannedEntries,
		lastReconstructionScannedBytes: status.lastReconstructionScannedBytes,
		lastReconstructionSkippedEntries: status.lastReconstructionSkippedEntries,
		lastReconstructedCount: status.lastReconstructedCount,
		excludedTools: settings.toolOutputPruneExcludedTools,
		protectedExcludedTools: [...PROTECTED_EXCLUDED_TOOLS],
		includedTools: settings.toolOutputPruneIncludedTools,
		minChars: settings.toolOutputPruneMinChars,
		maxSummaryChars: settings.toolOutputSummaryMaxChars,
		maxQueryChars: settings.toolOutputQueryMaxChars,
		summarizerModel: settings.toolOutputSummarizerModel,
		summarizerThinking: settings.toolOutputSummarizerThinking,
	};
}

/**
 * Format a detailed pruning status into human-readable lines.
 */
export function formatPruningStatusLines(
	detail: PruningStatusDetail,
): string[] {
	const lines: string[] = [];
	lines.push("Tool-output pruning:");

	if (!detail.enabled) {
		lines.push(`  Status: off (experimental)`);
		lines.push(`  Mode: ${detail.mode}`);
		lines.push(
			`  To enable, set experimentalToolOutputPruning=true and mode=agent-message`,
		);
		lines.push(
			"  Settings are checked when pruning commands/events run; /reload is safest after edits.",
		);
		return lines;
	}

	lines.push(`  Status: on (experimental)`);
	lines.push(`  Mode: ${detail.mode}`);
	lines.push(`  Prune strategy: ${detail.strategy}`);
	lines.push(`  Summary strategy: ${detail.summaryStrategy}`);
	lines.push(`  Indexed records (current branch): ${detail.activeRecordCount}`);
	lines.push(`  Pending batches: ${detail.pendingBatchCount}`);
	lines.push(`  Pending records: ${detail.pendingRecordCount}`);
	lines.push(`  Flushing: ${detail.isFlushing ? "yes" : "no"}`);
	lines.push(`  Last pruned count: ${detail.lastPrunedCount}`);
	lines.push(
		`  Last summary: ${detail.lastSummaryStatus ?? "none"}${detail.lastSummaryTime ? ` (${Math.round((Date.now() - detail.lastSummaryTime) / 1000)}s ago)` : ""}`,
	);
	if (detail.lastReconstructionStatus) {
		lines.push(
			`  Last metadata reconstruction: ${detail.lastReconstructionStatus}${detail.lastReconstructionTime ? ` (${Math.round((Date.now() - detail.lastReconstructionTime) / 1000)}s ago)` : ""}`,
		);
		lines.push(
			`  Reconstructed records: ${detail.lastReconstructedCount}; scanned ${detail.lastReconstructionScannedEntries} entr${detail.lastReconstructionScannedEntries === 1 ? "y" : "ies"} / ${detail.lastReconstructionScannedBytes} bytes; skipped legacy entries: ${detail.lastReconstructionSkippedEntries}`,
		);
		if (detail.lastReconstructionError) {
			lines.push(`  Reconstruction note: ${detail.lastReconstructionError}`);
		}
	}
	lines.push(`  Min chars to prune: ${detail.minChars}`);
	lines.push(`  Max summary chars: ${detail.maxSummaryChars}`);
	lines.push(`  Max query chars: ${detail.maxQueryChars}`);
	lines.push(`  Summarizer model: ${detail.summarizerModel}`);
	lines.push(`  Summarizer thinking: ${detail.summarizerThinking}`);
	lines.push(
		"  Settings source: checked when pruning commands/events run; /reload is safest after edits.",
	);
	lines.push(
		`  Protected exclusions (non-overridable): ${detail.protectedExcludedTools.join(", ")}`,
	);
	if (detail.excludedTools.length > 0) {
		lines.push(`  User excluded tools: ${detail.excludedTools.join(", ")}`);
	}
	if (detail.includedTools.length > 0) {
		lines.push(`  Included tools: ${detail.includedTools.join(", ")}`);
	}

	return lines;
}

export interface ManualFlushDependencies {
	state: ToolOutputPruningState;
	settings: ToolOutputPruningSettings;
	ctx: ExtensionContext;
	branchEntries: ToolOutputBranchEntry[];
	pi: { appendEntry: (customType: string, data?: unknown) => void };
}

/**
 * Manually flush pending tool-output batches.
 *
 * Returns a result object suitable for displaying in UI or logs.
 */
export async function manualFlushPendingBatches(
	deps: ManualFlushDependencies,
): Promise<FlushResult & { message: string }> {
	const { state, settings, ctx, branchEntries, pi } = deps;

	if (!isToolOutputPruningEnabled(settings)) {
		return {
			ok: false,
			indexedCount: 0,
			prunedCount: 0,
			error: "not enabled",
			message: "Tool-output pruning is not enabled.",
		};
	}

	const status = state.statusSnapshot();
	if (!state.hasPending()) {
		return {
			ok: true,
			indexedCount: 0,
			prunedCount: 0,
			message: "No pending tool-output batches to flush.",
		};
	}

	if (status.isFlushing) {
		return {
			ok: false,
			indexedCount: 0,
			prunedCount: 0,
			error: "already flushing",
			message: "A flush is already in progress.",
		};
	}

	const result = await flushPendingBatches(
		state,
		settings,
		ctx,
		branchEntries,
		pi,
	);

	if (result.ok) {
		const msg =
			result.indexedCount > 0
				? `Flushed ${result.indexedCount} tool-output record(s).`
				: "Flush completed; no records were indexed.";
		return { ...result, message: msg };
	}

	return {
		...result,
		message: `Flush failed: ${result.error ?? "unknown error"}`,
	};
}

/**
 * Build a concise one-line status for use in compact command output.
 */
export function buildPruningOneLineStatus(
	state: ToolOutputPruningState,
	settings: ToolOutputPruningSettings,
): string {
	if (!isToolOutputPruningEnabled(settings)) {
		return "off";
	}
	const pending = state.pendingSnapshot();
	const status = state.statusSnapshot();
	const parts: string[] = [
		`indexed=${state.activeRecordCount}`,
		`pending=${pending.pendingRecords.length}`,
	];
	if (status.isFlushing) parts.push("flushing");
	if (status.lastSummaryStatus) parts.push(`last=${status.lastSummaryStatus}`);
	if (status.lastReconstructionStatus) {
		parts.push(`reconstruct=${status.lastReconstructionStatus}`);
	}
	return parts.join(" ");
}
