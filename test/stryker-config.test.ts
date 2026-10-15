import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Json = Record<string, unknown>;
type Thresholds = { break: number; low: number; high: number };

function readJson(path: URL | string): Json {
	return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function schemaProperties(path: URL): string[] {
	const schema = readJson(path) as { properties?: Record<string, unknown> };
	return Object.keys(schema.properties ?? {});
}

const configPath = new URL("../stryker.config.json", import.meta.url);
const coreSchemaPath = new URL(
	"../node_modules/@stryker-mutator/api/dist/schema/stryker-core.json",
	import.meta.url,
);
const vitestSchemaPath = new URL(
	"../node_modules/@stryker-mutator/vitest-runner/dist/schema/vitest-runner-options.json",
	import.meta.url,
);

describe("stryker mutation config", () => {
	it("only uses options the installed Stryker schema knows", () => {
		// Stryker 10 renamed the score floor to thresholds.break. A stale key such as
		// breakAt fails validation before any mutant runs, so keep this guard live.
		const allowed = new Set([
			...schemaProperties(coreSchemaPath),
			...schemaProperties(vitestSchemaPath),
		]);
		const keys = Object.keys(readJson(configPath));
		const unknown = keys.filter((key) => !allowed.has(key));

		expect(unknown).toEqual([]);
	});

	it("keeps the score floor above zero and below the top color band", () => {
		const thresholds = readJson(configPath).thresholds as Thresholds;

		expect(typeof thresholds.break).toBe("number");
		expect(thresholds.break).toBeGreaterThan(0);
		expect(thresholds.break).toBeLessThan(thresholds.high);
		expect(thresholds.high).toBeGreaterThan(thresholds.low);
	});

	it("mutates source files only", () => {
		expect(readJson(configPath).mutate).toEqual(["src/**/*.ts"]);
	});

	it("pins the Stryker runners to exact versions and exposes the script", () => {
		const pkg = readJson(new URL("../package.json", import.meta.url));
		const devDeps = pkg.devDependencies as Record<string, string>;
		const scripts = pkg.scripts as Record<string, string>;
		const exactPin = /^\d+\.\d+\.\d+$/;

		expect(devDeps["@stryker-mutator/core"]).toMatch(exactPin);
		expect(devDeps["@stryker-mutator/vitest-runner"]).toMatch(exactPin);
		expect(scripts.mutation).toBe("stryker run");
	});

	it("keeps mutation artifacts out of git", () => {
		const ignorePath = new URL("../.gitignore", import.meta.url);
		const gitignore = readFileSync(ignorePath, "utf8");
		const lines = gitignore.split("\n").map((line) => line.trim());

		expect(lines).toContain("reports/");
		expect(lines).toContain(".stryker-tmp/");
	});
});
