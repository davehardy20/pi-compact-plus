import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CompactPlusSettingsFile {
	checkpointThresholdPercent?: unknown;
	standardThresholdPercent?: unknown;
	hardThresholdPercent?: unknown;
	thresholdMode?: unknown;
	checkpointThresholdTokens?: unknown;
	standardThresholdTokens?: unknown;
	hardThresholdTokens?: unknown;
	cooldownMs?: unknown;
	thresholds?: {
		checkpoint?: unknown;
		checkpointCandidate?: unknown;
		standard?: unknown;
		hard?: unknown;
		checkpointTokens?: unknown;
		checkpointCandidateTokens?: unknown;
		standardTokens?: unknown;
		hardTokens?: unknown;
	};
	experimentalToolOutputPruning?: unknown;
	toolOutputPruningMode?: unknown;
	toolOutputSummaryStrategy?: unknown;
	toolOutputPruneStrategy?: unknown;
	toolOutputPruneMinChars?: unknown;
	toolOutputSummaryMaxChars?: unknown;
	toolOutputQueryMaxChars?: unknown;
	toolOutputSummarizerModel?: unknown;
	toolOutputSummarizerThinking?: unknown;
	toolOutputPruneExcludedTools?: unknown;
	toolOutputPruneIncludedTools?: unknown;
}

export type CompactPlusThresholdMode = "percent" | "tokens" | "effective_cap";

export interface ResolvedCompactPlusSettings {
	thresholdMode: CompactPlusThresholdMode;
	checkpointThresholdPercent: number;
	standardThresholdPercent: number;
	hardThresholdPercent: number;
	checkpointThresholdTokens: number;
	standardThresholdTokens: number;
	hardThresholdTokens: number;
	cooldownMs: number;
	settingsPath: string;
	experimentalToolOutputPruning: boolean;
	toolOutputPruningMode: "off" | "agent-message";
	toolOutputSummaryStrategy: "llm";
	toolOutputPruneStrategy: "stub" | "delete";
	toolOutputPruneMinChars: number;
	toolOutputSummaryMaxChars: number;
	toolOutputQueryMaxChars: number;
	toolOutputSummarizerModel: "default" | string;
	toolOutputSummarizerThinking:
		| "default"
		| "off"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh";
	toolOutputPruneExcludedTools: string[];
	toolOutputPruneIncludedTools: string[];
}

export const DEFAULT_COMPACT_PLUS_SETTINGS = {
	thresholdMode: "effective_cap" as const,
	checkpointThresholdPercent: 65,
	standardThresholdPercent: 70,
	hardThresholdPercent: 90,
	checkpointThresholdTokens: 185_000,
	standardThresholdTokens: 200_000,
	hardThresholdTokens: 260_000,
	cooldownMs: 120_000,
	experimentalToolOutputPruning: false,
	toolOutputPruningMode: "off" as const,
	toolOutputSummaryStrategy: "llm" as const,
	toolOutputPruneStrategy: "stub" as const,
	toolOutputPruneMinChars: 3000,
	toolOutputSummaryMaxChars: 1600,
	toolOutputQueryMaxChars: 12000,
	toolOutputSummarizerModel: "default" as const,
	toolOutputSummarizerThinking: "low" as const,
	toolOutputPruneExcludedTools: [
		"read",
		"read_hashed",
		"hashline_edit",
		"compact_plus_query_tool_output",
	],
	toolOutputPruneIncludedTools: [],
} as const;

export function parseEnvInt(
	envVar: string | undefined,
	defaultValue: number,
): number {
	if (envVar === undefined) return defaultValue;
	const parsed = parseInt(envVar, 10);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}

export function parseEnvBool(
	envVar: string | undefined,
	defaultValue: boolean,
): boolean {
	if (envVar === undefined) return defaultValue;
	const normalized = envVar.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes")
		return true;
	if (normalized === "false" || normalized === "0" || normalized === "no")
		return false;
	return defaultValue;
}

