import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { findInstalledPiRuntime } from "./fixtures/pi-runtime-discovery.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function installation(overrides: Record<string, unknown> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "compact-pi-runtime-"));
	directories.push(directory);
	const root = join(directory, "node_modules/@earendil-works/pi-coding-agent");
	const bin = join(directory, "bin");
	mkdirSync(join(root, "dist/bundle"), { recursive: true });
	mkdirSync(bin);
	writeFileSync(
		join(root, "dist/bundle/cli.js"),
		"// Fixture; never executed.\n",
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: "0.87.1",
			bin: { pi: "dist/bundle/cli.js" },
			...overrides,
		}),
	);
	symlinkSync(join(root, "dist/bundle/cli.js"), join(bin, "pi"));
	return { root: realpathSync(root), bin };
}

it("discovers a version-verified installed CLI without executing it", () => {
	const installed = installation();
	expect(findInstalledPiRuntime("0.87.1", installed.bin)).toBe(installed.root);
});

it.each([
	{ name: "unrelated-package" },
	{ version: "1.0.1" },
	{ bin: { pi: "../outside.js" } },
	{ bin: { pi: "/outside.js" } },
	{ bin: { pi: "dist/not-the-cli.js" } },
])("rejects mismatched package identity/version/bin: %j", (overrides) => {
	const installed = installation(overrides);
	expect(findInstalledPiRuntime("0.87.1", installed.bin)).toBeUndefined();
});

it("ignores relative, traversing, and missing PATH entries", () => {
	expect(findInstalledPiRuntime("0.87.1", "./bin")).toBeUndefined();
	const installed = installation();
	expect(
		findInstalledPiRuntime("0.87.1", `${installed.bin}/../bin`),
	).toBeUndefined();
	expect(findInstalledPiRuntime("0.87.1", "")).toBeUndefined();
});

it("continues past an unrelated CLI to a matching runtime", () => {
	const unrelated = installation({ name: "unrelated-package" });
	const installed = installation();
	expect(
		findInstalledPiRuntime(
			"0.87.1",
			[unrelated.bin, installed.bin].join(delimiter),
		),
	).toBe(installed.root);
});

it("rejects a symlinked package manifest", () => {
	const installed = installation();
	const path = join(installed.root, "package.json");
	rmSync(path);
	symlinkSync(join(installed.root, "dist/bundle/cli.js"), path);
	expect(findInstalledPiRuntime("0.87.1", installed.bin)).toBeUndefined();
});

it("rejects oversized discovery inputs/manifests", () => {
	expect(findInstalledPiRuntime("0.87.1", "x".repeat(65_537))).toBeUndefined();
	expect(
		findInstalledPiRuntime("0.87.1", Array(129).fill("/bin").join(delimiter)),
	).toBeUndefined();
	const installed = installation();
	writeFileSync(join(installed.root, "package.json"), " ".repeat(65_537));
	expect(findInstalledPiRuntime("0.87.1", installed.bin)).toBeUndefined();
});
