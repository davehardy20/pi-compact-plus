import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const lock = JSON.parse(
	readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
) as { packages: Record<string, { version?: string }> };

// These are the first releases outside the advisory ranges reported by npm
// audit for the locked dev tree. Pi's bundled undici needs an SDK upgrade.
const patched = [
	["esbuild", [0, 28, 1]],
	["nanoid", [3, 3, 18]],
	["postcss", [8, 5, 23]],
] as const;

type LockedPackage = { version?: string };

function lockedCopies(packages: Record<string, LockedPackage>, name: string) {
	return Object.entries(packages).filter(
		([path]) =>
			path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
	);
}

function expectPatchedCopies(
	packages: Record<string, LockedPackage>,
	name: string,
	minimum: readonly [number, number, number],
) {
	const copies = lockedCopies(packages, name);
	expect(copies.length, `no locked ${name} copies`).toBeGreaterThan(0);
	for (const [path, { version }] of copies) {
		expect(version, path).toMatch(/^\d+\.\d+\.\d+$/);
		const parts = (version as string).split(".").map(Number);
		const meetsMinimum =
			parts[0] > minimum[0] ||
			(parts[0] === minimum[0] &&
				(parts[1] > minimum[1] ||
					(parts[1] === minimum[1] && parts[2] >= minimum[2])));
		const label = `${path}@${version} is below the patched minimum`;
		expect(meetsMinimum, label).toBe(true);
	}
}

it("rejects a vulnerable nested copy, not similarly named packages", () => {
	const packages = {
		"node_modules/nanoid": { version: "3.3.19" },
		"node_modules/example/node_modules/nanoid": { version: "3.3.12" },
		"node_modules/example-nanoid": { version: "0.0.1" },
	};
	expect(lockedCopies(packages, "nanoid")).toHaveLength(2);
	expect(() => expectPatchedCopies(packages, "nanoid", [3, 3, 18])).toThrow(
		"below the patched minimum",
	);
});

it.each(patched)("locks patched %s copies at every depth", (name, minimum) => {
	expectPatchedCopies(lock.packages, name, minimum);
});