export function parseEnvStringArray(
	envVar: string | undefined,
	defaultValue: string[],
): string[] {
	if (envVar === undefined) return defaultValue;
	const parts = envVar
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return parts.length > 0 ? parts : defaultValue;
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
	let checkpointThresholdPercent = resolvePercentSetting(
		env.COMPACT_PLUS_CHECKPOINT_THRESHOLD,
		firstDefined(
			fileSettings.checkpointThresholdPercent,
			fileSettings.thresholds?.checkpoint,
			fileSettings.thresholds?.checkpointCandidate,
		),
		DEFAULT_COMPACT_PLUS_SETTINGS.checkpointThresholdPercent,
	);
	let standardThresholdPercent = resolvePercentSetting(
		env.COMPACT_PLUS_STANDARD_THRESHOLD,
		firstDefined(
			fileSettings.standardThresholdPercent,
			fileSettings.thresholds?.standard,
		),
		DEFAULT_COMPACT_PLUS_SETTINGS.standardThresholdPercent,
	);
	let hardThresholdPercent = resolvePercentSetting(
		env.COMPACT_PLUS_HARD_THRESHOLD,
		firstDefined(
			fileSettings.hardThresholdPercent,
			fileSettings.thresholds?.hard,
		),
		DEFAULT_COMPACT_PLUS_SETTINGS.hardThresholdPercent,
	);

	const thresholdMode = resolveEnumSetting(
		env.COMPACT_PLUS_THRESHOLD_MODE,
		fileSettings.thresholdMode,
		["percent", "tokens", "effective_cap"],
		DEFAULT_COMPACT_PLUS_SETTINGS.thresholdMode,
	);

	let checkpointThresholdTokens = resolveTokenThresholdSetting(
		env.COMPACT_PLUS_CHECKPOINT_THRESHOLD_TOKENS,
		firstDefined(
			fileSettings.checkpointThresholdTokens,
			fileSettings.thresholds?.checkpointTokens,
			fileSettings.thresholds?.checkpointCandidateTokens,
		),
		DEFAULT_COMPACT_PLUS_SETTINGS.checkpointThresholdTokens,
	);
	let standardThresholdTokens = resolveTokenThresholdSetting(
		env.COMPACT_PLUS_STANDARD_THRESHOLD_TOKENS,
		firstDefined(
			fileSettings.standardThresholdTokens,
			fileSettings.thresholds?.standardTokens,
		),
		DEFAULT_COMPACT_PLUS_SETTINGS.standardThresholdTokens,
	);
	let hardThresholdTokens = resolveTokenThresholdSetting(
		env.COMPACT_PLUS_HARD_THRESHOLD_TOKENS,
		firstDefined(
			fileSettings.hardThresholdTokens,
			fileSettings.thresholds?.hardTokens,
		),
		DEFAULT_COMPACT_PLUS_SETTINGS.hardThresholdTokens,
	);
	const cooldownMs = resolvePositiveIntegerSetting(
		env.COMPACT_PLUS_COOLDOWN_MS,
		fileSettings.cooldownMs,
		DEFAULT_COMPACT_PLUS_SETTINGS.cooldownMs,
	);

	const fileExperimentalToolOutputPruning = resolveBoolSetting(
		fileSettings.experimentalToolOutputPruning,
		DEFAULT_COMPACT_PLUS_SETTINGS.experimentalToolOutputPruning,
	);
	const experimentalToolOutputPruning =
		env.COMPACT_PLUS_EXPERIMENTAL_TOOL_OUTPUT_PRUNING === undefined
			? fileExperimentalToolOutputPruning
			: parseEnvBool(
					env.COMPACT_PLUS_EXPERIMENTAL_TOOL_OUTPUT_PRUNING,
					DEFAULT_COMPACT_PLUS_SETTINGS.experimentalToolOutputPruning,
				);

	const toolOutputPruningMode = resolveEnumSetting(
		env.COMPACT_PLUS_TOOL_OUTPUT_PRUNING_MODE,
		fileSettings.toolOutputPruningMode,
		["off", "agent-message"],
		DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputPruningMode,
	);

	const toolOutputSummaryStrategy = resolveEnumSetting(
		env.COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_STRATEGY,
		fileSettings.toolOutputSummaryStrategy,
		["llm"],
		DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputSummaryStrategy,
	);

	const toolOutputPruneStrategy = resolveEnumSetting(
		env.COMPACT_PLUS_TOOL_OUTPUT_PRUNE_STRATEGY,
		fileSettings.toolOutputPruneStrategy,
		["stub", "delete"],
		DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputPruneStrategy,
	);

	const toolOutputPruneMinChars = clampPositiveInteger(
		resolvePositiveIntegerSetting(
			env.COMPACT_PLUS_TOOL_OUTPUT_PRUNE_MIN_CHARS,
			fileSettings.toolOutputPruneMinChars,
			DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputPruneMinChars,
		),
		100,
		50_000,
	);

	const toolOutputSummaryMaxChars = clampPositiveInteger(
		resolvePositiveIntegerSetting(
			env.COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_MAX_CHARS,
			fileSettings.toolOutputSummaryMaxChars,
			DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputSummaryMaxChars,
		),
		100,
		10_000,
	);

	const toolOutputQueryMaxChars = clampPositiveInteger(
		resolvePositiveIntegerSetting(
			env.COMPACT_PLUS_TOOL_OUTPUT_QUERY_MAX_CHARS,
			fileSettings.toolOutputQueryMaxChars,
			DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputQueryMaxChars,
		),
		100,
		100_000,
	);

	const toolOutputSummarizerModel =
		typeof env.COMPACT_PLUS_TOOL_OUTPUT_SUMMARIZER_MODEL === "string" &&
		env.COMPACT_PLUS_TOOL_OUTPUT_SUMMARIZER_MODEL.trim().length > 0
			? env.COMPACT_PLUS_TOOL_OUTPUT_SUMMARIZER_MODEL.trim()
			: (resolveStringSetting(
					fileSettings.toolOutputSummarizerModel,
					DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputSummarizerModel,
				) ?? DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputSummarizerModel);

	const toolOutputSummarizerThinking = resolveEnumSetting(
		env.COMPACT_PLUS_TOOL_OUTPUT_SUMMARIZER_THINKING,
		fileSettings.toolOutputSummarizerThinking,
		["default", "off", "minimal", "low", "medium", "high", "xhigh"],
		DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputSummarizerThinking,
	);

	const toolOutputPruneExcludedTools = parseEnvStringArray(
		env.COMPACT_PLUS_TOOL_OUTPUT_PRUNE_EXCLUDED_TOOLS,
		resolveStringArraySetting(fileSettings.toolOutputPruneExcludedTools, [
			...DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputPruneExcludedTools,
		]),
	);

	const toolOutputPruneIncludedTools = parseEnvStringArray(
		env.COMPACT_PLUS_TOOL_OUTPUT_PRUNE_INCLUDED_TOOLS,
		resolveStringArraySetting(fileSettings.toolOutputPruneIncludedTools, [
			...DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputPruneIncludedTools,
		]),
	);

	if (
		checkpointThresholdPercent >= standardThresholdPercent ||
		standardThresholdPercent >= hardThresholdPercent
	) {
		checkpointThresholdPercent =
			DEFAULT_COMPACT_PLUS_SETTINGS.checkpointThresholdPercent;
		standardThresholdPercent =
			DEFAULT_COMPACT_PLUS_SETTINGS.standardThresholdPercent;
		hardThresholdPercent = DEFAULT_COMPACT_PLUS_SETTINGS.hardThresholdPercent;
	}

	if (
		checkpointThresholdTokens >= standardThresholdTokens ||
		standardThresholdTokens >= hardThresholdTokens
	) {
		checkpointThresholdTokens =
			DEFAULT_COMPACT_PLUS_SETTINGS.checkpointThresholdTokens;
		standardThresholdTokens =
			DEFAULT_COMPACT_PLUS_SETTINGS.standardThresholdTokens;
		hardThresholdTokens = DEFAULT_COMPACT_PLUS_SETTINGS.hardThresholdTokens;
	}

	return {
		thresholdMode,
		checkpointThresholdPercent,
		standardThresholdPercent,
		hardThresholdPercent,
		checkpointThresholdTokens,
		standardThresholdTokens,
		hardThresholdTokens,
		cooldownMs,
		settingsPath,
		experimentalToolOutputPruning,
		toolOutputPruningMode,
		toolOutputSummaryStrategy,
		toolOutputPruneStrategy,
		toolOutputPruneMinChars,
		toolOutputSummaryMaxChars,
		toolOutputQueryMaxChars,
		toolOutputSummarizerModel,
		toolOutputSummarizerThinking,
		toolOutputPruneExcludedTools,
		toolOutputPruneIncludedTools,
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

function resolveBoolSetting(
	fileValue: unknown,
	defaultValue: boolean,
): boolean {
	if (typeof fileValue === "boolean") return fileValue;
	return defaultValue;
}

function resolveEnumSetting<T extends string>(
	envValue: string | undefined,
	fileValue: unknown,
	allowed: readonly T[],
	defaultValue: T,
): T {
	if (envValue !== undefined) {
		const normalized = envValue.trim().toLowerCase();
		return allowed.includes(normalized as T) ? (normalized as T) : defaultValue;
	}
	if (typeof fileValue === "string" && allowed.includes(fileValue as T)) {
		return fileValue as T;
	}
	return defaultValue;
}

function resolveStringSetting(
	fileValue: unknown,
	defaultValue: string,
): string {
	if (typeof fileValue === "string" && fileValue.trim().length > 0) {
		return fileValue.trim();
	}
	return defaultValue;
}

function resolveStringArraySetting(
	fileValue: unknown,
	defaultValue: string[],
): string[] {
	if (Array.isArray(fileValue)) {
		const strings = fileValue.filter(
			(item): item is string => typeof item === "string",
		);
		return strings.length > 0 ? strings : defaultValue;
	}
	return defaultValue;
}

function clampPositiveInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

const TOKEN_THRESHOLD_MIN = 50_000;
const TOKEN_THRESHOLD_MAX = 2_000_000;

function resolveTokenThresholdSetting(
	envValue: string | undefined,
	fileValue: unknown,
	defaultValue: number,
): number {
	return clampPositiveInteger(
		resolvePositiveIntegerSetting(envValue, fileValue, defaultValue),
		TOKEN_THRESHOLD_MIN,
		TOKEN_THRESHOLD_MAX,
	);
}
