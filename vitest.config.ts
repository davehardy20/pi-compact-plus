import {
	configDefaults,
	coverageConfigDefaults,
	defineConfig,
} from "vitest/config";

// Stryker copies the whole project into .stryker-tmp/sandbox-*/ while it runs. Vitest's
// default exclude does not cover it, so a positional path filter such as
// `vitest run test/foo.test.ts` also matched every sandbox copy and ran them as extra suites.
// Vitest's own defaults are spread rather than replaced, so `**/.git/**` and friends stay
// excluded too.
const sandboxExclude = "**/.stryker-tmp/**";

export default defineConfig({
	test: {
		environment: "node",
		exclude: [...configDefaults.exclude, sandboxExclude],
		coverage: {
			provider: "v8",
			reporter: ["json"],
			reportsDirectory: "coverage",
			exclude: [...coverageConfigDefaults.exclude, sandboxExclude],
		},
	},
});
