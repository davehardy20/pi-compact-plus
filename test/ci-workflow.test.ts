import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	new URL("../.github/workflows/pr-checks-node.yml", import.meta.url),
	"utf8",
);

describe("PR Node workflow dependency install", () => {
	it("installs reproducibly from the committed lockfile", () => {
		const installStep = workflow
			.split("\n      - name: Install dependencies\n")[1]
			?.split("\n      - name: ")[0];
		expect(installStep).toBeDefined();
		expect(installStep).toContain("npm ci --no-audit");
		expect(installStep).not.toContain("--package-lock=false");
	});
});
