import { CHECKPOINT_CANDIDATE_PERCENT, CHECKPOINT_NOTE_MAX_LENGTH, CHECKPOINT_SCHEMA_VERSION, COOLDOWN_MS, HARD_THRESHOLD_PERCENT, STANDARD_THRESHOLD_PERCENT, } from "./types.js";
export function getModeFromUsage(percent) {
    if (percent === null)
        return null;
    if (percent >= HARD_THRESHOLD_PERCENT)
        return "hard";
    if (percent >= STANDARD_THRESHOLD_PERCENT)
        return "standard";
    if (percent >= CHECKPOINT_CANDIDATE_PERCENT)
        return "checkpoint";
    return null;
}
export function getUsageBandText(percent) {
    if (percent === null)
        return "unknown";
    if (percent >= HARD_THRESHOLD_PERCENT)
        return "hard (>= 90%)";
    if (percent >= STANDARD_THRESHOLD_PERCENT)
        return "standard (80-89%)";
    if (percent >= CHECKPOINT_CANDIDATE_PERCENT) {
        return "checkpoint candidate (75-79%)";
    }
    return "normal (< 75%)";
}
export function modelKey(model) {
    if (!model)
        return null;
    return `${model.provider}/${model.id}`;
}
export function buildCheckpointData(note, snapshot) {
    return {
        ...snapshot,
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        timestamp: Date.now(),
        maturity: "validated",
        note: note?.trim().slice(0, CHECKPOINT_NOTE_MAX_LENGTH) || undefined,
    };
}
export function formatCheckpointSummary(data) {
    const parts = [];
    if (data.note)
        parts.push(`note: "${data.note}"`);
    parts.push(`${data.activeFiles.length} files`);
    if (data.completedWork.length > 0)
        parts.push(`${data.completedWork.length} completed`);
    if (data.openProblems.length > 0)
        parts.push(`${data.openProblems.length} open problems`);
    if (data.currentErrors.length > 0)
        parts.push(`${data.currentErrors.length} errors`);
    if (data.blockers.length > 0)
        parts.push(`${data.blockers.length} blockers`);
    if (data.nextStep)
        parts.push(`next: ${data.nextStep.slice(0, 80)}`);
    return `📌 Checkpoint saved (v${data.schemaVersion}) — ${parts.join(", ")}`;
}
export function getCooldownRemainingMs(now, lastCompactTime) {
    const elapsed = now - lastCompactTime;
    const remaining = COOLDOWN_MS - elapsed;
    return remaining > 0 ? remaining : 0;
}
export function buildStatusSnapshot(args) {
    const now = Date.now();
    const cooldownRemainingMs = getCooldownRemainingMs(now, args.lastCompactTime);
    return {
        usagePercent: args.usage?.percent ?? null,
        usageTokens: args.usage?.tokens ?? null,
        contextWindow: args.usage?.contextWindow ?? null,
        usageSource: args.usage?.source ?? "unknown",
        band: getUsageBandText(args.usage?.percent ?? null),
        selectedMode: args.selectedMode,
        isCompacting: args.isCompacting,
        cooldownActive: cooldownRemainingMs > 0,
        cooldownRemainingMs,
        lastCompaction: args.lastCompaction,
        lastFallbackReason: args.lastFallbackReason,
        lastInjectedEcho: args.lastInjectedEcho,
    };
}
export function formatStatusLines(status) {
    const compactionFallback = status.lastCompaction?.fallbackReason ?? null;
    const topLevelFallback = status.lastFallbackReason &&
        status.lastFallbackReason !== compactionFallback
        ? status.lastFallbackReason
        : null;
    const lines = [
        "📦 Compact+ status",
        `  Usage: ${status.usagePercent?.toFixed(1) ?? "unknown"}% (${status.usageTokens?.toLocaleString() ?? "unknown"} / ${status.contextWindow?.toLocaleString() ?? "unknown"} tokens)`,
        `  Source: ${status.usageSource}`,
        `  Band: ${status.band}`,
        `  Thresholds: standard=${STANDARD_THRESHOLD_PERCENT}% hard=${HARD_THRESHOLD_PERCENT}% cooldown=${COOLDOWN_MS / 1000}s`,
        `  Selected mode: ${status.selectedMode ?? "none"}`,
        `  Cooldown: ${status.cooldownActive ? `${Math.ceil(status.cooldownRemainingMs / 1000)}s remaining` : "ready"}`,
        `  Compacting: ${status.isCompacting ? "in progress" : "idle"}`,
    ];
    if (status.lastCompaction) {
        const lc = status.lastCompaction;
        const ago = Math.round((Date.now() - lc.timestamp) / 1000);
        lines.push(`  Last compaction: ${lc.mode} mode, ${lc.triggerSource} trigger, ${ago}s ago`);
        if (lc.triggerReason) {
            lines.push(`    Reason: ${lc.triggerReason}`);
        }
        if (lc.focusTags.length > 0) {
            lines.push(`    Focus files: ${lc.focusTags.join(", ")}`);
        }
        if (lc.previousSummaryPresent) {
            lines.push("    Prior summary: merged");
        }
        if (lc.splitTurn) {
            lines.push("    Split-turn: yes");
        }
        if (lc.fallbackReason) {
            lines.push(`    Fallback: ${lc.fallbackReason}`);
        }
    }
    if (topLevelFallback) {
        lines.push(`  Last fallback: ${topLevelFallback}`);
    }
    if (status.lastInjectedEcho) {
        lines.push("  Last focus echo:");
        for (const echoLine of status.lastInjectedEcho.split("\n")) {
            lines.push(`    ${echoLine}`);
        }
    }
    else if (compactionFallback || status.lastFallbackReason) {
        lines.push("  Last focus echo: (none — last compaction fell back before a custom summary was injected)");
    }
    else if (status.lastCompaction) {
        lines.push("  Last focus echo: (none — no persisted focus echo is available for the last compaction)");
    }
    else {
        lines.push("  Last focus echo: (none — no compaction summary detected yet)");
    }
    return lines;
}
