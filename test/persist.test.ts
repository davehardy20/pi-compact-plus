import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadTelemetryWithDiagnostics,
	saveTelemetryWithDiagnostics,
} from "../src/persist.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-plus-persist-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("Compact+ telemetry persistence", () => {
	it("returns no issue when telemetry file is missing", async () => {
		const filePath = path.join(makeTempDir(), "missing", "telemetry.json");

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result).toEqual({ telemetry: null, issue: null });
	});

	it("loads valid v1, v2, and v3 telemetry", async () => {
		for (const version of [1, 2, 3]) {
			const filePath = path.join(makeTempDir(), `telemetry-v${version}.json`);
			fs.writeFileSync(
				filePath,
				JSON.stringify({
					version,
					lastFallbackReason: `fallback-v${version}`,
					lastInjectedEcho: `echo-v${version}`,
					lastCompactTime: version,
					lastCompactTokens: version * 10,
				}),
				"utf8",
			);

			const result = await loadTelemetryWithDiagnostics({ filePath });

			expect(result.issue).toBeNull();
			expect(result.telemetry).toMatchObject({
				version: 3,
				lastCompaction: null,
				lastFallbackReason: `fallback-v${version}`,
				lastInjectedEcho: `echo-v${version}`,
				lastCompactTime: version,
				lastCompactTokens: version * 10,
			});
		}
	});

	it("quarantines corrupt telemetry JSON", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(filePath, "{ not json", "utf8");

		const result = await loadTelemetryWithDiagnostics({
			filePath,
			now: () => new Date("2026-05-21T10:00:00.000Z"),
		});

		expect(result.telemetry).toBeNull();
		expect(result.issue).toMatchObject({
			operation: "load",
			code: "corrupt-json",
			path: filePath,
			quarantinePath: `${filePath}.corrupt-2026-05-21T10-00-00-000Z`,
		});
		expect(fs.existsSync(filePath)).toBe(false);
		expect(fs.existsSync(result.issue?.quarantinePath ?? "")).toBe(true);
		if (process.platform !== "win32") {
			expect(fs.statSync(result.issue?.quarantinePath ?? "").mode & 0o777).toBe(
				0o600,
			);
		}
	});

	it("reports read failures distinctly from missing files", async () => {
		const filePath = makeTempDir();

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toBeNull();
		expect(result.issue).toMatchObject({
			operation: "load",
			code: "read-failed",
			path: filePath,
		});
	});

	it("reports inaccessible telemetry paths distinctly from missing files", async () => {
		if (process.platform === "win32") return;
		const tempDir = makeTempDir();
		const blockedDir = path.join(tempDir, "blocked");
		fs.mkdirSync(blockedDir, 0o700);
		const filePath = path.join(blockedDir, "telemetry.json");
		fs.writeFileSync(filePath, "{}", "utf8");
		fs.chmodSync(blockedDir, 0o000);

		try {
			const result = await loadTelemetryWithDiagnostics({ filePath });

			expect(result.telemetry).toBeNull();
			expect(result.issue).toMatchObject({
				operation: "load",
				code: "read-failed",
				path: filePath,
			});
		} finally {
			fs.chmodSync(blockedDir, 0o700);
		}
	});

	it("reports save failures without throwing", async () => {
		const filePath = makeTempDir();

		const result = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: null,
				lastInjectedEcho: null,
				lastCompactTime: 0,
				lastCompactTokens: 0,
			},
			{ filePath },
		);

		expect(result).toMatchObject({
			saved: false,
			issue: {
				operation: "save",
				code: "write-failed",
				path: filePath,
			},
		});
	});

	it("saves telemetry and applies restrictive permissions on POSIX", async () => {
		const filePath = path.join(makeTempDir(), "state", "telemetry.json");

		const result = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: "fallback",
				lastInjectedEcho: "echo",
				lastCompactTime: 123,
				lastCompactTokens: 456,
			},
			{ filePath },
		);

		expect(result.saved).toBe(true);
		expect(fs.existsSync(filePath)).toBe(true);
		expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({
			version: 3,
			lastFallbackReason: "fallback",
			lastInjectedEcho: "echo",
			lastCompactTime: 123,
			lastCompactTokens: 456,
		});

		if (process.platform !== "win32") {
			expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
			expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
		}
	});
});
