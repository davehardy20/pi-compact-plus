import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";

type Json = Record<string, unknown>;
type SchemaNode = {
	$ref?: string;
	type?: string | string[];
	properties?: Record<string, SchemaNode>;
	definitions?: Record<string, SchemaNode>;
	$defs?: Record<string, SchemaNode>;
	additionalProperties?: boolean | SchemaNode;
	oneOf?: SchemaNode[];
	anyOf?: SchemaNode[];
	items?: SchemaNode;
	enum?: unknown[];
	pattern?: string;
	minimum?: number;
	maximum?: number;
};
type Thresholds = { break: number; low: number; high: number };

function readJson(path: URL | string): Json {
	return JSON.parse(readFileSync(path, "utf8")) as Json;
}

function readSchema(path: URL, hint: string): SchemaNode {
	if (!existsSync(path)) {
		throw new Error(`${hint} is missing. Run npm ci first: ${path.pathname}`);
	}
	return readJson(path) as SchemaNode;
}

const configPath = new URL("../stryker.config.json", import.meta.url);
const baselineFile = "./fixtures/mutation-baseline.json";
const baselinePath = new URL(baselineFile, import.meta.url);
const coreSchemaPath = new URL(
	"../node_modules/@stryker-mutator/api/dist/schema/stryker-core.json",
	import.meta.url,
);
const vitestSchemaPath = new URL(
	"../node_modules/@stryker-mutator/vitest-runner/dist/schema/vitest-runner-options.json",
	import.meta.url,
);

/** Merged core + runner options, so plugin keys are validated too. */
function mergedSchema(): SchemaNode {
	const core = readSchema(coreSchemaPath, "Stryker core schema");
	const runner = readSchema(vitestSchemaPath, "Stryker vitest runner schema");

	// Both `definitions` (draft-07) and `$defs` (2019-09) may appear in a Stryker schema,
	// and each package may carry its own. Merging only the core `definitions` would silently
	// drop a runner-local or `$defs` reference target if a schema moves to the newer keyword.
	// Core and runner names share one namespace, so a runner definition can shadow a
	// same-named core definition; the runner spread wins because it is applied last.
	return {
		properties: { ...(core.properties ?? {}), ...(runner.properties ?? {}) },
		definitions: { ...(core.definitions ?? {}), ...(runner.definitions ?? {}) },
		$defs: { ...(core.$defs ?? {}), ...(runner.$defs ?? {}) },
	};
}

/**
 * Resolves a local JSON-Schema reference, failing closed: an unresolvable `$ref` is
 * reported as an issue instead of collapsing to an empty node that validates anything.
 *
 * Supported grammar is deliberately narrow, matching what the pinned Stryker schemas use:
 * pointer-only references rooted at `#` (for example `#/definitions/concurrency`), with
 * plain `/` segments. `~0`/`~1` escape decoding and a bare `#` self-reference are not
 * supported, so a schema that starts using them fails closed with an unresolved-ref issue
 * rather than silently validating nothing.
 */
