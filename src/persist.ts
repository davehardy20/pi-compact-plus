import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	PERSIST_VERSION,
	type PersistedTelemetry,
	validatePersistedTelemetry,
} from "./telemetry-validation.js";
import type { TelemetryPersistenceIssue } from "./types.js";

export type { PersistedTelemetry };

const PERSIST_ROOT = process.env.HOME ?? process.env.USERPROFILE ?? ".";
const PERSIST_DIR = join(PERSIST_ROOT, ".pi", "agent", "state");
const PERSIST_FILE = join(PERSIST_DIR, "compact-plus-telemetry.json");
const PERSIST_DIR_MODE = 0o700;
const PERSIST_FILE_MODE = 0o600;

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

function persistPath(
	options: TelemetryPersistenceOptions,
	operation: "load" | "save",
): { filePath: string; root: string; issue: TelemetryPersistenceIssue | null } {
	const candidate = options.filePath ?? PERSIST_FILE;
	const filePath = typeof candidate === "string" ? candidate : "";
	// The override is only for isolated tests. The OS temp directory is its trust
	// anchor; normal persistence is anchored at the configured user home.
	const rawRoot = options.filePath === undefined ? PERSIST_ROOT : tmpdir();
	// resolve removes trailing separators so dirname() can reach this boundary.
	// Keep a relative HOME invalid rather than turning it into an implicit cwd.
	const root = isAbsolute(rawRoot) ? resolve(rawRoot) : rawRoot;
	const within = filePath ? relative(root, filePath) : "";
	const valid =
		filePath !== "" &&
		isAbsolute(root) &&
		isAbsolute(filePath) &&
		normalize(filePath) === filePath &&
		within !== "" &&
		within !== ".." &&
		!within.startsWith(`..${sep}`) &&
		!isAbsolute(within);
	return {
		filePath,
		root,
		issue: valid
			? null
			: buildIssue(
					operation,
					operation === "load" ? "read-failed" : "write-failed",
					filePath,
					undefined,
					"use a normalized absolute telemetry path inside the trusted root",
				),
	};
}

async function inspectPath(
	filePath: string,
	root: string,
	operation: "load" | "save",
): Promise<TelemetryPersistenceIssue | null> {
	let current = filePath;
	for (;;) {
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) {
				return buildIssue(
					operation,
					"symlink-detected",
					filePath,
					new Error(`symlink detected at ${current}`),
					"access telemetry through a symlink",
				);
			}
			if (current !== filePath && !stat.isDirectory()) {
				return buildIssue(
					operation,
					operation === "load" ? "read-failed" : "write-failed",
					filePath,
					undefined,
					"access telemetry through a non-directory ancestor",
				);
			}
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT" || current === root) {
				return buildIssue(
					operation,
					operation === "load" ? "read-failed" : "write-failed",
					filePath,
					error,
					"inspect telemetry path",
				);
			}
		}
		if (current === root) return null;
		current = dirname(current);
	}
}

async function ensureDir(
	path: string,
	root: string,
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

	const pathIssue = await inspectPath(path, root, "save");
	if (pathIssue) return pathIssue;
	try {
		const flags =
			constants.O_RDONLY |
			(constants.O_DIRECTORY ?? 0) |
			(constants.O_NOFOLLOW ?? 0);
		let handle: Awaited<ReturnType<typeof fs.open>>;
		try {
			handle = await fs.open(path, flags);
		} catch (openError) {
			if (!isNodeError(openError) || openError.code !== "EACCES") {
				throw openError;
			}
			// A user-owned directory may allow search/write but not read (0300).
			// Node cannot fchmod it without a readable directory handle. This
			// checked pathname fallback has the documented ancestor-swap race.
			const recheck = await inspectPath(path, root, "save");
			if (recheck) return recheck;
			await fs.chmod(path, PERSIST_DIR_MODE);
			const afterChmod = await inspectPath(path, root, "save");
			if (afterChmod) return afterChmod;
			handle = await fs.open(path, flags);
		}
		try {
			await handle.chmod(PERSIST_DIR_MODE);
		} finally {
			await handle.close();
		}
		return null;
	} catch (error) {
		return buildIssue(
			"save",
			"permission-failed",
			path,
			error,
			"harden telemetry directory permissions",
		);
	}
}

