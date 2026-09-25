import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("Compact+ telemetry persistence", () => {
	it("uses a trailing-slash HOME as the default path boundary without walking to root", async () => {
		const home = makeTempDir();
		const stateDir = path.join(home, ".pi", "agent", "state");
		fs.mkdirSync(stateDir, { recursive: true });
		const filePath = path.join(stateDir, "compact-plus-telemetry.json");
		fs.writeFileSync(filePath, JSON.stringify({ version: 3 }));
		const originalHome = process.env.HOME;
		process.env.HOME = `${home}/`;
		vi.resetModules();
		const originalLstat = fs.promises.lstat.bind(fs.promises);
		let inspected = 0;
		vi.spyOn(fs.promises, "lstat").mockImplementation((target, options) => {
			if (++inspected > 20) throw new Error("walked beyond trusted home");
			return originalLstat(target, options);
		});
		try {
			const persistence = await import("../src/persist.js");
			const loaded = await persistence.loadTelemetryWithDiagnostics();
			expect(loaded.issue).toBeNull();
			expect(loaded.telemetry?.version).toBe(3);
			const saved = await persistence.saveTelemetryWithDiagnostics({
				lastCompaction: null,
				lastFallbackReason: null,
				lastInjectedEcho: null,
				lastCompactTime: 0,
				lastCompactTokens: 0,
				lastModelKey: null,
			});
			expect(saved).toMatchObject({ saved: true, issue: null });
			expect(inspected).toBeLessThan(20);
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			vi.resetModules();
		}
	});

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
				lastModelKey: null,
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

	it("reports successful quarantine even if the later no-follow open fails", async () => {
		const dir = makeTempDir();
		const filePath = path.join(dir, "telemetry.json");
		fs.writeFileSync(filePath, "{ invalid");
		const originalOpen = fs.promises.open.bind(fs.promises);
		vi.spyOn(fs.promises, "open").mockImplementation((target, flags, mode) => {
			if (typeof target === "string" && target.includes(".corrupt-")) {
				return Promise.reject(new Error("quarantine chmod denied"));
			}
			return originalOpen(target, flags, mode);
		});

		const result = await loadTelemetryWithDiagnostics({
			filePath,
			now: () => new Date("2026-05-21T10:00:00.000Z"),
		});
		const quarantinePath = `${filePath}.corrupt-2026-05-21T10-00-00-000Z`;
		expect(result.issue).toMatchObject({
			code: "corrupt-json",
			quarantinePath,
		});
		expect(result.issue?.message).toContain("was quarantined");
		expect(fs.existsSync(filePath)).toBe(false);
		expect(fs.readFileSync(quarantinePath, "utf8")).toBe("{ invalid");
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
				lastModelKey: null,
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

	it("saves telemetry through valid missing intermediate directories with restrictive permissions", async () => {
		const filePath = path.join(makeTempDir(), "new", "state", "telemetry.json");

		const result = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: "fallback",
				lastInjectedEcho: "echo",
				lastCompactTime: 123,
				lastCompactTokens: 456,
				lastModelKey: null,
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
			lastModelKey: null,
		});

		if (process.platform !== "win32") {
			expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
			expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
		}
	});

	it("uses atomic write (temp file + rename) and leaves no temp debris", async () => {
		const dir = makeTempDir();
		const filePath = path.join(dir, "telemetry.json");

		const result = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: "atomic",
				lastInjectedEcho: "echo",
				lastCompactTime: 1,
				lastCompactTokens: 2,
				lastModelKey: null,
			},
			{ filePath },
		);

		expect(result.saved).toBe(true);
		expect(fs.existsSync(filePath)).toBe(true);
		const files = fs.readdirSync(dir);
		const tempFiles = files.filter((f) => f.endsWith(".tmp"));
		expect(tempFiles).toHaveLength(0);
		expect(files).toContain("telemetry.json");
	});

	it("rejects loading through a symlinked telemetry file", async () => {
		if (process.platform === "win32") return;
		const dir = makeTempDir();
		const realFile = path.join(dir, "real-telemetry.json");
		const linkFile = path.join(dir, "telemetry.json");
		fs.writeFileSync(
			realFile,
			JSON.stringify({ version: 3, lastCompactTime: 100 }),
			"utf8",
		);
		fs.symlinkSync(realFile, linkFile);

		const result = await loadTelemetryWithDiagnostics({ filePath: linkFile });

		expect(result.telemetry).toBeNull();
		expect(result.issue).toMatchObject({
			operation: "load",
			code: "symlink-detected",
			path: linkFile,
		});
		expect(result.issue?.message).toContain("symlink detected");
	});

	it("rejects loading through a symlinked parent directory", async () => {
		if (process.platform === "win32") return;
		const dir = makeTempDir();
		const realDir = path.join(dir, "real-state");
		const linkDir = path.join(dir, "state");
		fs.mkdirSync(realDir);
		fs.writeFileSync(
			path.join(realDir, "telemetry.json"),
			JSON.stringify({ version: 3, lastCompactTime: 100 }),
			"utf8",
		);
		fs.symlinkSync(realDir, linkDir);
		const filePath = path.join(linkDir, "telemetry.json");

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toBeNull();
		expect(result.issue).toMatchObject({
			operation: "load",
			code: "symlink-detected",
			path: filePath,
		});
	});

	it("rejects a distant symlink above an existing immediate parent without touching outside telemetry", async () => {
		if (process.platform === "win32") return;
		const dir = makeTempDir();
		const outside = path.join(dir, "outside");
		const inside = path.join(dir, "inside");
		fs.mkdirSync(path.join(outside, "state"), { recursive: true });
		fs.mkdirSync(inside);
		fs.symlinkSync(outside, path.join(inside, "redirect"));
		const outsideFile = path.join(outside, "state", "telemetry.json");
		const original = JSON.stringify({ version: 3, lastCompactTime: 12 });
		fs.writeFileSync(outsideFile, original);
		const filePath = path.join(inside, "redirect", "state", "telemetry.json");

		const loaded = await loadTelemetryWithDiagnostics({ filePath });
		expect(loaded.telemetry).toBeNull();
		expect(loaded.issue?.code).toBe("symlink-detected");

		const saved = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: null,
				lastInjectedEcho: null,
				lastCompactTime: 0,
				lastCompactTokens: 0,
				lastModelKey: null,
			},
			{ filePath },
		);
		expect(saved.saved).toBe(false);
		expect(saved.issue?.code).toBe("symlink-detected");
		expect(fs.readFileSync(outsideFile, "utf8")).toBe(original);
		expect(fs.readdirSync(path.join(outside, "state"))).toEqual([
			"telemetry.json",
		]);
	});

	it("rejects distant symlinks even when intermediate directories are missing", async () => {
		if (process.platform === "win32") return;
		const dir = makeTempDir();
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		const redirect = path.join(dir, "redirect");
		fs.symlinkSync(outside, redirect);
		const filePath = path.join(redirect, "new", "state", "telemetry.json");

		const result = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: null,
				lastInjectedEcho: null,
				lastCompactTime: 0,
				lastCompactTokens: 0,
				lastModelKey: null,
			},
			{ filePath },
		);
		expect(result).toMatchObject({
			saved: false,
			issue: { code: "symlink-detected" },
		});
		expect(fs.readdirSync(outside)).toEqual([]);
	});

	it("rejects a leaf swapped to a symlink immediately before opening for read", async () => {
		if (process.platform === "win32") return;
		const dir = makeTempDir();
		const filePath = path.join(dir, "telemetry.json");
		const outside = path.join(dir, "outside.json");
		fs.writeFileSync(filePath, "{}");
		fs.writeFileSync(outside, JSON.stringify({ version: 3 }));
		const originalOpen = fs.promises.open.bind(fs.promises);
		vi.spyOn(fs.promises, "open").mockImplementation((target, flags, mode) => {
			fs.unlinkSync(filePath);
			fs.symlinkSync(outside, filePath);
			return originalOpen(target, flags, mode);
		});

		const result = await loadTelemetryWithDiagnostics({ filePath });
		expect(result.telemetry).toBeNull();
		expect(result.issue?.code).toBe("symlink-detected");
		expect(fs.readFileSync(outside, "utf8")).toBe(
			JSON.stringify({ version: 3 }),
		);
	});

	it("rejects a leaf swapped before temp creation without touching outside data", async () => {
		if (process.platform === "win32") return;
		const dir = makeTempDir();
		const filePath = path.join(dir, "telemetry.json");
		const outside = path.join(dir, "outside.json");
		fs.writeFileSync(filePath, "original");
		fs.writeFileSync(outside, "outside");
		const originalOpen = fs.promises.open.bind(fs.promises);
		vi.spyOn(fs.promises, "open").mockImplementation((target, flags, mode) => {
			if (typeof target === "string" && target.includes(".tmp-")) {
				fs.unlinkSync(filePath);
				fs.symlinkSync(outside, filePath);
			}
			return originalOpen(target, flags, mode);
		});

		const result = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: null,
				lastInjectedEcho: null,
				lastCompactTime: 0,
				lastCompactTokens: 0,
				lastModelKey: null,
			},
			{ filePath },
		);
		expect(result).toMatchObject({
			saved: false,
			issue: { code: "symlink-detected" },
		});
		expect(fs.readFileSync(outside, "utf8")).toBe("outside");
		expect(fs.readdirSync(dir).sort()).toEqual([
			"outside.json",
			"telemetry.json",
		]);
	});

	it("rejects unnormalized traversal paths without modifying the target", async () => {
		const dir = makeTempDir();
		fs.mkdirSync(path.join(dir, "state"));
		const outside = path.join(dir, "outside.json");
		fs.writeFileSync(outside, "original");
		const filePath = `${dir}/state/../outside.json`;

		const loaded = await loadTelemetryWithDiagnostics({ filePath });
		expect(loaded).toMatchObject({
			telemetry: null,
			issue: { code: "read-failed" },
		});
		const saved = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: null,
				lastInjectedEcho: null,
				lastCompactTime: 0,
				lastCompactTokens: 0,
				lastModelKey: null,
			},
			{ filePath },
		);
		expect(saved).toMatchObject({
			saved: false,
			issue: { code: "write-failed" },
		});
		expect(fs.readFileSync(outside, "utf8")).toBe("original");
	});

	it("preserves existing telemetry and removes its temp file if rename fails", async () => {
		const dir = makeTempDir();
		const filePath = path.join(dir, "telemetry.json");
		fs.writeFileSync(filePath, "original");
		vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(
			new Error("rename denied"),
		);

		const result = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: null,
				lastInjectedEcho: null,
				lastCompactTime: 0,
				lastCompactTokens: 0,
				lastModelKey: null,
			},
			{ filePath },
		);
		expect(result).toMatchObject({
			saved: false,
			issue: { code: "write-failed" },
		});
		expect(fs.readFileSync(filePath, "utf8")).toBe("original");
		expect(fs.readdirSync(dir)).toEqual(["telemetry.json"]);
	});

	it("rejects saving through a symlinked telemetry file", async () => {
		if (process.platform === "win32") return;
		const dir = makeTempDir();
		const realFile = path.join(dir, "real-telemetry.json");
		const linkFile = path.join(dir, "telemetry.json");
		fs.writeFileSync(realFile, "{}", "utf8");
		fs.symlinkSync(realFile, linkFile);

		const result = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: null,
				lastInjectedEcho: null,
				lastCompactTime: 0,
				lastCompactTokens: 0,
				lastModelKey: null,
			},
			{ filePath: linkFile },
		);

		expect(result.saved).toBe(false);
		expect(result.issue).toMatchObject({
			operation: "save",
			code: "symlink-detected",
			path: linkFile,
		});
	});

	it("rejects saving through a symlinked parent directory", async () => {
		if (process.platform === "win32") return;
		const dir = makeTempDir();
		const realDir = path.join(dir, "real-state");
		const linkDir = path.join(dir, "state");
		fs.mkdirSync(realDir);
		fs.symlinkSync(realDir, linkDir);
		const filePath = path.join(linkDir, "telemetry.json");

		const result = await saveTelemetryWithDiagnostics(
			{
				lastCompaction: null,
				lastFallbackReason: null,
				lastInjectedEcho: null,
				lastCompactTime: 0,
				lastCompactTokens: 0,
				lastModelKey: null,
			},
			{ filePath },
		);

		expect(result.saved).toBe(false);
		expect(result.issue).toMatchObject({
			operation: "save",
			code: "symlink-detected",
			path: filePath,
		});
	});

	it("hardens an existing write-only state directory before saving", async () => {
		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const dir = makeTempDir();
		const state = path.join(dir, "state");
		fs.mkdirSync(state);
		fs.chmodSync(state, 0o300);
		try {
			const filePath = path.join(state, "telemetry.json");
			const result = await saveTelemetryWithDiagnostics(
				{
					lastCompaction: null,
					lastFallbackReason: null,
					lastInjectedEcho: null,
					lastCompactTime: 0,
					lastCompactTokens: 0,
					lastModelKey: null,
				},
				{ filePath },
			);
			expect(result).toMatchObject({ saved: true, issue: null });
			expect(fs.statSync(state).mode & 0o777).toBe(0o700);
			expect(fs.existsSync(filePath)).toBe(true);
		} finally {
			fs.chmodSync(state, 0o700);
		}
	});

	it("reports write-failed when parent directory is read-only", async () => {
		if (process.platform === "win32") return;
		const dir = makeTempDir();
		const filePath = path.join(dir, "state", "telemetry.json");
		fs.chmodSync(dir, 0o500);
		try {
			const result = await saveTelemetryWithDiagnostics(
				{
					lastCompaction: null,
					lastFallbackReason: null,
					lastInjectedEcho: null,
					lastCompactTime: 0,
					lastCompactTokens: 0,
					lastModelKey: null,
				},
				{ filePath },
			);

			expect(result.saved).toBe(false);
			expect(result.issue).toMatchObject({
				operation: "save",
				code: "write-failed",
				path: path.join(dir, "state"),
			});
		} finally {
			fs.chmodSync(dir, 0o700);
		}
	});
});