function resolveRef(
	node: SchemaNode,
	root: SchemaNode,
	depth = 0,
): { node: SchemaNode; unresolvedRef: string | null } {
	if (!node.$ref) return { node, unresolvedRef: null };
	const ref = node.$ref;
	if (depth > 10)
		return { node: {}, unresolvedRef: `${ref} (reference chain too deep)` };
	let target: unknown = root;
	for (const segment of ref.replace(/^#\//, "").split("/")) {
		target = (target as Record<string, unknown>)?.[segment];
		if (target === undefined) return { node: {}, unresolvedRef: ref };
	}
	return resolveRef(target as SchemaNode, root, depth + 1);
}

function declaredTypes(node: SchemaNode): string[] {
	if (!node.type) return [];
	return Array.isArray(node.type) ? node.type : [node.type];
}

function matchesScalar(value: unknown, types: string[]): boolean {
	if (value === null) return types.includes("null");
	if (Array.isArray(value)) return types.includes("array");
	return types.some((type) => {
		if (type === "integer") return Number.isInteger(value);
		return typeof value === type;
	});
}

/** Reports config keys or value shapes the installed Stryker schemas do not allow. */
function schemaIssues(
	value: unknown,
	rawNode: SchemaNode,
	root: SchemaNode,
	path: string,
): string[] {
	const resolved = resolveRef(rawNode, root, 0);
	if (resolved.unresolvedRef) {
		return [`${path}: unresolvable $ref ${resolved.unresolvedRef}`];
	}
	const node = resolved.node;
	const issues: string[] = [];
	const branches = node.oneOf ?? node.anyOf;

	if (branches) {
		const matched = branches.some(
			(branch) => schemaIssues(value, branch, root, path).length === 0,
		);
		if (matched) return issues;
		return [...issues, `${path}: no schema branch matches the value`];
	}

	const types = declaredTypes(node);
	if (types.length > 0 && !matchesScalar(value, types)) {
		return [...issues, `${path}: expected ${types.join(" | ")}`];
	}

	const allowedValues = node.enum;
	if (allowedValues && !allowedValues.some((allowed) => allowed === value)) {
		issues.push(`${path}: not one of the allowed values`);
	}

	const min = node.minimum;
	if (typeof min === "number" && typeof value === "number" && value < min) {
		issues.push(`${path}: must be >= ${min}`);
	}

	const max = node.maximum;
	if (typeof max === "number" && typeof value === "number" && value > max) {
		issues.push(`${path}: must be <= ${max}`);
	}

	const pattern = node.pattern;
	const isString = typeof value === "string";
	if (pattern && isString && !new RegExp(pattern).test(value)) {
		issues.push(`${path}: does not match the required pattern`);
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

	const properties = node.properties ?? {};
	for (const [key, child] of Object.entries(value as Json)) {
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

function brokenConfig(overrides: Json): Json {
	return { ...readJson(configPath), ...overrides };
}

function brokenThresholds(key: string, value: unknown): Json {
	const thresholds = readJson(configPath).thresholds as Record<string, unknown>;
	return brokenConfig({ thresholds: { ...thresholds, [key]: value } });
}

describe("stryker mutation config", () => {
	it("only uses options the installed Stryker schemas know", () => {
		// Stryker 10 renamed the score floor to thresholds.break. A stale key such as
		// breakAt fails validation before any mutant runs, so keep this guard live.
		const root = mergedSchema();
		const allowed = new Set(Object.keys(root.properties ?? {}));
		const keys = Object.keys(readJson(configPath));
		const unknown = keys.filter((key) => !allowed.has(key));

		expect(unknown).toEqual([]);
	});

	it("matches the installed Stryker schemas at every nesting level", () => {
		const root = mergedSchema();

		expect(schemaIssues(readJson(configPath), root, root, "")).toEqual([]);
	});

	it("catches a misspelled nested reporter option", () => {
		const root = mergedSchema();
		const broken = brokenConfig({ htmlReporter: { filename: "x" } });
		const issues = schemaIssues(broken, root, root, "");

		expect(issues).toEqual(["htmlReporter.filename: unknown option"]);
	});

	it("catches a wrong value type inside thresholds", () => {
		const root = mergedSchema();
		const broken = brokenThresholds("break", "62");
		const issues = schemaIssues(broken, root, root, "");
		const expected = "thresholds.break: no schema branch matches the value";

		expect(issues).toContain(expected);
	});

	it("catches a threshold above the allowed percentage maximum", () => {
		const root = mergedSchema();
		const broken = brokenThresholds("high", 120);
		const issues = schemaIssues(broken, root, root, "");
		const expected = "thresholds.high: must be <= 100";

		expect(issues).toContain(expected);
	});

	it("catches a concurrency percentage outside 0-100%", () => {
		const root = mergedSchema();
		const broken = brokenConfig({ concurrency: "110%" });
		const issues = schemaIssues(broken, root, root, "");
		const expected = "concurrency: no schema branch matches the value";

		expect(issues).toContain(expected);
	});

	it("accepts a valid integer reporter option", () => {
		const root = mergedSchema();
		const broken = brokenConfig({ clearTextReporter: { maxTestsToLog: 5 } });

		expect(schemaIssues(broken, root, root, "")).toEqual([]);
	});

	it("keeps the score floor between the color band and the recorded baseline", () => {
		const thresholds = readJson(configPath).thresholds as Thresholds;
		const headline = readJson(baselinePath).headlineScore as number;

		expect(typeof headline).toBe("number");
		expect(thresholds.break).toBeGreaterThanOrEqual(thresholds.low);
		expect(thresholds.break).toBeLessThanOrEqual(headline);
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
		// The schemas read below live in @stryker-mutator/api, which is otherwise only a
		// transitive dependency. A CI-gating test must not depend on an undeclared package's
		// internal layout, so the package carrying those schemas is declared at the same pin.
		expect(devDeps["@stryker-mutator/api"]).toMatch(exactPin);
		expect(scripts.mutation).toBe("stryker run");
	});

	it("keeps mutation artifacts out of git", () => {
		const ignorePath = new URL("../.gitignore", import.meta.url);
		const gitignore = readFileSync(ignorePath, "utf8");
		const lines = gitignore.split("\n").map((line) => line.trim());

		expect(lines).toContain("reports/");
		expect(lines).toContain(".stryker-tmp/");
	});

	it("keeps Stryker sandbox copies out of the resolved Vitest config", async () => {
		// Asserted on the resolved config rather than on config source text: an `exclude` that
		// replaces Vitest's defaults would pass a text check while silently dropping `**/.git/**`.
		const { default: vitestConfig } = await import("../vitest.config.js");
		const testExclude =
			(vitestConfig?.test as { exclude?: string[] })?.exclude ?? [];
		const coverageExclude =
			(vitestConfig?.test as { coverage?: { exclude?: string[] } })?.coverage
				?.exclude ?? [];

		for (const pattern of configDefaults.exclude) {
			expect(testExclude).toContain(pattern);
		}
		expect(testExclude).toContain("**/.stryker-tmp/**");
		expect(coverageExclude).toContain("**/.stryker-tmp/**");
	});

	it("keeps the recorded baseline consistent with Stryker's own scoring terms", async () => {
		// The floor is checked against headlineScore, so the fixture must not be able to drift
		// from its own mutant counts. Scored from Stryker's terms instead of totalMutants: the
		// score denominator is the mutants that were actually run and reported, so a future
		// regeneration that produces compileErrors, ignored or pending mutants cannot make this
		// guard fail for the wrong reason.
		const baseline = readJson(baselinePath) as Record<string, number>;
		const count = (key: string) => baseline[key] ?? 0;
		const categories = [
			"killed",
			"timeout",
			"survived",
			"noCoverage",
			"runtimeErrors",
			"compileErrors",
			"ignoreListed",
			"pending",
		];
		const detected = count("killed") + count("timeout");
		const scored = detected + count("survived") + count("noCoverage");

		expect(categories.reduce((total, key) => total + count(key), 0)).toBe(
			baseline.totalMutants,
		);
		expect((100 * detected) / scored).toBeCloseTo(baseline.headlineScore, 2);
		expect((100 * detected) / (detected + count("survived"))).toBeCloseTo(
			baseline.coveredScore,
			2,
		);

		// Provenance, not just arithmetic: the recorded numbers must belong to the tool and
		// config this repository actually pins.
		const pkg = readJson(new URL("../package.json", import.meta.url));
		const devDeps = pkg.devDependencies as Record<string, string>;
		const config = readJson(configPath);

		expect(String(baseline.strykerVersion)).toBe(
			devDeps["@stryker-mutator/core"],
		);
		// Concurrency is score-neutral, so it is pinned as presence-only provenance: a
		// tuning change must not force a ~15-minute full re-measurement to keep this green.
		expect(typeof baseline.concurrency).toBe("string");
		expect(String(baseline.concurrency).length).toBeGreaterThan(0);
		expect(String(baseline.coverageAnalysis)).toBe(
			String(config.coverageAnalysis),
		);
	});

	it("reports an unresolvable $ref instead of validating nothing", () => {
		// A dangling reference used to collapse to an empty node, which accepts any value:
		// a schema the validator cannot read must fail closed, not pass silently.
		const root: SchemaNode = {
			properties: { concurrency: { $ref: "#/definitions/NotDefined" } },
			definitions: { other: { type: "number" } },
		};

		expect(schemaIssues({ concurrency: 4 }, root, root, "")).toEqual([
			"concurrency: unresolvable $ref #/definitions/NotDefined",
		]);
	});

	it("resolves $defs reference targets", () => {
		// Stryker's own schemas use `definitions` today, but the validator must not lose a
		// reference target if a schema switches to the newer `$defs` keyword.
		const root: SchemaNode = {
			properties: { concurrency: { $ref: "#/$defs/Percent" } },
			$defs: { Percent: { type: "integer", minimum: 0, maximum: 100 } },
		};

		expect(schemaIssues({ concurrency: 50 }, root, root, "")).toEqual([]);
		expect(schemaIssues({ concurrency: 110 }, root, root, "")).toEqual([
			"concurrency: must be <= 100",
		]);
	});
});
