import type { CompactionMode, CompactionTelemetry } from "./types.js";

/** Version of the persisted telemetry schema owned by this module. */
export const PERSIST_VERSION = 3;

export interface PersistedTelemetry {
	lastCompaction: CompactionTelemetry | null;
	lastFallbackReason: string | null;
	lastInjectedEcho: string | null;
	lastCompactTime: number;
	lastCompactTokens: number;
	lastModelKey: string | null;
	version: number;
}

// --- Telemetry validation (pure; no filesystem access) ---

const MAX_FUTURE_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years
const MAX_USAGE_PERCENT = 1000;
const MAX_REASONABLE_TOKENS = 1_000_000_000; // 1B tokens — far beyond current context windows
const MAX_REASONABLE_MESSAGES = 1_000_000; // 1M messages

function isValidTimestamp(value: unknown, now: number): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= now + MAX_FUTURE_MS
	);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidUsagePercent(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= MAX_USAGE_PERCENT
	);
}

function isValidTokenCount(value: unknown): value is number {
	return isSafeNonNegativeInteger(value) && value <= MAX_REASONABLE_TOKENS;
}

function isValidMessageCount(value: unknown): value is number {
	return isSafeNonNegativeInteger(value) && value <= MAX_REASONABLE_MESSAGES;
}

// ── Schema validation / coercion ─────────────────────────────────────

