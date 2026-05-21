import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CompactPlusSettingsFile {
	checkpointThresholdPercent?: unknown;
	standardThresholdPercent?: unknown;
	hardThresholdPercent?: unknown;
	cooldownMs?: unknown;
	thresholds?: {
		checkpoint?: unknown;
		checkpointCandidate?: unknown;
		standard?: unknown;
		hard?: unknown;
	};
}

export interface ResolvedCompactPlusSettings {
	checkpointThresholdPercent: number;
	standardThresholdPercent: number;
	hardThresholdPercent: number;
	cooldownMs: number;
	settingsPath: string;
}

export const DEFAULT_COMPACT_PLUS_SETTINGS = {
	checkpointThresholdPercent: 65,
	standardThresholdPercent: 70,
	hardThresholdPercent: 90,
	cooldownMs: 120_000,
} as const;

export function parseEnvInt(
	envVar: string | undefined,
	defaultValue: number,
): number {
	if (envVar === undefined) return defaultValue;
	const parsed = parseInt(envVar, 10);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}

export function getDefaultSettingsPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export function getSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.COMPACT_PLUS_SETTINGS_PATH
		? path.resolve(env.COMPACT_PLUS_SETTINGS_PATH)
		: getDefaultSettingsPath();
}

export function loadCompactPlusSettingsFile(
	env: NodeJS.ProcessEnv = process.env,
): CompactPlusSettingsFile {
	const settingsPath = getSettingsPath(env);
	if (!fs.existsSync(settingsPath)) {
		return {};
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		return isRecord(parsed) ? (parsed as CompactPlusSettingsFile) : {};
	} catch {
		return {};
	}
}

export function resolveCompactPlusSettings(
	env: NodeJS.ProcessEnv = process.env,
	fileSettings: CompactPlusSettingsFile = loadCompactPlusSettingsFile(env),
): ResolvedCompactPlusSettings {
	const settingsPath = getSettingsPath(env);
	const checkpointThresholdPercent = resolvePercentSetting(
		env.COMPACT_PLUS_CHECKPOINT_THRESHOLD,
		firstDefined(
			fileSettings.checkpointThresholdPercent,
			fileSettings.thresholds?.checkpoint,
			fileSettings.thresholds?.checkpointCandidate,
		),
		DEFAULT_COMPACT_PLUS_SETTINGS.checkpointThresholdPercent,
	);
	const standardThresholdPercent = resolvePercentSetting(
		env.COMPACT_PLUS_STANDARD_THRESHOLD,
		firstDefined(
			fileSettings.standardThresholdPercent,
			fileSettings.thresholds?.standard,
		),
		DEFAULT_COMPACT_PLUS_SETTINGS.standardThresholdPercent,
	);
	const hardThresholdPercent = resolvePercentSetting(
		env.COMPACT_PLUS_HARD_THRESHOLD,
		firstDefined(
			fileSettings.hardThresholdPercent,
			fileSettings.thresholds?.hard,
		),
		DEFAULT_COMPACT_PLUS_SETTINGS.hardThresholdPercent,
	);
	const cooldownMs = resolvePositiveIntegerSetting(
		env.COMPACT_PLUS_COOLDOWN_MS,
		fileSettings.cooldownMs,
		DEFAULT_COMPACT_PLUS_SETTINGS.cooldownMs,
	);

	if (
		checkpointThresholdPercent >= standardThresholdPercent ||
		standardThresholdPercent >= hardThresholdPercent
	) {
		return {
			...DEFAULT_COMPACT_PLUS_SETTINGS,
			settingsPath,
			cooldownMs,
		};
	}

	return {
		checkpointThresholdPercent,
		standardThresholdPercent,
		hardThresholdPercent,
		cooldownMs,
		settingsPath,
	};
}

function resolvePercentSetting(
	envValue: string | undefined,
	fileValue: unknown,
	defaultValue: number,
): number {
	const envParsed = parseInteger(envValue);
	if (isPercent(envParsed)) return envParsed;
	const fileParsed = parseInteger(fileValue);
	if (isPercent(fileParsed)) return fileParsed;
	return defaultValue;
}

function resolvePositiveIntegerSetting(
	envValue: string | undefined,
	fileValue: unknown,
	defaultValue: number,
): number {
	const envParsed = parseInteger(envValue);
	if (envParsed !== null && envParsed > 0) return envParsed;
	const fileParsed = parseInteger(fileValue);
	if (fileParsed !== null && fileParsed > 0) return fileParsed;
	return defaultValue;
}

function parseInteger(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
		return parseInt(value, 10);
	}
	return null;
}

function isPercent(value: number | null): value is number {
	return value !== null && value >= 1 && value <= 100;
}

function firstDefined(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
