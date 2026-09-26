import {
	type CompactPlusThresholdSettings,
	DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
} from "./settings.js";
import {
	CHECKPOINT_NOTE_MAX_LENGTH,
	CHECKPOINT_SCHEMA_VERSION,
	type CheckpointData,
	type CompactionMode,
	type EffectiveUsage,
	type SessionSnapshot,
} from "./types.js";

export function resolveThresholdSettings(
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
