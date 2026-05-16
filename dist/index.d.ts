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
import { classifyMessages, extractCurrentFocus, extractDependencyChain } from "./focus.js";
import { buildCheckpointData, getModeFromUsage, getUsageBandText, modelKey } from "./policy.js";
import { buildBranchInstructions, buildCurrentFocusBlock, buildSummaryInstructions } from "./prompts.js";
import { type CompactionTelemetry, type EffectiveUsage, type SummaryInstructionOptions } from "./types.js";
export { classifyMessages, type EffectiveUsage, extractCurrentFocus, type SummaryInstructionOptions, };
export default function compactPlusExtension(pi: ExtensionAPI): void;
export declare const __test__: {
    resetState: () => void;
    getSelectedMode: () => import("./types.js").CompactionMode | null;
    getLastCompactTime: () => number;
    getIsCompacting: () => boolean;
    getLastTriggerAuto: () => boolean;
    getLastCompactTokens: () => number;
    getLastModelKey: () => string | null;
    getLastCompaction: () => CompactionTelemetry | null;
    getLastFallbackReason: () => string | null;
    CHECKPOINT_CANDIDATE_PERCENT: number;
    STANDARD_THRESHOLD_PERCENT: number;
    HARD_THRESHOLD_PERCENT: number;
    COOLDOWN_MS: number;
    REGROWTH_TOKENS: number;
    CONTINUATION_PROMPT: string;
    CHECKPOINT_CUSTOM_TYPE: string;
    getModeFromUsage: typeof getModeFromUsage;
    getUsageBandText: typeof getUsageBandText;
    modelKey: typeof modelKey;
    extractDependencyChain: typeof extractDependencyChain;
    buildCurrentFocusBlock: typeof buildCurrentFocusBlock;
    buildSummaryInstructions: typeof buildSummaryInstructions;
    buildBranchInstructions: typeof buildBranchInstructions;
    buildCheckpointData: typeof buildCheckpointData;
};
