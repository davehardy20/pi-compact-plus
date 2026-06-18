import {
	CHECKPOINT_CANDIDATE_PERCENT,
	CHECKPOINT_CANDIDATE_TOKENS,
	CHECKPOINT_NOTE_MAX_LENGTH,
	CHECKPOINT_SCHEMA_VERSION,
	type CheckpointData,
	COOLDOWN_MS,
	type CompactionMode,
	type CompactionTelemetry,
	type CompactPlusStatus,
	type CompactPlusThresholdMode,
	type EffectiveUsage,
	HARD_THRESHOLD_PERCENT,
	HARD_THRESHOLD_TOKENS,
	type SessionSnapshot,
	STANDARD_THRESHOLD_PERCENT,
	STANDARD_THRESHOLD_TOKENS,
	type TelemetryPersistenceIssue,
	THRESHOLD_MODE,
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

export function getModeFromTokenUsage(
	tokens: number | null,
): CompactionMode | null {
	if (tokens === null) return null;
	if (tokens >= HARD_THRESHOLD_TOKENS) return "hard";
	if (tokens >= STANDARD_THRESHOLD_TOKENS) return "standard";
	if (tokens >= CHECKPOINT_CANDIDATE_TOKENS) return "checkpoint";
	return null;
}

function modeSeverity(mode: CompactionMode | null): number {
	switch (mode) {
		case "hard":
			return 3;
		case "standard":
			return 2;
		case "checkpoint":
			return 1;
		default:
			return 0;
	}
}

export function highestSeverityMode(
	a: CompactionMode | null,
	b: CompactionMode | null,
): CompactionMode | null {
	return modeSeverity(a) >= modeSeverity(b) ? a : b;
}

export function getModeFromEffectiveUsage(
	usage: EffectiveUsage,
	mode: CompactPlusThresholdMode = THRESHOLD_MODE,
): CompactionMode | null {
	const percentMode = getModeFromUsage(usage.percent);
	const tokenMode = getModeFromTokenUsage(usage.tokens);

	switch (mode) {
		case "percent":
			return percentMode;
		case "tokens":
			return tokenMode;
		case "effective_cap":
			return highestSeverityMode(percentMode, tokenMode);
	}
}

export function getUsageBandText(percent: number | null): string {
	return getThresholdBandText(
		percent,
		CHECKPOINT_CANDIDATE_PERCENT,
		STANDARD_THRESHOLD_PERCENT,
		HARD_THRESHOLD_PERCENT,
		(value) => value.toString(),
		"%",
	);
}

export function getTokenBandText(tokens: number | null): string {
	return getThresholdBandText(
		tokens,
		CHECKPOINT_CANDIDATE_TOKENS,
		STANDARD_THRESHOLD_TOKENS,
		HARD_THRESHOLD_TOKENS,
		(value) => value.toLocaleString(),
		" tokens",
	);
}

function getThresholdBandText(
	value: number | null,
	checkpoint: number,
	standard: number,
	hard: number,
	format: (value: number) => string,
	unit: string,
): string {
	if (value === null) return "unknown";
	if (value >= hard) return `hard (>= ${format(hard)}${unit})`;
	if (value >= standard) {
		return `standard (${formatRange(standard, hard - 1, format, unit)})`;
	}
	if (value >= checkpoint) {
		return `checkpoint candidate (${formatRange(checkpoint, standard - 1, format, unit)})`;
	}
	return `normal (< ${format(checkpoint)}${unit})`;
}

function formatRange(
	start: number,
	end: number,
	format: (value: number) => string = String,
	unit = "",
): string {
	return end >= start
		? `${format(start)}-${format(end)}${unit}`
		: `>= ${format(start)}${unit}`;
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
	telemetryPersistenceIssues?: TelemetryPersistenceIssue[];
}): CompactPlusStatus {
	const now = Date.now();
	const cooldownRemainingMs = getCooldownRemainingMs(now, args.lastCompactTime);
	const usage = args.usage;
	const effectiveBand =
		usage === null
			? null
			: getModeFromEffectiveUsage({
					percent: usage.percent,
					tokens: usage.tokens,
					contextWindow: usage.contextWindow,
					source: usage.source,
				});
	return {
		usagePercent: args.usage?.percent ?? null,
		usageTokens: args.usage?.tokens ?? null,
		contextWindow: args.usage?.contextWindow ?? null,
		usageSource: args.usage?.source ?? "unknown",
		band: getUsageBandText(args.usage?.percent ?? null),
		effectiveBand,
		selectedMode: args.selectedMode,
		isCompacting: args.isCompacting,
		cooldownActive: cooldownRemainingMs > 0,
		cooldownRemainingMs,
		lastCompaction: args.lastCompaction,
		lastFallbackReason: args.lastFallbackReason,
		lastInjectedEcho: args.lastInjectedEcho,
		telemetryPersistenceIssues: args.telemetryPersistenceIssues ?? [],
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
		`  Threshold mode: ${THRESHOLD_MODE}`,
		`  Percent band: ${status.band}`,
		`  Token band: ${getTokenBandText(status.usageTokens)}`,
		`  Effective band: ${status.effectiveBand ?? "none"}`,
		`  Thresholds:`,
		`    percent checkpoint=${CHECKPOINT_CANDIDATE_PERCENT}% standard=${STANDARD_THRESHOLD_PERCENT}% hard=${HARD_THRESHOLD_PERCENT}%`,
		`    tokens checkpoint=${CHECKPOINT_CANDIDATE_TOKENS.toLocaleString()} standard=${STANDARD_THRESHOLD_TOKENS.toLocaleString()} hard=${HARD_THRESHOLD_TOKENS.toLocaleString()}`,
		`    cooldown=${COOLDOWN_MS / 1000}s`,
		"  Config reload: threshold/cooldown changes require /reload or restart",
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
	if (status.telemetryPersistenceIssues.length > 0) {
		lines.push("  Telemetry persistence warnings:");
		for (const issue of status.telemetryPersistenceIssues) {
			lines.push(
				`    ${issue.operation}/${issue.code}: ${issue.message} (${issue.path})`,
			);
			if (issue.quarantinePath) {
				lines.push(`      Quarantined: ${issue.quarantinePath}`);
			}
		}
	}
	if (status.lastCompaction) {
		const lc = status.lastCompaction;
		const ago = Math.round((Date.now() - lc.timestamp) / 1000);
		const focusTags = Array.from(new Set(lc.focusTags.filter(Boolean)));
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
		if (focusTags.length > 0) {
			lines.push(`    Focus files: ${focusTags.join(", ")}`);
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