describe("Persisted telemetry schema validation", () => {
	it("returns invalid-schema when root is not an object", async () => {
		for (const payload of ["null", "5", '"hello"', "[]"]) {
			const filePath = path.join(makeTempDir(), `telemetry-${payload[0]}.json`);
			fs.writeFileSync(filePath, payload, "utf8");

			const result = await loadTelemetryWithDiagnostics({ filePath });

			expect(result.telemetry).toBeNull();
			expect(result.issue).toMatchObject({
				operation: "load",
				code: "invalid-schema",
				path: filePath,
			});
			expect(result.issue?.message).toContain("root is not an object");
		}
	});

	it("coerces malformed lastCompactTime and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompactTime: "yesterday",
				lastCompactTokens: 100,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompactTime: 0,
			lastCompactTokens: 100,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompactTime");
	});

	it("coerces malformed lastCompactTokens and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompactTime: 50,
				lastCompactTokens: NaN,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompactTime: 50,
			lastCompactTokens: 0,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompactTokens");
	});

	it("coerces Infinity timestamp to 0 and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompactTime: Infinity,
				lastCompactTokens: -Infinity,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompactTime: 0,
			lastCompactTokens: 0,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompactTime");
		expect(result.issue?.message).toContain("lastCompactTokens");
	});

	it("coerces malformed lastFallbackReason and lastInjectedEcho to null", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastFallbackReason: 123,
				lastInjectedEcho: { text: "echo" },
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastFallbackReason: null,
			lastInjectedEcho: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastFallbackReason");
		expect(result.issue?.message).toContain("lastInjectedEcho");
	});

	it("coerces malformed lastModelKey to null and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastModelKey: 123,
				lastCompactTime: 100,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastModelKey: null,
			lastCompactTime: 100,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastModelKey");
	});

	it("loads valid lastModelKey without issues", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastModelKey: "anthropic/claude-4",
				lastCompactTime: 100,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastModelKey: "anthropic/claude-4",
			lastCompactTime: 100,
			version: 3,
		});
		expect(result.issue).toBeNull();
	});

	it("drops malformed lastCompaction string and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompaction: "not-an-object",
				lastCompactTime: 100,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			lastCompactTime: 100,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompaction");
	});

	it("drops lastCompaction with missing required field and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompaction: {
					mode: "standard",
					// missing triggerSource, triggerReason, timestamp, etc.
				},
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompaction");
	});

	it("drops lastCompaction with invalid focusTags and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const badCompaction = {
			mode: "standard",
			triggerSource: "turn_end",
			triggerReason: "threshold",
			timestamp: Date.now(),
			focusTags: ["file.ts", 123, null],
			previousSummaryPresent: false,
			splitTurn: false,
			usageSource: "native",
			messagesSummarizedCount: 5,
			executionPath: "custom",
			fromExtension: true,
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction: badCompaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompaction");
	});

	it("drops lastCompaction with non-array focusTags and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const badCompaction = {
			mode: "hard",
			triggerSource: "command",
			triggerReason: "manual",
			timestamp: Date.now(),
			focusTags: "not-an-array",
			previousSummaryPresent: true,
			splitTurn: false,
			usageSource: "estimated",
			messagesSummarizedCount: 10,
			executionPath: "native-fallback",
			fromExtension: false,
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction: badCompaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
	});

	it("loads valid full CompactionTelemetry without issues", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const compaction = {
			mode: "standard",
			triggerSource: "turn_end",
			triggerReason: "auto at threshold",
			timestamp: 1_234_567_890,
			focusTags: ["src/index.ts"],
			previousSummaryPresent: true,
			splitTurn: false,
			usageSource: "native",
			messagesSummarizedCount: 8,
			classifiedCounts: {
				critical: 2,
				contextual: 3,
				ephemeral: 3,
			},
			usagePercentAtTrigger: 75.5,
			usageTokensAtTrigger: 8000,
			executionPath: "custom",
			fromExtension: true,
			thinkingLevel: "high",
			compatibilityReason: null,
			fallbackReason: "none",
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompaction: compaction,
				lastFallbackReason: "fallback",
				lastInjectedEcho: "echo",
				lastCompactTime: 1_234_567_890,
				lastCompactTokens: 8000,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.issue).toBeNull();
		expect(result.telemetry).toEqual({
			version: 3,
			lastCompaction: compaction,
			lastFallbackReason: "fallback",
			lastInjectedEcho: "echo",
			lastCompactTime: 1_234_567_890,
			lastCompactTokens: 8000,
			lastModelKey: null,
		});
	});

	it("coerces partial invalid fields while preserving valid ones", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const compaction = {
			mode: "hard",
			triggerSource: "command",
			triggerReason: "manual",
			timestamp: 999,
			focusTags: [],
			previousSummaryPresent: false,
			splitTurn: true,
			usageSource: "unknown",
			messagesSummarizedCount: 0,
			executionPath: "native-fallback",
			fromExtension: false,
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompaction: compaction,
				lastCompactTime: 123,
				lastCompactTokens: "many",
				lastFallbackReason: "ok",
				lastInjectedEcho: 42,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toEqual({
			version: 3,
			lastCompaction: compaction,
			lastCompactTime: 123,
			lastCompactTokens: 0,
			lastFallbackReason: "ok",
			lastInjectedEcho: null,
			lastModelKey: null,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompactTokens");
		expect(result.issue?.message).toContain("lastInjectedEcho");
	});

	it("does not crash status when built from coerced invalid-schema telemetry", async () => {
		const { buildStatusSnapshot } = await import("../src/policy.js");

		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompaction: {
					mode: "standard",
					triggerSource: "turn_end",
					triggerReason: "test",
					timestamp: Date.now(),
					focusTags: ["a.ts", 123],
					previousSummaryPresent: false,
					splitTurn: false,
					usageSource: "native",
					messagesSummarizedCount: 1,
					executionPath: "custom",
					fromExtension: true,
				},
				lastInjectedEcho: { not: "a string" },
				lastCompactTime: "now",
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });
		expect(result.telemetry).not.toBeNull();
		if (!result.telemetry) throw new Error("expected coerced telemetry");

		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});

		// Build status from coerced telemetry — must not throw
		const status = buildStatusSnapshot({
			usage: null,
			selectedMode: null,
			isCompacting: false,
			lastCompactTime: result.telemetry.lastCompactTime,
			lastCompaction: result.telemetry.lastCompaction,
			lastFallbackReason: result.telemetry.lastFallbackReason,
			lastInjectedEcho: result.telemetry.lastInjectedEcho,
			telemetryPersistenceIssues: result.issue ? [result.issue] : [],
		});

		expect(status.lastCompaction).toBeNull();
		expect(status.lastInjectedEcho).toBeNull();
		expect(status.telemetryPersistenceIssues.length).toBe(1);
		expect(status.telemetryPersistenceIssues[0].code).toBe("invalid-schema");
	});

	it("coerces far-future lastCompactTime to 0 and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompactTime: 253_402_300_799_000,
				lastCompactTokens: 100,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompactTime: 0,
			lastCompactTokens: 100,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompactTime");
	});

	it("coerces huge lastCompactTokens to 0 and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompactTime: 100,
				lastCompactTokens: 9_007_199_254_740_991,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompactTime: 100,
			lastCompactTokens: 0,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompactTokens");
	});

	it("coerces negative lastCompactTokens to 0 and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompactTime: 100,
				lastCompactTokens: -50,
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompactTime: 100,
			lastCompactTokens: 0,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompactTokens");
	});

	it("drops lastCompaction with far-future timestamp and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const badCompaction = {
			mode: "standard",
			triggerSource: "turn_end",
			triggerReason: "threshold",
			timestamp: 253_402_300_799_000,
			focusTags: [],
			previousSummaryPresent: false,
			splitTurn: false,
			usageSource: "native",
			messagesSummarizedCount: 5,
			executionPath: "custom",
			fromExtension: true,
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction: badCompaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompaction");
	});

	it("drops lastCompaction with negative messagesSummarizedCount and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const badCompaction = {
			mode: "hard",
			triggerSource: "command",
			triggerReason: "manual",
			timestamp: Date.now(),
			focusTags: [],
			previousSummaryPresent: true,
			splitTurn: false,
			usageSource: "estimated",
			messagesSummarizedCount: -1,
			executionPath: "native-fallback",
			fromExtension: false,
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction: badCompaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompaction");
	});

	it("drops lastCompaction with huge usageTokensAtTrigger and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const badCompaction = {
			mode: "standard",
			triggerSource: "turn_end",
			triggerReason: "auto",
			timestamp: Date.now(),
			focusTags: ["a.ts"],
			previousSummaryPresent: false,
			splitTurn: false,
			usageSource: "native",
			messagesSummarizedCount: 5,
			usageTokensAtTrigger: 9_007_199_254_740_991,
			executionPath: "custom",
			fromExtension: true,
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction: badCompaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompaction");
	});

	it("drops lastCompaction with negative usagePercentAtTrigger and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const badCompaction = {
			mode: "standard",
			triggerSource: "turn_end",
			triggerReason: "auto",
			timestamp: Date.now(),
			focusTags: ["a.ts"],
			previousSummaryPresent: false,
			splitTurn: false,
			usageSource: "native",
			messagesSummarizedCount: 5,
			usagePercentAtTrigger: -5,
			executionPath: "custom",
			fromExtension: true,
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction: badCompaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompaction");
	});

	it("drops lastCompaction with excessive usagePercentAtTrigger and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const badCompaction = {
			mode: "standard",
			triggerSource: "turn_end",
			triggerReason: "auto",
			timestamp: Date.now(),
			focusTags: ["a.ts"],
			previousSummaryPresent: false,
			splitTurn: false,
			usageSource: "native",
			messagesSummarizedCount: 5,
			usagePercentAtTrigger: 5000,
			executionPath: "custom",
			fromExtension: true,
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction: badCompaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompaction");
	});

	it("drops lastCompaction with negative classifiedCounts and reports invalid-schema", async () => {
		const filePath = path.join(makeTempDir(), "telemetry.json");
		const badCompaction = {
			mode: "standard",
			triggerSource: "turn_end",
			triggerReason: "auto",
			timestamp: Date.now(),
			focusTags: ["a.ts"],
			previousSummaryPresent: false,
			splitTurn: false,
			usageSource: "native",
			messagesSummarizedCount: 5,
			classifiedCounts: {
				critical: -1,
				contextual: 2,
				ephemeral: 1,
			},
			executionPath: "custom",
			fromExtension: true,
		};
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction: badCompaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry).toMatchObject({
			lastCompaction: null,
			version: 3,
		});
		expect(result.issue).toMatchObject({
			code: "invalid-schema",
		});
		expect(result.issue?.message).toContain("lastCompaction");
	});
});

