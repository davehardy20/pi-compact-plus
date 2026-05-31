#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const REQUIRED_FILES = new Set([
	"LICENSE",
	"README.md",
	"package.json",
	"src/index.ts",
]);

const FORBIDDEN_PREFIXES = [
	"agent/",
	"scripts/",
	"test/",
	".seeds/",
	".github/",
	"node_modules/",
];
const FORBIDDEN_SUFFIXES = [".tgz"];

function fail(message) {
	console.error(`❌ ${message}`);
	process.exit(1);
}

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
	cwd: process.cwd(),
	encoding: "utf8",
});

if (result.error) {
	fail(`npm pack --dry-run failed: ${result.error.message}`);
}
if (result.status !== 0) {
	process.stderr.write(result.stderr);
	process.stdout.write(result.stdout);
	fail(`npm pack --dry-run exited with ${result.status}`);
}

let parsed;
try {
	parsed = JSON.parse(result.stdout);
} catch (error) {
	fail(`Could not parse npm pack --dry-run --json output: ${error}`);
}

const pack = parsed?.[0];
const files = Array.isArray(pack?.files)
	? pack.files.map((file) => file.path).sort()
	: null;
if (!files) {
	fail("npm pack output did not include a files array");
}

for (const required of REQUIRED_FILES) {
	if (!files.includes(required)) {
		fail(`Package is missing required file: ${required}`);
	}
}

const forbidden = files.filter(
	(file) =>
		FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
		FORBIDDEN_SUFFIXES.some((suffix) => file.endsWith(suffix)),
);
if (forbidden.length > 0) {
	fail(`Package includes non-release artifacts: ${forbidden.join(", ")}`);
}

const gitTracked = spawnSync("git", ["ls-files", "--"], {
	cwd: process.cwd(),
	encoding: "utf8",
});
if (gitTracked.status === 0) {
	const tracked = new Set(gitTracked.stdout.split("\n").filter(Boolean));
	const untrackedPacked = files.filter((file) => !tracked.has(file));
	if (untrackedPacked.length > 0) {
		fail(
			`Package includes files not tracked by git: ${untrackedPacked.join(", ")}`,
		);
	}
}

console.log(`✅ Package contents look sane (${files.length} files)`);
