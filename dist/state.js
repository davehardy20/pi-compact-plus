/**
 * Encapsulates all mutable state for Compact+.
 * Replaces scattered module-level `let` variables with a single instance.
 */
export class CompactionState {
    selectedMode = null;
    lastCompactTime = 0;
    isCompacting = false;
    lastTriggerAuto = false;
    lastCompactTokens = 0;
    lastModelKey = null;
    lastCompactTurnIndex = -1;
    lastCompaction = null;
    lastFallbackReason = null;
    lastInjectedEcho = null;
    echoInjected = false;
    /** Reset all state to initial values. */
    reset() {
        this.selectedMode = null;
        this.lastCompactTime = 0;
        this.isCompacting = false;
        this.lastTriggerAuto = false;
        this.lastCompactTokens = 0;
        this.lastModelKey = null;
        this.lastCompactTurnIndex = -1;
        this.lastCompaction = null;
        this.lastFallbackReason = null;
        this.lastInjectedEcho = null;
        this.echoInjected = false;
    }
    /**
     * Reset state when the model changes.
     * @returns true if the model key changed (state was reset).
     */
    resetOnModelChange(key) {
        if (key !== this.lastModelKey) {
            this.lastModelKey = key;
            this.lastCompactTime = 0;
            this.selectedMode = null;
            this.lastTriggerAuto = false;
            this.lastCompactTokens = 0;
            this.lastCompactTurnIndex = -1;
            this.lastCompaction = null;
            this.lastFallbackReason = null;
            this.lastFallbackReason = null;
            this.lastInjectedEcho = null;
            this.echoInjected = false;
            return true;
        }
        return false;
    }
    // ── Guard helpers ────────────────────────────────────────────────
    /** Check if we're still in the cooldown window since last compaction. */
    isOnCooldown(cooldownMs) {
        return Date.now() - this.lastCompactTime < cooldownMs;
    }
    /** Check if token usage hasn't grown enough since last compaction. */
    isRegrowthBelowThreshold(currentTokens, regrowthTokens) {
        return (this.lastCompactTokens > 0 &&
            currentTokens - this.lastCompactTokens < regrowthTokens);
    }
    /** Check if the given turn index matches the last compaction turn. */
    isSameTurn(turnIndex) {
        return turnIndex !== undefined && turnIndex === this.lastCompactTurnIndex;
    }
}
