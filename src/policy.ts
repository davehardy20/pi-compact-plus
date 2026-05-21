import {
	CHECKPOINT_CANDIDATE_PERCENT,
	CHECKPOINT_NOTE_MAX_LENGTH,
	CHECKPOINT_SCHEMA_VERSION,
	type CheckpointData,
	COOLDOWN_MS,
	type CompactionMode,
	type CompactionTelemetry,
	type CompactPlusStatus,
	type EffectiveUsage,
	HARD_THRESHOLD_PERCENT,
	type SessionSnapshot,
	STANDARD_THRESHOLD_PERCENT,
} from "./types.js";

export function getModeFromUsage(
	percent: number | null,
): CompactionMode | null {
	if (percent === null) return null;
	if (percent >= HARD_THRESHOLD_PERCENT) return "hard";
	if (percent >= STANDARD_THRESHOLD_PERCENT) return "standard";
	if (percent >= CHECKPOINT_CANDIDATE_PERCENT) return "checkpoint";
	return null;
}

export function getUsageBandText(percent: number | null): string {
	if (percent === null) return "unknown";
	if (percent >= HARD_THRESHOLD_PERCENT) {
		return `hard (>= ${HARD_THRESHOLD_PERCENT}%)`;
	}
	if (percent >= STANDARD_THRESHOLD_PERCENT) {
		return `standard (${formatRange(STANDARD_THRESHOLD_PERCENT, HARD_THRESHOLD_PERCENT - 1)})`;
	}
	if (percent >= CHECKPOINT_CANDIDATE_PERCENT) {
		return `checkpoint candidate (${formatRange(CHECKPOINT_CANDIDATE_PERCENT, STANDARD_THRESHOLD_PERCENT - 1)})`;
	}
	return `normal (< ${CHECKPOINT_CANDIDATE_PERCENT}%)`;
}

function formatRange(start: number, end: number): string {
	return end >= start ? `${start}-${end}%` : `>= ${start}%`;
}

export function modelKey(
	model: { provider: string; id: string } | undefined,
): string | null {
	if (!model) return null;
	return `${model.provider}/${model.id}`;
}

export function buildCheckpointData(
	note: string | undefined,
	snapshot: SessionSnapshot,
): CheckpointData {
	return {
		...snapshot,
		schemaVersion: CHECKPOINT_SCHEMA_VERSION,
		timestamp: Date.now(),
		maturity: "validated",
		note: note?.trim().slice(0, CHECKPOINT_NOTE_MAX_LENGTH) || undefined,
	};
}

export function formatCheckpointSummary(data: CheckpointData): string {
	const parts: string[] = [];
	if (data.note) parts.push(`note: "${data.note}"`);
	parts.push(`${data.activeFiles.length} files`);
	if (data.completedWork.length > 0)
		parts.push(`${data.completedWork.length} completed`);
	if (data.openProblems.length > 0)
		parts.push(`${data.openProblems.length} open problems`);
	if (data.currentErrors.length > 0)
		parts.push(`${data.currentErrors.length} errors`);
	if (data.blockers.length > 0) parts.push(`${data.blockers.length} blockers`);
	if (data.nextStep) parts.push(`next: ${data.nextStep.slice(0, 80)}`);
	return `📌 Checkpoint saved (v${data.schemaVersion}) — ${parts.join(", ")}`;
}

export function getCooldownRemainingMs(
	now: number,
	lastCompactTime: number,
): number {
	const elapsed = now - lastCompactTime;
	const remaining = COOLDOWN_MS - elapsed;
	return remaining > 0 ? remaining : 0;
}

export function buildStatusSnapshot(args: {
	usage: EffectiveUsage | null;
	selectedMode: CompactionMode | null;
	isCompacting: boolean;
	lastCompactTime: number;
	lastCompaction: CompactionTelemetry | null;
	lastFallbackReason: string | null;
	lastInjectedEcho: string | null;
}): CompactPlusStatus {
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

export function formatStatusLines(status: CompactPlusStatus): string[] {
	const compactionFallback = status.lastCompaction?.fallbackReason ?? null;
	const topLevelFallback =
		status.lastFallbackReason &&
		status.lastFallbackReason !== compactionFallback
			? status.lastFallbackReason
			: null;
	const usagePercentText =
		status.usagePercent === null
			? "unknown"
			: `${status.usagePercent.toFixed(1)}%`;
	const usageTokensText =
		status.usageTokens === null
			? "unknown"
			: status.usageTokens.toLocaleString();
	const contextWindowText =
		status.contextWindow === null
			? "unknown"
			: status.contextWindow.toLocaleString();

	const lines = [
		"📦 Compact+ status",
		`  Usage: ${usagePercentText} (${usageTokensText} / ${contextWindowText} tokens)`,
		`  Source: ${status.usageSource}`,
		`  Band: ${status.band}`,
		`  Thresholds: checkpoint=${CHECKPOINT_CANDIDATE_PERCENT}% standard=${STANDARD_THRESHOLD_PERCENT}% hard=${HARD_THRESHOLD_PERCENT}% cooldown=${COOLDOWN_MS / 1000}s`,
		`  Selected mode: ${status.selectedMode ?? "none"}`,
		`  Cooldown: ${status.cooldownActive ? `${Math.ceil(status.cooldownRemainingMs / 1000)}s remaining` : "ready"}`,
		`  Compacting: ${status.isCompacting ? "in progress" : "idle"}`,
	];
	if (
		status.usageSource === "native" &&
		(status.usagePercent === null || status.usageTokens === null)
	) {
		lines.push(
			"  Usage detail: Pi reports usage as unknown until the next assistant response after compaction.",
		);
	}
	if (status.lastCompaction) {
		const lc = status.lastCompaction;
		const ago = Math.round((Date.now() - lc.timestamp) / 1000);
		lines.push(
			`  Last compaction: ${lc.mode} mode, ${lc.triggerSource} trigger, ${ago}s ago`,
		);
		if (lc.triggerReason) {
			lines.push(`    Reason: ${lc.triggerReason}`);
		}
		lines.push(
			`    Path: ${lc.executionPath}${lc.fromExtension ? " (Compact+)" : " (native Pi)"}`,
		);
		if (lc.thinkingLevel) {
			lines.push(`    Thinking level: ${lc.thinkingLevel}`);
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
		if (
			lc.compatibilityReason &&
			lc.compatibilityReason !== lc.fallbackReason
		) {
			lines.push(`    Compatibility: ${lc.compatibilityReason}`);
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
	} else if (compactionFallback || status.lastFallbackReason) {
		lines.push(
			"  Last focus echo: (none — last compaction fell back before a custom summary was injected)",
		);
	} else if (status.lastCompaction) {
		lines.push(
			"  Last focus echo: (none — no persisted focus echo is available for the last compaction)",
		);
	} else {
		lines.push(
			"  Last focus echo: (none — no compaction summary detected yet)",
		);
	}
	return lines;
}
