import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type {
	CompactionTelemetry,
	TelemetryPersistenceIssue,
} from "./types.js";

const PERSIST_DIR = join(
	process.env.HOME ?? process.env.USERPROFILE ?? ".",
	".pi",
	"agent",
	"state",
);
const PERSIST_FILE = join(PERSIST_DIR, "compact-plus-telemetry.json");
const PERSIST_DIR_MODE = 0o700;
const PERSIST_FILE_MODE = 0o600;

export interface PersistedTelemetry {
	lastCompaction: CompactionTelemetry | null;
	lastFallbackReason: string | null;
	lastInjectedEcho: string | null;
	lastCompactTime: number;
	lastCompactTokens: number;
	lastModelKey: string | null;
	version: number;
}

export interface TelemetryPersistenceOptions {
	filePath?: string;
	now?: () => Date;
}

export interface LoadTelemetryResult {
	telemetry: PersistedTelemetry | null;
	issue: TelemetryPersistenceIssue | null;
}

export interface SaveTelemetryResult {
	saved: boolean;
	issue: TelemetryPersistenceIssue | null;
}

const PERSIST_VERSION = 3;

function getPersistFile(options: TelemetryPersistenceOptions = {}): string {
	return options.filePath ?? PERSIST_FILE;
}

async function detectSymlink(
	targetPath: string,
): Promise<{ path: string; linkTarget: string } | null> {
	try {
		const stat = await fs.lstat(targetPath);
		if (stat.isSymbolicLink()) {
			const linkTarget = await fs.readlink(targetPath);
			return { path: targetPath, linkTarget };
		}
	} catch {
		// ENOENT or other errors are fine — path doesn't exist or isn't a symlink
	}
	return null;
}

async function detectSymlinkInPath(
	filePath: string,
): Promise<{ path: string; linkTarget: string } | null> {
	let current = filePath;
	while (current !== dirname(current)) {
		const found = await detectSymlink(current);
		if (found) return found;
		// Stop once we reach an existing real directory; symlinks above it
		// are typically system-level (e.g., /var on macOS) and not attack vectors.
		try {
			const stat = await fs.stat(current);
			if (stat.isDirectory()) {
				break;
			}
		} catch {
			// path does not exist yet — keep walking upward
		}
		current = dirname(current);
	}
	return null;
}

async function ensureDir(
	path: string,
): Promise<TelemetryPersistenceIssue | null> {
	try {
		await fs.mkdir(path, { recursive: true, mode: PERSIST_DIR_MODE });
	} catch (error) {
		return buildIssue(
			"save",
			"write-failed",
			path,
			error,
			"create telemetry directory",
		);
	}

	return chmodBestEffort(path, PERSIST_DIR_MODE, "save", "telemetry directory");
}

async function chmodBestEffort(
	path: string,
	mode: number,
	operation: "load" | "save",
	target: string,
): Promise<TelemetryPersistenceIssue | null> {
	try {
		await fs.chmod(path, mode);
		return null;
	} catch (error) {
		return buildIssue(
			operation,
			"permission-failed",
			path,
			error,
			`harden ${target} permissions`,
		);
	}
}

export async function loadTelemetryWithDiagnostics(
	options: TelemetryPersistenceOptions = {},
): Promise<LoadTelemetryResult> {
	const persistFile = getPersistFile(options);
	const symlink = await detectSymlinkInPath(persistFile);
	if (symlink) {
		return {
			telemetry: null,
			issue: buildIssue(
				"load",
				"symlink-detected",
				persistFile,
				new Error(
					`symlink detected at ${symlink.path} -> ${symlink.linkTarget}`,
				),
				"refuse to read telemetry through symlink",
			),
		};
	}
	try {
		const raw = await fs.readFile(persistFile, "utf8");
		const parsed = JSON.parse(raw) as unknown;

		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				telemetry: null,
				issue: buildIssue(
					"load",
					"invalid-schema",
					persistFile,
					undefined,
					"telemetry root is not an object",
				),
			};
		}

		const data = parsed as Record<string, unknown>;
		const version = data.version;
		if (version !== 1 && version !== 2 && version !== PERSIST_VERSION) {
			return {
				telemetry: null,
				issue: buildIssue(
					"load",
					"unsupported-version",
					persistFile,
					undefined,
					`unsupported telemetry version ${String(version)}`,
				),
			};
		}

		const now = options.now ? options.now().getTime() : Date.now();
		const { telemetry, issues } = validatePersistedTelemetry(data, now);
		if (issues.length > 0) {
			const count = issues.length;
			return {
				telemetry,
				issue: buildIssue(
					"load",
					"invalid-schema",
					persistFile,
					undefined,
					`telemetry schema validation failed (${count} issue${count === 1 ? "" : "s"}): ${issues.join("; ")}`,
				),
			};
		}

		return { telemetry, issue: null };
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { telemetry: null, issue: null };
		}
		if (error instanceof SyntaxError) {
			return {
				telemetry: null,
				issue: await quarantineCorruptTelemetry(persistFile, error, options),
			};
		}
		return {
			telemetry: null,
			issue: buildIssue(
				"load",
				"read-failed",
				persistFile,
				error,
				"read telemetry file",
			),
		};
	}
}

