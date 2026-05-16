import type { AgentMessage } from "@earendil-works/pi-agent-core";
export type CompactionMode = "standard" | "hard" | "checkpoint";
export type UsageSource = "native" | "estimated" | "unknown";
export type TriggerSource = "message_end" | "turn_end" | "command";
export interface EffectiveUsage {
    percent: number;
    tokens: number;
    contextWindow: number;
    source: UsageSource;
}
export interface CompactPlusStatus {
    usagePercent: number | null;
    usageTokens: number | null;
    contextWindow: number | null;
    usageSource: UsageSource;
    band: string;
    selectedMode: CompactionMode | null;
    isCompacting: boolean;
    cooldownActive: boolean;
    cooldownRemainingMs: number;
    lastCompaction: CompactionTelemetry | null;
    lastFallbackReason: string | null;
    lastInjectedEcho: string | null;
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
}
export declare function parseEnvInt(envVar: string | undefined, defaultValue: number): number;
export declare const CHECKPOINT_CANDIDATE_PERCENT = 75;
export declare const STANDARD_THRESHOLD_PERCENT: number;
export declare const HARD_THRESHOLD_PERCENT: number;
export declare const COOLDOWN_MS: number;
export declare const CONTINUATION_PROMPT = "Continue with the current task.";
export declare const CHECKPOINT_CUSTOM_TYPE = "compact-plus-checkpoint";
export declare const REGROWTH_TOKENS = 1000;
export declare const CHECKPOINT_NOTE_MAX_LENGTH = 500;
export declare const CHECKPOINT_SCHEMA_VERSION = 2;