export function validatePersistedTelemetry(
	data: Record<string, unknown>,
	now: number,
): {
	telemetry: PersistedTelemetry;
	issues: string[];
} {
	const issues: string[] = [];

	let lastCompactTime = 0;
	if ("lastCompactTime" in data) {
		if (isValidTimestamp(data.lastCompactTime, now)) {
			lastCompactTime = data.lastCompactTime;
		} else {
			issues.push(
				`lastCompactTime: expected finite safe non-negative timestamp not unreasonably far in the future, got ${String(data.lastCompactTime)}`,
			);
		}
	}

	let lastCompactTokens = 0;
	if ("lastCompactTokens" in data) {
		if (isValidTokenCount(data.lastCompactTokens)) {
			lastCompactTokens = data.lastCompactTokens;
		} else {
			issues.push(
				`lastCompactTokens: expected finite safe non-negative integer within reasonable token range, got ${String(data.lastCompactTokens)}`,
			);
		}
	}

	let lastFallbackReason: string | null = null;
	if ("lastFallbackReason" in data) {
		if (
			data.lastFallbackReason === null ||
			typeof data.lastFallbackReason === "string"
		) {
			lastFallbackReason = data.lastFallbackReason;
		} else {
			issues.push(
				`lastFallbackReason: expected string or null, got ${typeof data.lastFallbackReason}`,
			);
		}
	}

	let lastInjectedEcho: string | null = null;
	if ("lastInjectedEcho" in data) {
		if (
			data.lastInjectedEcho === null ||
			typeof data.lastInjectedEcho === "string"
		) {
			lastInjectedEcho = data.lastInjectedEcho;
		} else {
			issues.push(
				`lastInjectedEcho: expected string or null, got ${typeof data.lastInjectedEcho}`,
			);
		}
	}

	let lastModelKey: string | null = null;
	if ("lastModelKey" in data) {
		if (data.lastModelKey === null || typeof data.lastModelKey === "string") {
			lastModelKey = data.lastModelKey;
		} else {
			issues.push(
				`lastModelKey: expected string or null, got ${typeof data.lastModelKey}`,
			);
		}
	}

	let lastCompaction: CompactionTelemetry | null = null;
	// JSON null is the persisted "no compaction" sentinel; skip object validation.
	if ("lastCompaction" in data && data.lastCompaction !== null) {
		const validated = validateCompactionTelemetry(data.lastCompaction, now);
		if (validated) {
			lastCompaction = validated;
		} else {
			issues.push("lastCompaction: invalid CompactionTelemetry shape");
		}
	}

	return {
		telemetry: {
			lastCompaction,
			lastFallbackReason,
			lastInjectedEcho,
			lastCompactTime,
			lastCompactTokens,
			lastModelKey,
			version: PERSIST_VERSION,
		},
		issues,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCompactionMode(
	value: unknown,
): value is CompactionTelemetry["mode"] {
	return value === "standard" || value === "hard";
}

function isTriggerSource(
	value: unknown,
): value is CompactionTelemetry["triggerSource"] {
	return value === "message_end" || value === "turn_end" || value === "command";
}

function isUsageSource(
	value: unknown,
): value is CompactionTelemetry["usageSource"] {
	return value === "native" || value === "estimated" || value === "unknown";
}

function isExecutionPath(
	value: unknown,
): value is CompactionTelemetry["executionPath"] {
	return value === "custom" || value === "native-fallback";
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function buildRequiredCompactionTelemetry(
	value: unknown,
	now: number,
): CompactionTelemetry | null {
	if (!isRecord(value)) return null;

	if (
		!isCompactionMode(value.mode) ||
		!isTriggerSource(value.triggerSource) ||
		typeof value.triggerReason !== "string" ||
		!isValidTimestamp(value.timestamp, now) ||
		!isStringArray(value.focusTags) ||
		typeof value.previousSummaryPresent !== "boolean" ||
		typeof value.splitTurn !== "boolean" ||
		!isUsageSource(value.usageSource) ||
		!isValidMessageCount(value.messagesSummarizedCount) ||
		!isExecutionPath(value.executionPath) ||
		typeof value.fromExtension !== "boolean"
	) {
		return null;
	}

	return {
		mode: value.mode,
		triggerSource: value.triggerSource,
		triggerReason: value.triggerReason,
		timestamp: value.timestamp,
		focusTags: value.focusTags,
		previousSummaryPresent: value.previousSummaryPresent,
		splitTurn: value.splitTurn,
		usageSource: value.usageSource,
		messagesSummarizedCount: value.messagesSummarizedCount,
		executionPath: value.executionPath,
		fromExtension: value.fromExtension,
	};
}

function applyOptionalFallbackReason(
	target: CompactionTelemetry,
	source: Record<string, unknown>,
): boolean {
	const value = source.fallbackReason;
	if (value === undefined) return true;
	if (typeof value !== "string") return false;
	target.fallbackReason = value;
	return true;
}

function applyOptionalClassifiedCounts(
	target: CompactionTelemetry,
	source: Record<string, unknown>,
): boolean {
	const value = source.classifiedCounts;
	if (value === undefined) return true;
	if (!isRecord(value)) return false;
	if (
		!isValidMessageCount(value.critical) ||
		!isValidMessageCount(value.contextual) ||
		!isValidMessageCount(value.ephemeral)
	) {
		return false;
	}
	target.classifiedCounts = {
		critical: value.critical,
		contextual: value.contextual,
		ephemeral: value.ephemeral,
	};
	return true;
}

type OptionalNumberKey = "usagePercentAtTrigger" | "usageTokensAtTrigger";

function applyOptionalNumber(
	target: CompactionTelemetry,
	source: Record<string, unknown>,
	key: OptionalNumberKey,
	isValid: (value: unknown) => value is number,
): boolean {
	const value = source[key];
	if (value === undefined) return true;
	if (!isValid(value)) return false;
	target[key] = value;
	return true;
}

type OptionalNullableStringKey = "thinkingLevel" | "compatibilityReason";

function applyOptionalNullableString(
	target: CompactionTelemetry,
	source: Record<string, unknown>,
	key: OptionalNullableStringKey,
): boolean {
	const value = source[key];
	if (value === undefined) return true;
	if (value !== null && typeof value !== "string") return false;
	target[key] = value;
	return true;
}

function applyOptionalCompactionTelemetry(
	target: CompactionTelemetry,
	source: Record<string, unknown>,
): boolean {
	return (
		applyOptionalFallbackReason(target, source) &&
		applyOptionalClassifiedCounts(target, source) &&
		applyOptionalNumber(
			target,
			source,
			"usagePercentAtTrigger",
			isValidUsagePercent,
		) &&
		applyOptionalNumber(
			target,
			source,
			"usageTokensAtTrigger",
			isValidTokenCount,
		) &&
		applyOptionalNullableString(target, source, "thinkingLevel") &&
		applyOptionalNullableString(target, source, "compatibilityReason")
	);
}

function validateCompactionTelemetry(
	value: unknown,
	now: number,
): CompactionTelemetry | null {
	const result = buildRequiredCompactionTelemetry(value, now);
	if (!result) return null;
	return applyOptionalCompactionTelemetry(
		result,
		value as Record<string, unknown>,
	)
		? result
		: null;
}
