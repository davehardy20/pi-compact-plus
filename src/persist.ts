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
	try {
		const raw = await fs.readFile(persistFile, "utf8");
		const data = JSON.parse(raw) as Partial<PersistedTelemetry> & {
			version?: number;
		};
		if (
			data.version !== 1 &&
			data.version !== 2 &&
			data.version !== PERSIST_VERSION
		) {
			return {
				telemetry: null,
				issue: buildIssue(
					"load",
					"unsupported-version",
					persistFile,
					undefined,
					`unsupported telemetry version ${String(data.version)}`,
				),
			};
		}
		return {
			telemetry: {
				lastCompaction: data.lastCompaction ?? null,
				lastFallbackReason: data.lastFallbackReason ?? null,
				lastInjectedEcho: data.lastInjectedEcho ?? null,
				lastCompactTime: data.lastCompactTime ?? 0,
				lastCompactTokens: data.lastCompactTokens ?? 0,
				version: PERSIST_VERSION,
			},
			issue: null,
		};
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
	const dirIssue = await ensureDir(persistDir);
	if (dirIssue?.code === "write-failed") {
		return { saved: false, issue: dirIssue };
	}

	const payload: PersistedTelemetry = {
		...data,
		version: PERSIST_VERSION,
	};
	try {
		await fs.writeFile(persistFile, JSON.stringify(payload, null, 2), {
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
				"write telemetry file",
			),
		};
	}

	const fileIssue = await chmodBestEffort(
		persistFile,
		PERSIST_FILE_MODE,
		"save",
		"telemetry file",
	);
	return { saved: true, issue: fileIssue ?? dirIssue };
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