export async function loadTelemetry(): Promise<PersistedTelemetry | null> {
	return (await loadTelemetryWithDiagnostics()).telemetry;
}

export async function saveTelemetryWithDiagnostics(
	data: Omit<PersistedTelemetry, "version">,
	options: TelemetryPersistenceOptions = {},
): Promise<SaveTelemetryResult> {
	const persistFile = getPersistFile(options);
	const persistDir = dirname(persistFile);
	const symlink = await detectSymlinkInPath(persistFile);
	if (symlink) {
		return {
			saved: false,
			issue: buildIssue(
				"save",
				"symlink-detected",
				persistFile,
				new Error(
					`symlink detected at ${symlink.path} -> ${symlink.linkTarget}`,
				),
				"refuse to write telemetry through symlink",
			),
		};
	}
	const dirIssue = await ensureDir(persistDir);
	if (dirIssue?.code === "write-failed") {
		return { saved: false, issue: dirIssue };
	}

	const payload: PersistedTelemetry = {
		...data,
		version: PERSIST_VERSION,
	};
	const tempFile = `${persistFile}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	try {
		await fs.writeFile(tempFile, JSON.stringify(payload, null, 2), {
			mode: PERSIST_FILE_MODE,
		});
	} catch (error) {
		return {
			saved: false,
			issue: buildIssue(
				"save",
				"write-failed",
				persistFile,
				error,
				"write telemetry temp file",
			),
		};
	}

	const chmodIssue = await chmodBestEffort(
		tempFile,
		PERSIST_FILE_MODE,
		"save",
		"telemetry temp file",
	);

	try {
		await fs.rename(tempFile, persistFile);
	} catch (error) {
		try {
			await fs.unlink(tempFile);
		} catch {
			// ignore cleanup failure
		}
		return {
			saved: false,
			issue: buildIssue(
				"save",
				"write-failed",
				persistFile,
				error,
				"atomically replace telemetry file",
			),
		};
	}

	return { saved: true, issue: chmodIssue ?? dirIssue };
}

export async function saveTelemetry(
	data: Omit<PersistedTelemetry, "version">,
): Promise<void> {
	await saveTelemetryWithDiagnostics(data);
}

async function quarantineCorruptTelemetry(
	persistFile: string,
	error: unknown,
	options: TelemetryPersistenceOptions,
): Promise<TelemetryPersistenceIssue> {
	const quarantinePath = `${persistFile}.corrupt-${formatTimestamp(options.now?.() ?? new Date())}`;
	try {
		await fs.rename(persistFile, quarantinePath);
		const chmodIssue = await chmodBestEffort(
			quarantinePath,
			PERSIST_FILE_MODE,
			"load",
			"quarantined telemetry file",
		);
		return buildIssue(
			"load",
			"corrupt-json",
			persistFile,
			chmodIssue ? new Error(chmodIssue.message) : error,
			chmodIssue
				? "telemetry file contained invalid JSON and was quarantined, but quarantine permissions could not be hardened"
				: "telemetry file contained invalid JSON and was quarantined",
			quarantinePath,
		);
	} catch (renameError) {
		return buildIssue(
			"load",
			"corrupt-json",
			persistFile,
			renameError,
			"telemetry file contained invalid JSON and could not be quarantined",
		);
	}
}

function formatTimestamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function buildIssue(
	operation: "load" | "save",
	code: TelemetryPersistenceIssue["code"],
	path: string,
	error: unknown,
	action: string,
	quarantinePath?: string,
): TelemetryPersistenceIssue {
	const details = error instanceof Error ? error.message : undefined;
	return {
		operation,
		code,
		path,
		quarantinePath,
		message: details
			? `Could not ${action}: ${details}`
			: `Could not ${action}.`,
		timestamp: Date.now(),
	};
}

// ── Semantic validators ──────────────────────────────────────────────

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

function validatePersistedTelemetry(
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
