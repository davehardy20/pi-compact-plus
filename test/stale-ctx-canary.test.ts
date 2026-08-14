import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Upstream-message canary: isStaleExtensionContextError() in src/lifecycle.ts
 * string-matches Pi's stale-context guard message. If a dependency bump
 * rewords or removes that message in the installed dist, stale-ctx detection
 * silently stops working (guarded reads would re-throw). This canary fails
 * loudly instead, pointing at the re-verification instruction in lifecycle.ts.
 */
describe("upstream stale-ctx message canary", () => {
	it("installed pi-coding-agent dist still emits the stale-ctx message", () => {
		const testDir = dirname(fileURLToPath(import.meta.url));
		const runnerPath = join(
			testDir,
			"..",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"dist",
			"core",
			"extensions",
			"runner.js",
		);
		let runnerSource: string;
		try {
			runnerSource = readFileSync(runnerPath, "utf8");
		} catch {
			throw new Error(
				`Cannot read ${runnerPath}. If the dist layout moved, update this canary and re-verify the stale-ctx substring per src/lifecycle.ts.`,
			);
		}
		expect(
			/stale after session replacement or reload/i.test(runnerSource),
			`Expected the installed @earendil-works/pi-coding-agent dist to still contain the stale-context guard message matched by isStaleExtensionContextError (src/lifecycle.ts). A dependency bump likely reworded it — re-verify and update the pattern there.`,
		).toBe(true);
	});
});
