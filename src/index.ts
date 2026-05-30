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
import { registerCompactPlusCommands } from "./commands.js";
import { CompactionCoordinator } from "./compaction-coordinator.js";
import { registerCompactPlusEventHandlers } from "./events.js";
import {
	classifyMessages,
	extractCurrentFocus,
	extractDependencyChain,
} from "./focus.js";
import { createPackageMetadataResolver } from "./package-metadata.js";
import { saveTelemetryWithDiagnostics } from "./persist.js";
import {
	buildCheckpointData,
	getModeFromUsage,
	getUsageBandText,
	modelKey,
} from "./policy.js";
import {
	buildBranchInstructions,
	buildCurrentFocusBlock,
	buildSummaryInstructions,
} from "./prompts.js";
import { hasAdversarialPatterns } from "./reorder.js";
import { resolveCompactPlusSettings } from "./settings.js";
import { CompactionState } from "./state.js";
import { ToolOutputPruningCoordinator } from "./tool-output-pruning/coordinator.js";
import { isToolOutputPruningEnabled } from "./tool-output-pruning/policy.js";
import { createQueryToolDefinition } from "./tool-output-pruning/query-tool.js";
import {
	CHECKPOINT_CANDIDATE_PERCENT,
	CHECKPOINT_CUSTOM_TYPE,
	CONTINUATION_PROMPT,
	COOLDOWN_MS,
	type EffectiveUsage,
	HARD_THRESHOLD_PERCENT,
	REGROWTH_TOKENS,
	STANDARD_THRESHOLD_PERCENT,
	type SummaryInstructionOptions,
} from "./types.js";
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
	const compactionCoordinator = new CompactionCoordinator({
		state,
		pi,
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
	CHECKPOINT_CANDIDATE_PERCENT,
	STANDARD_THRESHOLD_PERCENT,
	HARD_THRESHOLD_PERCENT,
	COOLDOWN_MS,
	REGROWTH_TOKENS,
	CONTINUATION_PROMPT,
	CHECKPOINT_CUSTOM_TYPE,
	getModeFromUsage,
	getUsageBandText,
	modelKey,
	extractDependencyChain,
	buildCurrentFocusBlock,
	buildSummaryInstructions,
	buildBranchInstructions,
	buildCheckpointData,
	hasAdversarialPatterns,
	isToolOutputPruningEnabled,
};
