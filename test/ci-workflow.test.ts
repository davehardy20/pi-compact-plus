import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	new URL("../.github/workflows/pr-checks-node.yml", import.meta.url),
	"utf8",
);

describe("PR Node workflow checks", () => {
	it("installs reproducibly from the committed lockfile", () => {
		const installStep = workflow
			.split("\n      - name: Install dependencies\n")[1]
			?.split("\n      - name: ")[0];
		expect(installStep).toBeDefined();
		expect(installStep).toContain("npm ci --no-audit");
		expect(installStep).not.toContain("--package-lock=false");
	});

	it.each([
		{ hasConfig: true, hasScript: false, expectedLint: "true" },
		{ hasConfig: false, hasScript: true, expectedLint: "true" },
		{ hasConfig: false, hasScript: false, expectedLint: "false" },
	])(
		"detects lint capability from script or Biome config: %j",
		({ hasConfig, hasScript, expectedLint }) => {
			const script = workflow.match(
				/node <<'NODE'\n([\s\S]*?)\n {10}NODE/,
			)?.[1];
			expect(script).toBeDefined();
			const root = mkdtempSync(join(tmpdir(), "pi-cp-ci-lint-"));
			try {
				writeFileSync(
					join(root, "package.json"),
					JSON.stringify({
						scripts: hasScript ? { lint: "biome check ." } : {},
					}),
				);
				if (hasConfig) writeFileSync(join(root, "biome.json"), "{}");
				const output = join(root, "github-output");
				execFileSync(process.execPath, ["-e", script ?? ""], {
					cwd: root,
					env: { GITHUB_OUTPUT: output },
				});
				const detected = readFileSync(output, "utf8");
				expect(detected).toContain(`has_lint=${expectedLint}`);
				expect(detected).toContain(`has_lint_script=${hasScript}`);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("runs the pinned local Biome binary when config is detected without a lint script", () => {
		const lintStep = workflow
			.split("\n      - name: Lint if present\n")[1]
			?.split("\n      - name: ")[0];
		expect(lintStep).toContain("steps.detect.outputs.has_lint_script");
		expect(lintStep).toContain(
			"./node_modules/.bin/biome check src test scripts",
		);
	});

	it("pins the local lint command and Biome package", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		const lock = JSON.parse(
			readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
		);
		expect(manifest.scripts.lint).toBe("biome check src test scripts");
		expect(manifest.devDependencies["@biomejs/biome"]).toBe("2.5.8");
		expect(lock.packages["node_modules/@biomejs/biome"].version).toBe("2.5.8");
	});

	it("runs the no-network provider-boundary test against Pi 0.87.1 in CI", () => {
		expect(workflow).toContain("name: Pi 0.87 provider boundary");
		expect(workflow).toContain("@earendil-works/pi-coding-agent@0.87.1");
		expect(workflow).toContain("PI_COMPACT_PLUS_TEST_PI_087_ROOT:");
		expect(workflow).toContain("vitest run test/provider-boundary-087.test.ts");
	});
});
