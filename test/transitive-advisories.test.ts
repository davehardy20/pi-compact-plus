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

it.each(patched)("locks a patched %s version", (name, minimum) => {
	const version = lock.packages[`node_modules/${name}`]?.version;
	expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
	const parts = (version as string).split(".").map(Number);
	const meetsMinimum =
		parts[0] > minimum[0] ||
		(parts[0] === minimum[0] &&
			(parts[1] > minimum[1] ||
				(parts[1] === minimum[1] && parts[2] >= minimum[2])));
	expect(meetsMinimum, `${name}@${version} is below the patched minimum`).toBe(
		true,
	);
});
