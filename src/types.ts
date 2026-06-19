import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionExecutionPath } from "./compatibility.js";
import {
	type CompactPlusThresholdSettings,
	DEFAULT_CHECKPOINT_THRESHOLD_PERCENT,
	DEFAULT_CHECKPOINT_THRESHOLD_TOKENS,
	DEFAULT_COOLDOWN_MS,
	DEFAULT_HARD_THRESHOLD_PERCENT,
	DEFAULT_HARD_THRESHOLD_TOKENS,
	DEFAULT_STANDARD_THRESHOLD_PERCENT,
	DEFAULT_STANDARD_THRESHOLD_TOKENS,
	DEFAULT_THRESHOLD_MODE,
} from "./settings.js";

export type { CompactPlusThresholdMode } from "./settings.js";

export type CompactionMode = "standard" | "hard" | "checkpoint";

export type UsageSource = "native" | "estimated" | "unknown";

export type TriggerSource = "message_end" | "turn_end" | "command";

export interface EffectiveUsage {
	percent: number | null;
	tokens: number | null;
	contextWindow: number;
	source: UsageSource;
}

export type TelemetryPersistenceIssueCode =
	| "corrupt-json"
	| "invalid-schema"
	| "permission-failed"
	| "read-failed"
	| "symlink-detected"
	| "unsupported-version"
	| "write-failed";

export interface TelemetryPersistenceIssue {
	operation: "load" | "save";
	code: TelemetryPersistenceIssueCode;
	path: string;
	message: string;
	timestamp: number;
	quarantinePath?: string;
}

export interface CompactPlusStatus {
	usagePercent: number | null;
	usageTokens: number | null;
	contextWindow: number | null;
	usageSource: UsageSource;
	band: string;
	effectiveBand: CompactionMode | null;
	selectedMode: CompactionMode | null;
	isCompacting: boolean;
	cooldownActive: boolean;
	cooldownRemainingMs: number;
	lastCompaction: CompactionTelemetry | null;
	lastFallbackReason: string | null;
	lastInjectedEcho: string | null;
	telemetryPersistenceIssues: TelemetryPersistenceIssue[];
	thresholdSettings?: CompactPlusThresholdSettings;
}

export interface CurrentFocus {
	objective: string;
	blockers: string[];
	decisions: string[];
	activeFiles: string[];
	dependencyChain: string[];
}

export interface ClassifiedMessages {
	critical: AgentMessage[];
	contextual: AgentMessage[];
	ephemeral: AgentMessage[];
}

export interface SessionSnapshot extends CurrentFocus {
	completedWork: string[];
	openProblems: string[];
	currentErrors: string[];
	constraints: string[];
	failedAttempts: string[];
	nextStep: string;
}

export interface CheckpointData extends SessionSnapshot {
	schemaVersion: number;
	timestamp: number;
	maturity: "draft" | "validated" | "core";
	note?: string;
}

export interface SummaryInstructionOptions {
	previousSummary?: string;
	isSplitTurn: boolean;
	turnPrefixCount: number;
}

export interface CompactionTelemetry {
	mode: "standard" | "hard";
	triggerSource: TriggerSource;
	triggerReason: string;
	timestamp: number;
	focusTags: string[];
	previousSummaryPresent: boolean;
	splitTurn: boolean;
	usageSource: UsageSource;
	fallbackReason?: string;
	messagesSummarizedCount: number;
	classifiedCounts?: {
		critical: number;
		contextual: number;
		ephemeral: number;
	};
	usagePercentAtTrigger?: number;
	usageTokensAtTrigger?: number;
	executionPath: CompactionExecutionPath;
	fromExtension: boolean;
	thinkingLevel?: string | null;
	compatibilityReason?: string | null;
}

// Threshold/cooldown values are now DEFAULTS re-exported from the settings
// defaults surface (see src/settings.ts). These are the frozen baseline
// values only; runtime-resolved values (env/settings-file overrides) must be
// obtained from resolveCompactPlusSettings(). The legacy names are preserved
// here as re-exports so existing callers keep compiling while later plan
// steps migrate policy/compaction/tests to the explicit settings seam.
export const THRESHOLD_MODE = DEFAULT_THRESHOLD_MODE;
export const CHECKPOINT_CANDIDATE_PERCENT =
	DEFAULT_CHECKPOINT_THRESHOLD_PERCENT;
export const STANDARD_THRESHOLD_PERCENT = DEFAULT_STANDARD_THRESHOLD_PERCENT;
export const HARD_THRESHOLD_PERCENT = DEFAULT_HARD_THRESHOLD_PERCENT;
export const CHECKPOINT_CANDIDATE_TOKENS = DEFAULT_CHECKPOINT_THRESHOLD_TOKENS;
export const STANDARD_THRESHOLD_TOKENS = DEFAULT_STANDARD_THRESHOLD_TOKENS;
export const HARD_THRESHOLD_TOKENS = DEFAULT_HARD_THRESHOLD_TOKENS;
export const COOLDOWN_MS = DEFAULT_COOLDOWN_MS;
export const CONTINUATION_PROMPT = "Continue with the current task.";
export const CHECKPOINT_CUSTOM_TYPE = "compact-plus-checkpoint";
export const REGROWTH_TOKENS = 1000;
export const CHECKPOINT_NOTE_MAX_LENGTH = 500;
export const CHECKPOINT_SCHEMA_VERSION = 2;

// Tool-output pruning custom type.
// V1 appends a compact summary/observability entry only. Runtime index and
// stats remain in extension state; do not advertise unused append-only entry
// types until persistence is implemented and tested.
export const TOOL_PRUNE_SUMMARY_CUSTOM_TYPE = "compact-plus-tool-prune-summary";
export const QUERY_TOOL_OUTPUT_TOOL_NAME = "compact_plus_query_tool_output";
