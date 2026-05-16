import type { CompactionMode, CompactionTelemetry } from "./types.js";
/**
 * Encapsulates all mutable state for Compact+.
 * Replaces scattered module-level `let` variables with a single instance.
 */
export declare class CompactionState {
    selectedMode: CompactionMode | null;
    lastCompactTime: number;
    isCompacting: boolean;
    lastTriggerAuto: boolean;
    lastCompactTokens: number;
    lastModelKey: string | null;
    lastCompactTurnIndex: number;
    lastCompaction: CompactionTelemetry | null;
    lastFallbackReason: string | null;
    lastInjectedEcho: string | null;
    echoInjected: boolean;
    /** Reset all state to initial values. */
    reset(): void;
    /**
     * Reset state when the model changes.
     * @returns true if the model key changed (state was reset).
     */
    resetOnModelChange(key: string): boolean;
    /** Check if we're still in the cooldown window since last compaction. */
    isOnCooldown(cooldownMs: number): boolean;
    /** Check if token usage hasn't grown enough since last compaction. */
    isRegrowthBelowThreshold(currentTokens: number, regrowthTokens: number): boolean;
    /** Check if the given turn index matches the last compaction turn. */
    isSameTurn(turnIndex?: number): boolean;
}