function makeValidCompaction(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		mode: "standard",
		triggerSource: "turn_end",
		triggerReason: "threshold",
		timestamp: 1_000,
		focusTags: ["src/index.ts"],
		previousSummaryPresent: false,
		splitTurn: false,
		usageSource: "native",
		messagesSummarizedCount: 1,
		executionPath: "custom",
		fromExtension: true,
		...overrides,
	};
}

it("accepts every required CompactionTelemetry enum variant", async () => {
	const variants = [
		{ mode: "hard" },
		{ triggerSource: "message_end" },
		{ triggerSource: "command" },
		{ usageSource: "estimated" },
		{ usageSource: "unknown" },
		{ executionPath: "native-fallback" },
	];

	for (const [index, overrides] of variants.entries()) {
		const filePath = path.join(makeTempDir(), `enum-${index}.json`);
		const compaction = makeValidCompaction(overrides);
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction: compaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.issue).toBeNull();
		expect(result.telemetry?.lastCompaction).toEqual(compaction);
	}
});

it("rejects invalid required CompactionTelemetry fields", async () => {
	const invalidRequired: Record<string, unknown>[] = [
		{ mode: "soft" },
		{ triggerSource: "timer" },
		{ triggerReason: 1 },
		{ timestamp: -1 },
		{ focusTags: ["valid", 1] },
		{ previousSummaryPresent: "false" },
		{ splitTurn: 0 },
		{ usageSource: "measured" },
		{ messagesSummarizedCount: -1 },
		{ executionPath: "other" },
		{ fromExtension: 1 },
	];

	for (const [index, required] of invalidRequired.entries()) {
		const filePath = path.join(makeTempDir(), `required-invalid-${index}.json`);
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompaction: makeValidCompaction(required),
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry?.lastCompaction).toBeNull();
		expect(result.issue).toMatchObject({ code: "invalid-schema" });
	}
});

