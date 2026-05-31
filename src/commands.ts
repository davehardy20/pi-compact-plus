import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CompactionCoordinator } from "./compaction-coordinator.js";
import { registerCompactPlusStatusCommand } from "./extension-status.js";
import { extractSessionSnapshotFromBranch } from "./focus.js";
import type { PackageMetadataResolver } from "./package-metadata.js";
import {
	buildCheckpointData,
	buildStatusSnapshot,
	formatCheckpointSummary,
	formatStatusLines,
} from "./policy.js";
import { createCurrentSessionBranchView } from "./session-branch-view.js";
import { resolveCompactPlusSettings } from "./settings.js";
import type { CompactionState } from "./state.js";
import { formatPruningStatusLines } from "./tool-output-pruning/commands.js";
import type { ToolOutputPruningCoordinator } from "./tool-output-pruning/coordinator.js";
import {
	formatToolOutputPruningStatusLine,
	isToolOutputPruningEnabled,
} from "./tool-output-pruning/policy.js";
import { CHECKPOINT_CUSTOM_TYPE, type EffectiveUsage } from "./types.js";

export interface CompactPlusCommandRegistryOptions {
	state: CompactionState;
	toolOutputPruning: ToolOutputPruningCoordinator;
	compactionCoordinator: CompactionCoordinator;
	getEffectiveUsage: (ctx: ExtensionContext) => EffectiveUsage | null;
	getMetadata: PackageMetadataResolver;
}

export function formatToolOutputPruningStatusForState(
	state: CompactionState,
): string {
	const pruningSettings = resolveCompactPlusSettings();
	return formatToolOutputPruningStatusLine({
		enabled: isToolOutputPruningEnabled(pruningSettings),
		mode: pruningSettings.toolOutputPruningMode,
		strategy: pruningSettings.toolOutputPruneStrategy,
		activeRecordCount: state.toolOutputPruning.activeRecordCount,
		lastPrunedCount: state.toolOutputPruning.lastPrunedCount,
		lastSummaryStatus: state.toolOutputPruning.lastSummaryStatus,
		lastSummaryTime: state.toolOutputPruning.lastSummaryTime,
	});
}

export function registerCompactPlusCommands(
	pi: ExtensionAPI,
	{
		state,
		toolOutputPruning,
		compactionCoordinator,
		getEffectiveUsage,
		getMetadata,
	}: CompactPlusCommandRegistryOptions,
): void {
	pi.registerCommand("compact-plus", {
		description:
			"Compact+ context compaction. Usage: /compact-plus [hard|status|tool-prune status|tool-prune flush]",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			if (trimmed.startsWith("tool-prune ")) {
				const sub = trimmed.slice("tool-prune ".length).trim();

				if (sub === "status") {
					const detail = toolOutputPruning.buildStatusDetail();
					const lines = formatPruningStatusLines(detail);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if (sub === "flush") {
					const result = await toolOutputPruning.manualFlush(ctx, pi);
					ctx.ui.notify(result.message, result.ok ? "info" : "warning");
					return;
				}

				ctx.ui.notify(
					"Usage: /compact-plus tool-prune [status|flush]",
					"warning",
				);
				return;
			}

			if (trimmed === "status") {
				const usage = getEffectiveUsage(ctx);
				const status = buildStatusSnapshot({
					usage,
					selectedMode: state.selectedMode,
					isCompacting: state.isCompacting,
					lastCompactTime: state.lastCompactTime,
					lastCompaction: state.lastCompaction,
					lastFallbackReason: state.lastFallbackReason,
					lastInjectedEcho: state.lastInjectedEcho,
					telemetryPersistenceIssues: state.telemetryPersistenceIssues,
				});
				const lines = formatStatusLines(status);
				lines.push(formatToolOutputPruningStatusForState(state));
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const mode = trimmed === "hard" ? "hard" : "standard";
			await compactionCoordinator.handleManualCommand(mode, ctx);
		},
	});

	pi.registerCommand("checkpoint", {
		description: "Save a lightweight checkpoint. Usage: /checkpoint [note]",
		handler: async (args, ctx) => {
			const note = args.trim() || undefined;
			const branchView = createCurrentSessionBranchView(ctx);
			const snapshot = extractSessionSnapshotFromBranch(branchView);
			const data = buildCheckpointData(note, snapshot);
			pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, data);
			ctx.ui.notify(formatCheckpointSummary(data), "info");
		},
	});

	registerCompactPlusStatusCommand(pi, {
		getMetadata,
		getStatusState: () => ({
			isCompacting: state.isCompacting,
			selectedMode: state.selectedMode,
			lastCompactTime: state.lastCompactTime,
			echoInjected: state.echoInjected,
			lastModelKey: state.lastModelKey,
		}),
		getPruningLine: () => formatToolOutputPruningStatusForState(state),
	});
}
