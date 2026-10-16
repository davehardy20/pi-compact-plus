import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Stryker copies the whole project into .stryker-tmp/sandbox-*/ while it runs.
		// Without this exclude, a positional path filter such as `vitest run test/foo.test.ts`
		// also matches every sandbox copy and runs them as extra suites.
		exclude: ["**/node_modules/**", "**/dist/**", "**/.stryker-tmp/**"],
	},
});
