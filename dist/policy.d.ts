import { type CheckpointData, type CompactionMode, type CompactionTelemetry, type CompactPlusStatus, type EffectiveUsage, type SessionSnapshot } from "./types.js";
export declare function getModeFromUsage(percent: number | null): CompactionMode | null;
export declare function getUsageBandText(percent: number | null): string;
export declare function modelKey(model: {
    provider: string;
    id: string;
} | undefined): string | null;
export declare function buildCheckpointData(note: string | undefined, snapshot: SessionSnapshot): CheckpointData;
export declare function formatCheckpointSummary(data: CheckpointData): string;
export declare function getCooldownRemainingMs(now: number, lastCompactTime: number): number;
export declare function buildStatusSnapshot(args: {
    usage: EffectiveUsage | null;
    selectedMode: CompactionMode | null;
    isCompacting: boolean;
    lastCompactTime: number;
    lastCompaction: CompactionTelemetry | null;
    lastFallbackReason: string | null;
    lastInjectedEcho: string | null;
}): CompactPlusStatus;
export declare function formatStatusLines(status: CompactPlusStatus): string[];
