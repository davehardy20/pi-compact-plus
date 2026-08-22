import {
	type CompactPlusThresholdSettings,
	DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
} from "./settings.js";
import {
	CHECKPOINT_NOTE_MAX_LENGTH,
	CHECKPOINT_SCHEMA_VERSION,
	type CheckpointData,
	type CompactionMode,
	type CompactionTelemetry,
	type CompactPlusStatus,
	type EffectiveUsage,
	type SessionSnapshot,
	type TelemetryPersistenceIssue,
} from "./types.js";

function resolveThresholdSettings(
	settings: CompactPlusThresholdSettings | undefined,
): CompactPlusThresholdSettings {
	return settings ?? DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS;
}

export function getModeFromUsage(
	percent: number | null,
	settings?: CompactPlusThresholdSettings,
): CompactionMode | null {
	const resolvedSettings = resolveThresholdSettings(settings);
	if (percent === null) return null;
	if (percent >= resolvedSettings.hardThresholdPercent) return "hard";
	if (percent >= resolvedSettings.standardThresholdPercent) return "standard";
	if (percent >= resolvedSettings.checkpointThresholdPercent) {
		return "checkpoint";
	}
	return null;
}

export function getModeFromTokenUsage(
	tokens: number | null,
	settings?: CompactPlusThresholdSettings,
): CompactionMode | null {
	const resolvedSettings = resolveThresholdSettings(settings);
	if (tokens === null) return null;
	if (tokens >= resolvedSettings.hardThresholdTokens) return "hard";
	if (tokens >= resolvedSettings.standardThresholdTokens) return "standard";
	if (tokens >= resolvedSettings.checkpointThresholdTokens) return "checkpoint";
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
	settings?: CompactPlusThresholdSettings,
): CompactionMode | null {
	const resolvedSettings = resolveThresholdSettings(settings);
	const percentMode = getModeFromUsage(usage.percent, resolvedSettings);
	const tokenMode = getModeFromTokenUsage(usage.tokens, resolvedSettings);

	switch (resolvedSettings.thresholdMode) {
		case "percent":
			return percentMode;
		case "tokens":
			return tokenMode;
		case "effective_cap":
			return highestSeverityMode(percentMode, tokenMode);
	}
}

export function getUsageBandText(
	percent: number | null,
	settings?: CompactPlusThresholdSettings,
): string {
	const resolvedSettings = resolveThresholdSettings(settings);
	return getThresholdBandText(
		percent,
		resolvedSettings.checkpointThresholdPercent,
		resolvedSettings.standardThresholdPercent,
		resolvedSettings.hardThresholdPercent,
		(value) => value.toString(),
		"%",
	);
}

export function getTokenBandText(
	tokens: number | null,
	settings?: CompactPlusThresholdSettings,
): string {
	const resolvedSettings = resolveThresholdSettings(settings);
	return getThresholdBandText(
		tokens,
		resolvedSettings.checkpointThresholdTokens,
		resolvedSettings.standardThresholdTokens,
		resolvedSettings.hardThresholdTokens,
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
	settings?: CompactPlusThresholdSettings,
): number {
	const resolvedSettings = resolveThresholdSettings(settings);
	const elapsed = now - lastCompactTime;
	const remaining = resolvedSettings.cooldownMs - elapsed;
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
	settings?: CompactPlusThresholdSettings;
}): CompactPlusStatus {
	const settings = resolveThresholdSettings(args.settings);
	const now = Date.now();
	const cooldownRemainingMs = getCooldownRemainingMs(
		now,
		args.lastCompactTime,
		settings,
	);
	const usage = args.usage;
	const effectiveBand =
		usage === null
			? null
			: getModeFromEffectiveUsage(
					{
						percent: usage.percent,
						tokens: usage.tokens,
						contextWindow: usage.contextWindow,
						source: usage.source,
					},
					settings,
				);
	return {
		usagePercent: args.usage?.percent ?? null,
		usageTokens: args.usage?.tokens ?? null,
		contextWindow: args.usage?.contextWindow ?? null,
		usageSource: args.usage?.source ?? "unknown",
		band: getUsageBandText(args.usage?.percent ?? null, settings),
		effectiveBand,
		selectedMode: args.selectedMode,
		isCompacting: args.isCompacting,
		cooldownActive: cooldownRemainingMs > 0,
		cooldownRemainingMs,
		lastCompaction: args.lastCompaction,
		lastFallbackReason: args.lastFallbackReason,
		lastInjectedEcho: args.lastInjectedEcho,
		telemetryPersistenceIssues: args.telemetryPersistenceIssues ?? [],
		thresholdSettings: settings,
	};
}