it("treats explicit null CompactionTelemetry as absent", async () => {
	const filePath = path.join(makeTempDir(), "null-compaction.json");
	fs.writeFileSync(
		filePath,
		JSON.stringify({
			version: 3,
			lastCompaction: null,
			lastCompactTime: 100,
		}),
		"utf8",
	);

	const result = await loadTelemetryWithDiagnostics({ filePath });

	expect(result.issue).toBeNull();
	expect(result.telemetry).toMatchObject({
		lastCompaction: null,
		lastCompactTime: 100,
	});
});

it("rejects non-object CompactionTelemetry values", async () => {
	for (const [index, lastCompaction] of [false, 0, "invalid", []].entries()) {
		const filePath = path.join(makeTempDir(), `non-object-${index}.json`);
		fs.writeFileSync(
			filePath,
			JSON.stringify({ version: 3, lastCompaction }),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry?.lastCompaction).toBeNull();
		expect(result.issue).toMatchObject({ code: "invalid-schema" });
	}
});

it("rejects invalid optional CompactionTelemetry fields", async () => {
	const invalidOptionals: Record<string, unknown>[] = [
		{ fallbackReason: null },
		{ classifiedCounts: null },
		{ classifiedCounts: [] },
		{ classifiedCounts: "invalid" },
		{ classifiedCounts: { critical: 1, contextual: 1 } },
		{ usagePercentAtTrigger: "50" },
		{ usageTokensAtTrigger: -1 },
		{ thinkingLevel: 1 },
		{ compatibilityReason: false },
	];

	for (const [index, optional] of invalidOptionals.entries()) {
		const filePath = path.join(makeTempDir(), `optional-invalid-${index}.json`);
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				version: 3,
				lastCompaction: makeValidCompaction(optional),
			}),
			"utf8",
		);

		const result = await loadTelemetryWithDiagnostics({ filePath });

		expect(result.telemetry?.lastCompaction).toBeNull();
		expect(result.issue).toMatchObject({ code: "invalid-schema" });
	}
});

it("preserves valid optional CompactionTelemetry boundary values", async () => {
	const filePath = path.join(makeTempDir(), "optional-boundaries.json");
	const compaction = makeValidCompaction({
		fallbackReason: "",
		classifiedCounts: { critical: 0, contextual: 0, ephemeral: 0 },
		usagePercentAtTrigger: 0,
		usageTokensAtTrigger: 0,
		thinkingLevel: null,
		compatibilityReason: "compatible",
	});
	fs.writeFileSync(
		filePath,
		JSON.stringify({ version: 3, lastCompaction: compaction }),
		"utf8",
	);

	const result = await loadTelemetryWithDiagnostics({ filePath });

	expect(result.issue).toBeNull();
	expect(result.telemetry?.lastCompaction).toEqual(compaction);
});