export async function loadTelemetryWithDiagnostics(
	options: TelemetryPersistenceOptions = {},
): Promise<LoadTelemetryResult> {
	const { filePath: persistFile, root, issue } = persistPath(options, "load");
	const pathIssue = issue ?? (await inspectPath(persistFile, root, "load"));
	if (pathIssue) return { telemetry: null, issue: pathIssue };
	try {
		// O_NOFOLLOW protects the leaf at open time; ancestor swaps remain a
		// pathname race on platforms without descriptor-relative traversal.
		const handle = await fs.open(
			persistFile,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		let raw: string;
		try {
			raw = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
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
		if (isNodeError(error) && error.code === "ELOOP") {
			return {
				telemetry: null,
				issue: buildIssue(
					"load",
					"symlink-detected",
					persistFile,
					error,
					"read telemetry through a symlink",
				),
			};
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
	const { filePath: persistFile, root, issue } = persistPath(options, "save");
	const pathIssue = issue ?? (await inspectPath(persistFile, root, "save"));
	if (pathIssue) return { saved: false, issue: pathIssue };
	const persistDir = dirname(persistFile);
	if (persistDir === root) {
		return {
			saved: false,
			issue: buildIssue(
				"save",
				"write-failed",
				persistFile,
				undefined,
				"create telemetry inside a directory below the trusted root",
			),
		};
	}
	const dirIssue = await ensureDir(persistDir, root);
	if (dirIssue) return { saved: false, issue: dirIssue };

	const payload: PersistedTelemetry = {
		...data,
		version: PERSIST_VERSION,
	};
	const tempFile = `${persistFile}.tmp-${randomUUID()}`;
	let created = false;
	async function cleanupTemp(): Promise<void> {
		if (!created || (await inspectPath(persistDir, root, "save"))) return;
		try {
			await fs.unlink(tempFile);
			created = false;
		} catch {
			// Best effort; never unlink through a known-unsafe parent path.
		}
	}
	try {
		const handle = await fs.open(
			tempFile,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				(constants.O_NOFOLLOW ?? 0),
			PERSIST_FILE_MODE,
		);
		created = true;
		try {
			await handle.writeFile(JSON.stringify(payload, null, 2));
			await handle.chmod(PERSIST_FILE_MODE);
		} finally {
			await handle.close();
		}
		const recheck = await inspectPath(persistFile, root, "save");
		if (recheck) {
			await cleanupTemp();
			return { saved: false, issue: recheck };
		}
		await fs.rename(tempFile, persistFile);
		return { saved: true, issue: null };
	} catch (error) {
		await cleanupTemp();
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
	const { root, issue } = persistPath(options, "load");
	const pathIssue = issue ?? (await inspectPath(persistFile, root, "load"));
	if (pathIssue) return pathIssue;
	try {
		await fs.rename(persistFile, quarantinePath);
	} catch (renameError) {
		return buildIssue(
			"load",
			"corrupt-json",
			persistFile,
			renameError,
			"telemetry file contained invalid JSON and could not be quarantined",
		);
	}
	let chmodIssue: TelemetryPersistenceIssue | null = null;
	try {
		const handle = await fs.open(
			quarantinePath,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		try {
			await handle.chmod(PERSIST_FILE_MODE);
		} finally {
			await handle.close();
		}
	} catch (chmodError) {
		chmodIssue = buildIssue(
			"load",
			"permission-failed",
			persistFile,
			chmodError,
			"harden quarantined telemetry file permissions",
		);
	}
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
