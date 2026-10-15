import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Json = Record<string, unknown>;
type SchemaNode = {
	$ref?: string;
	type?: string | string[];
	properties?: Record<string, SchemaNode>;
	definitions?: Record<string, SchemaNode>;
	additionalProperties?: boolean | SchemaNode;
	oneOf?: SchemaNode[];
	items?: SchemaNode;
};
type Schema = {
	properties?: Record<string, SchemaNode>;
	definitions?: Record<string, SchemaNode>;
};
type Thresholds = { break: number; low: number; high: number };

function readJson(path: URL | string): Json {
	return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function readSchema(path: URL, hint: string): Schema {
	if (!existsSync(path)) {
		throw new Error(`${hint} is missing. Run npm ci: ${path.pathname}`);
	}
	return readJson(path) as Schema;
}

/** Merged core + runner options, so plugin keys are validated too. */
function mergedSchema(): { root: SchemaNode } {
	const core = readSchema(coreSchemaPath, "Stryker core schema");
	const runner = readSchema(vitestSchemaPath, "Stryker vitest runner schema");
	return {
		root: {
			properties: { ...(core.properties ?? {}), ...(runner.properties ?? {}) },
			definitions: core.definitions ?? {},
		},
	};
}

function resolveRef(node: SchemaNode, root: SchemaNode, depth = 0): SchemaNode {
	if (!node.$ref || depth > 10) return node;
	const segments = node.$ref.replace(/^#\//, "").split("/");
	let target: unknown = root;
	for (const segment of segments) {
		target = (target as Record<string, unknown>)?.[segment];
	}
	return resolveRef((target ?? {}) as SchemaNode, root, depth + 1);
}

function declaredTypes(node: SchemaNode): string[] {
	if (!node.type) return [];
	return Array.isArray(node.type) ? node.type : [node.type];
}

function matchesScalar(value: unknown, types: string[]): boolean {
	if (value === null) return types.includes("null");
	if (Array.isArray(value)) return types.includes("array");
	return types.some((type) => typeof value === type);
}

/** Reports config keys or value shapes the installed Stryker schemas do not allow. */
function schemaIssues(
	value: unknown,
	rawNode: SchemaNode,
	root: SchemaNode,
	path: string,
): string[] {
	const node = resolveRef(rawNode, root, 0);
	const issues: string[] = [];

	if (node.oneOf) {
		const matched = node.oneOf.some(
			(branch) => schemaIssues(value, branch, root, path).length === 0,
		);
		return matched ? issues : [`${path}: no schema branch matches the value`];
	}

	const types = declaredTypes(node);
	if (types.length > 0 && !matchesScalar(value, types)) {
		return [`${path}: expected ${types.join(" | ")}`];
	}

	if (value === null || typeof value !== "object") return issues;

	if (Array.isArray(value)) {
		if (!node.items) return issues;
		const items = node.items;
		value.forEach((item, index) => {
			const itemPath = `${path}[${index}]`;
			issues.push(...schemaIssues(item, items, root, itemPath));
		});
		return issues;
	}

	const entries = Object.entries(value as Json);
	const properties = node.properties ?? {};
	for (const [key, child] of entries) {
		const childPath = path ? `${path}.${key}` : key;
		const childNode = properties[key];
		if (!childNode) {
			if (node.additionalProperties === false) {
				issues.push(`${childPath}: unknown option`);
			} else if (typeof node.additionalProperties === "object") {
				const extra = node.additionalProperties;
				issues.push(...schemaIssues(child, extra, root, childPath));
			}
			continue;
		}
		issues.push(...schemaIssues(child, childNode, root, childPath));
	}
	return issues;
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
	it("only uses options the installed Stryker schemas know", () => {
		// Stryker 10 renamed the score floor to thresholds.break. A stale key such as
		// breakAt fails validation before any mutant runs, so keep this guard live.
		const { root } = mergedSchema();
		const allowed = new Set(Object.keys(root.properties ?? {}));
		const keys = Object.keys(readJson(configPath));
		const unknown = keys.filter((key) => !allowed.has(key));

		expect(unknown).toEqual([]);
	});

	it("matches the installed Stryker schemas at every nesting level", () => {
		const { root } = mergedSchema();

		expect(schemaIssues(readJson(configPath), root, root, "")).toEqual([]);
	});

	it("catches a misspelled nested reporter option", () => {
		const { root } = mergedSchema();
		const broken = { ...readJson(configPath), htmlReporter: { filename: "x" } };

		expect(schemaIssues(broken, root, root, "")).toEqual([
			"htmlReporter.filename: unknown option",
		]);
	});

	it("catches a wrong value type inside thresholds", () => {
		const { root } = mergedSchema();
		const config = readJson(configPath);
		const thresholds = config.thresholds as Record<string, unknown>;
		const broken = { ...config, thresholds: { ...thresholds, break: "62" } };

		const issues = schemaIssues(broken, root, root, "");
		const expected = "thresholds.break: no schema branch matches the value";

		expect(issues).toContain(expected);
	});

	it("keeps the score floor above zero and below the top color band", () => {
		const thresholds = readJson(configPath).thresholds as Thresholds;

		expect(typeof thresholds.break).toBe("number");
		expect(thresholds.break).toBeGreaterThan(0);
		expect(thresholds.break).toBeLessThan(thresholds.high);
		expect(thresholds.high).toBeGreaterThan(thresholds.low);
	});

	it("mutates source files only and runs the vitest runner", () => {
		const config = readJson(configPath);

		expect(config.mutate).toEqual(["src/**/*.ts"]);
		expect(config.testRunner).toBe("vitest");
		expect(config.coverageAnalysis).toBe("off");
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