function formatUsagePercent(percent: number | null): string {
	return percent === null ? "unknown" : `${percent.toFixed(1)}%`;
}

function formatNullableNumber(value: number | null): string {
	return value === null ? "unknown" : value.toLocaleString();
}

function formatOptionalMode(mode: CompactionMode | null): string {
	return mode ?? "none";
}

function formatCooldown(status: CompactPlusStatus): string {
	return status.cooldownActive
		? `${Math.ceil(status.cooldownRemainingMs / 1000)}s remaining`
		: "ready";
}

function formatCompacting(isCompacting: boolean): string {
	return isCompacting ? "in progress" : "idle";
}

function formatStatusCoreLines(
	status: CompactPlusStatus,
	settings: CompactPlusThresholdSettings,
): string[] {
	return [
		"📦 Compact+ status",
		`  Usage: ${formatUsagePercent(status.usagePercent)} (${formatNullableNumber(status.usageTokens)} / ${formatNullableNumber(status.contextWindow)} tokens)`,
		`  Source: ${status.usageSource}`,
		`  Threshold mode: ${settings.thresholdMode}`,
		`  Percent band: ${status.band}`,
		`  Token band: ${getTokenBandText(status.usageTokens, settings)}`,
		`  Effective band: ${formatOptionalMode(status.effectiveBand)}`,
		`  Thresholds:`,
		`    percent checkpoint=${settings.checkpointThresholdPercent}% standard=${settings.standardThresholdPercent}% hard=${settings.hardThresholdPercent}%`,
		`    tokens checkpoint=${settings.checkpointThresholdTokens.toLocaleString()} standard=${settings.standardThresholdTokens.toLocaleString()} hard=${settings.hardThresholdTokens.toLocaleString()}`,
		`    cooldown=${settings.cooldownMs / 1000}s`,
		"  Config reload: threshold/cooldown changes require /reload or restart",
		`  Selected mode: ${formatOptionalMode(status.selectedMode)}`,
		`  Cooldown: ${formatCooldown(status)}`,
		`  Compacting: ${formatCompacting(status.isCompacting)}`,
	];
}

function hasUnknownUsage(status: CompactPlusStatus): boolean {
	return status.usagePercent === null || status.usageTokens === null;
}

function formatNativeUsageDetail(status: CompactPlusStatus): string[] {
	if (status.usageSource !== "native") return [];
	if (!hasUnknownUsage(status)) return [];
	return [
		"  Usage detail: Pi reports usage as unknown until the next assistant response after compaction.",
	];
}

function pushWhen(lines: string[], condition: boolean, line: string): void {
	if (condition) lines.push(line);
}

function formatTelemetryIssueLines(
	issues: TelemetryPersistenceIssue[],
): string[] {
	if (issues.length === 0) return [];
	const lines = ["  Telemetry persistence warnings:"];
	for (const issue of issues) {
		lines.push(
			`    ${issue.operation}/${issue.code}: ${issue.message} (${issue.path})`,
		);
		pushWhen(
			lines,
			Boolean(issue.quarantinePath),
			`      Quarantined: ${issue.quarantinePath}`,
		);
	}
	return lines;
}

