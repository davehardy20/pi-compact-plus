import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createPackageMetadataResolver } from "../src/package-metadata.js";

const tempRoots: string[] = [];

function makePackageRoot(packageJson?: Record<string, unknown>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "compact-plus-metadata-"));
	tempRoots.push(root);
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	if (packageJson) {
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify(packageJson),
			"utf8",
		);
	}
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("createPackageMetadataResolver", () => {
	it("reports metadata relative to the extension entrypoint URL", () => {
		const root = makePackageRoot({
			name: "@example/compact-plus-test",
			version: "9.8.7",
		});
		const entrypointPath = path.join(root, "src", "index.ts");
		const resolver = createPackageMetadataResolver(
			pathToFileURL(entrypointPath).href,
		);

		expect(resolver()).toEqual({
			name: "@example/compact-plus-test",
			version: "9.8.7",
			packageRoot: root,
			sourcePath: entrypointPath,
		});
	});

	it("falls back to default metadata when package.json cannot be read", () => {
		const root = makePackageRoot();
		const entrypointPath = path.join(root, "src", "index.ts");
		const resolver = createPackageMetadataResolver(
			pathToFileURL(entrypointPath).href,
		);

		expect(resolver()).toEqual({
			name: "pi-compact-plus",
			version: "0.1.0",
			packageRoot: root,
			sourcePath: entrypointPath,
		});
	});

	it("caches the package read result", () => {
		const root = makePackageRoot({ name: "first", version: "1.0.0" });
		const entrypointPath = path.join(root, "src", "index.ts");
		const resolver = createPackageMetadataResolver(
			pathToFileURL(entrypointPath).href,
		);

		expect(resolver().name).toBe("first");
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ name: "second", version: "2.0.0" }),
			"utf8",
		);

		expect(resolver().name).toBe("first");
		expect(resolver().version).toBe("1.0.0");
	});
});
