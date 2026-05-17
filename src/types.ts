import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionExecutionPath } from "./compatibility.js";

export type CompactionMode = "standard" | "hard" | "checkpoint";

export type UsageSource = "native" | "estimated" | "unknown";

export type TriggerSource = "message_end" | "turn_end" | "command";

export interface EffectiveUsage {
  percent: number | null;
  tokens: number | null;
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
  executionPath: CompactionExecutionPath;
  fromExtension: boolean;
  thinkingLevel?: string | null;
  compatibilityReason?: string | null;
}

export function parseEnvInt(
  envVar: string | undefined,
  defaultValue: number,
): number {
  if (envVar === undefined) return defaultValue;
  const parsed = parseInt(envVar, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export const CHECKPOINT_CANDIDATE_PERCENT = 75;
export const STANDARD_THRESHOLD_PERCENT = parseEnvInt(
  process.env.COMPACT_PLUS_STANDARD_THRESHOLD,
  80,
);
export const HARD_THRESHOLD_PERCENT = parseEnvInt(
  process.env.COMPACT_PLUS_HARD_THRESHOLD,
  90,
);
export const COOLDOWN_MS = parseEnvInt(
  process.env.COMPACT_PLUS_COOLDOWN_MS,
  120_000,
);
export const CONTINUATION_PROMPT = "Continue with the current task.";
export const CHECKPOINT_CUSTOM_TYPE = "compact-plus-checkpoint";
export const REGROWTH_TOKENS = 1000;
export const CHECKPOINT_NOTE_MAX_LENGTH = 500;
export const CHECKPOINT_SCHEMA_VERSION = 2;
