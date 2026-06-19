/**
 * Compact+ — Advanced context compaction for Pi.
 *
 * Features:
 *   - Mode-aware compaction triggers (checkpoint candidate, standard, hard)
 *   - Structured summaries with current-focus extraction
 *   - Content classification and lightweight checkpoints
 *   - Position-aware focus echo for "lost in the middle" mitigation
 *
 * Commands:
 *   /compact-plus          — manual standard compaction
 *   /compact-plus hard     — manual hard compaction
 *   /compact-plus status   — show usage, mode, cooldown state
 *   /checkpoint [note]     — persist a checkpoint without compacting
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { classifyMessages } from "./classify.js";
import { registerCompactPlusCommands } from "./commands.js";
import { CompactionCoordinator } from "./compaction-coordinator.js";
import { registerCompactPlusEventHandlers } from "./events.js";
import { createPackageMetadataResolver } from "./package-metadata.js";
import { saveTelemetryWithDiagnostics } from "./persist.js";
import { extractCurrentFocus } from "./session-evidence.js";
import { resolveCompactPlusSettings } from "./settings.js";
import { CompactionState } from "./state.js";
import { ToolOutputPruningCoordinator } from "./tool-output-pruning/coordinator.js";
import { createQueryToolDefinition } from "./tool-output-pruning/query-tool.js";
import type { EffectiveUsage, SummaryInstructionOptions } from "./types.js";
import { getEffectiveUsage } from "./usage.js";

export {
	classifyMessages,
	type EffectiveUsage,
	extractCurrentFocus,
	type SummaryInstructionOptions,
};

const getPackageMetadata = createPackageMetadataResolver(import.meta.url);
const state = new CompactionState();
const toolOutputPruning = new ToolOutputPruningCoordinator({
	state: state.toolOutputPruning,
	getSettings: resolveCompactPlusSettings,
});

async function persistTelemetrySnapshot(): Promise<void> {
	const result = await saveTelemetryWithDiagnostics({
		lastCompaction: state.lastCompaction,
		lastFallbackReason: state.lastFallbackReason,
		lastInjectedEcho: state.lastInjectedEcho,
		lastCompactTime: state.lastCompactTime,
		lastCompactTokens: state.lastCompactTokens,
		lastModelKey: state.lastModelKey,
	});
	state.recordTelemetryPersistenceIssue(result.issue);
}

export default function compactPlusExtension(pi: ExtensionAPI) {
	const thresholdSettings = resolveCompactPlusSettings();
	const compactionCoordinator = new CompactionCoordinator({
		state,
		pi,
		thresholdSettings,
		getEffectiveUsage,
		persistTelemetrySnapshot,
	});

	pi.registerTool(
		createQueryToolDefinition({
			getState: () => state.toolOutputPruning,
			getSettings: () => resolveCompactPlusSettings(),
		}),
	);

	registerCompactPlusCommands(pi, {
		state,
		toolOutputPruning,
		compactionCoordinator,
		thresholdSettings,
		getEffectiveUsage,
		getMetadata: getPackageMetadata,
	});

	registerCompactPlusEventHandlers(pi, {
		state,
		toolOutputPruning,
		compactionCoordinator,
		persistTelemetrySnapshot,
	});
}

export const __test__ = {
	resetState: () => state.reset(),
	getSelectedMode: () => state.selectedMode,
	getLastCompactTime: () => state.lastCompactTime,
	getIsCompacting: () => state.isCompacting,
	getLastTriggerAuto: () => state.lastTriggerAuto,
	getLastCompactTokens: () => state.lastCompactTokens,
	getLastModelKey: () => state.lastModelKey,
	getLastCompaction: () => state.lastCompaction,
	getLastFallbackReason: () => state.lastFallbackReason,
	getLastInjectedEcho: () => state.lastInjectedEcho,
	getTelemetryPersistenceIssues: () => state.telemetryPersistenceIssues,
	getToolOutputPruningState: () => state.toolOutputPruning,
};