function formatCompactionPath(compaction: CompactionTelemetry): string {
	return `${compaction.executionPath}${compaction.fromExtension ? " (Compact+)" : " (native Pi)"}`;
}

function isDistinctCompatibilityReason(
	compaction: CompactionTelemetry,
): boolean {
	return (
		Boolean(compaction.compatibilityReason) &&
		compaction.compatibilityReason !== compaction.fallbackReason
	);
}

function formatLastCompactionLines(
	compaction: CompactionTelemetry | null,
): string[] {
	if (!compaction) return [];
	const ago = Math.round((Date.now() - compaction.timestamp) / 1000);
	const focusTags = Array.from(new Set(compaction.focusTags.filter(Boolean)));
	const lines = [
		`  Last compaction: ${compaction.mode} mode, ${compaction.triggerSource} trigger, ${ago}s ago`,
	];
	pushWhen(
		lines,
		Boolean(compaction.triggerReason),
		`    Reason: ${compaction.triggerReason}`,
	);
	lines.push(`    Path: ${formatCompactionPath(compaction)}`);
	pushWhen(
		lines,
		Boolean(compaction.thinkingLevel),
		`    Thinking level: ${compaction.thinkingLevel}`,
	);
	pushWhen(
		lines,
		focusTags.length > 0,
		`    Focus files: ${focusTags.join(", ")}`,
	);
	pushWhen(
		lines,
		compaction.previousSummaryPresent,
		"    Prior summary: merged",
	);
	pushWhen(lines, compaction.splitTurn, "    Split-turn: yes");
	pushWhen(
		lines,
		isDistinctCompatibilityReason(compaction),
		`    Compatibility: ${compaction.compatibilityReason}`,
	);
	pushWhen(
		lines,
		Boolean(compaction.fallbackReason),
		`    Fallback: ${compaction.fallbackReason}`,
	);
	return lines;
}

function getCompactionFallback(
	compaction: CompactionTelemetry | null,
): string | null {
	return compaction?.fallbackReason ?? null;
}

function getTopLevelFallback(
	status: CompactPlusStatus,
	compactionFallback: string | null,
): string | null {
	return status.lastFallbackReason &&
		status.lastFallbackReason !== compactionFallback
		? status.lastFallbackReason
		: null;
}

function formatTopLevelFallback(fallback: string | null): string[] {
	return fallback ? [`  Last fallback: ${fallback}`] : [];
}

function formatEchoLine(line: string): string {
	return `    ${line}`;
}

function hasFallback(
	compactionFallback: string | null,
	topLevelFallback: string | null,
): boolean {
	return Boolean(compactionFallback || topLevelFallback);
}

function formatLastFocusEchoLines(
	status: CompactPlusStatus,
	compactionFallback: string | null,
): string[] {
	if (status.lastInjectedEcho) {
		return [
			"  Last focus echo:",
			...status.lastInjectedEcho.split("\n").map(formatEchoLine),
		];
	}
	if (hasFallback(compactionFallback, status.lastFallbackReason)) {
		return [
			"  Last focus echo: (none — last compaction fell back before a custom summary was injected)",
		];
	}
	if (status.lastCompaction) {
		return [
			"  Last focus echo: (none — no persisted focus echo is available for the last compaction)",
		];
	}
	return ["  Last focus echo: (none — no compaction summary detected yet)"];
}

export function formatStatusLines(status: CompactPlusStatus): string[] {
	const settings = resolveThresholdSettings(status.thresholdSettings);
	const compactionFallback = getCompactionFallback(status.lastCompaction);
	const topLevelFallback = getTopLevelFallback(status, compactionFallback);
	return [
		...formatStatusCoreLines(status, settings),
		...formatNativeUsageDetail(status),
		...formatTelemetryIssueLines(status.telemetryPersistenceIssues),
		...formatLastCompactionLines(status.lastCompaction),
		...formatTopLevelFallback(topLevelFallback),
		...formatLastFocusEchoLines(status, compactionFallback),
	];
}
