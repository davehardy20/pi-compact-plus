import type { CompactionMode, CompactionTelemetry } from "./types.js";

/**
 * Encapsulates all mutable state for Compact+.
 * Replaces scattered module-level `let` variables with a single instance.
 */
export class CompactionState {
  selectedMode: CompactionMode | null = null;
  lastCompactTime = 0;
  isCompacting = false;
  lastTriggerAuto = false;
  lastCompactTokens = 0;
  lastModelKey: string | null = null;
  lastCompactTurnIndex = -1;
  lastCompaction: CompactionTelemetry | null = null;
  pendingCompaction: CompactionTelemetry | null = null;
  lastFallbackReason: string | null = null;
  lastInjectedEcho: string | null = null;
  echoInjected = false;

  /** Reset all state to initial values. */
  reset(): void {
    this.selectedMode = null;
    this.lastCompactTime = 0;
    this.isCompacting = false;
    this.lastTriggerAuto = false;
    this.lastCompactTokens = 0;
    this.lastModelKey = null;
    this.lastCompactTurnIndex = -1;
    this.lastCompaction = null;
    this.pendingCompaction = null;
    this.lastFallbackReason = null;
    this.lastInjectedEcho = null;
    this.echoInjected = false;
  }

  /**
   * Reset state when the model changes.
   * @returns true if the model key changed (state was reset).
   */
  resetOnModelChange(key: string): boolean {
    if (key !== this.lastModelKey) {
      this.lastModelKey = key;
      this.lastCompactTime = 0;
      this.selectedMode = null;
      this.lastTriggerAuto = false;
      this.lastCompactTokens = 0;
      this.lastCompactTurnIndex = -1;
      this.lastCompaction = null;
      this.pendingCompaction = null;
      this.lastFallbackReason = null;
      this.lastInjectedEcho = null;
      this.echoInjected = false;
      return true;
    }
    return false;
  }

  clearPendingCompaction(): void {
    this.pendingCompaction = null;
  }

  // ── Guard helpers ────────────────────────────────────────────────

  /** Check if we're still in the cooldown window since last compaction. */
  isOnCooldown(cooldownMs: number): boolean {
    return Date.now() - this.lastCompactTime < cooldownMs;
  }

  /** Check if token usage hasn't grown enough since last compaction. */
  isRegrowthBelowThreshold(
    currentTokens: number,
    regrowthTokens: number,
  ): boolean {
    return (
      this.lastCompactTokens > 0 &&
      currentTokens - this.lastCompactTokens < regrowthTokens
    );
  }

  /** Check if the given turn index matches the last compaction turn. */
  isSameTurn(turnIndex?: number): boolean {
    return turnIndex !== undefined && turnIndex === this.lastCompactTurnIndex;
  }
}
