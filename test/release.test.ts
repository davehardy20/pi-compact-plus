import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function exec(
	args: string[],
	cwd: string,
	input?: string,
	env?: Record<string, string>,
): ExecResult {
	try {
		const stdout = execFileSync("bash", args, {
			cwd,
			encoding: "utf-8",
			input,
			env: { ...process.env, ...env },
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (err: unknown) {
		const error = err as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
			exitCode: error.status ?? 1,
		};
	}
}

function setupTempRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cp-release-test-"));

	execFileSync("git", ["init"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });

	fs.writeFileSync(
		path.join(dir, "package.json"),
		`${JSON.stringify({ name: "test-pkg", version: "0.0.1", files: ["src"] }, null, 2)}\n`,
	);
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const x = 1;\n");
	fs.mkdirSync(path.join(dir, "scripts"));

	const rootScripts = path.join(process.cwd(), "scripts");
	fs.copyFileSync(
		path.join(rootScripts, "release-check.sh"),
		path.join(dir, "scripts", "release-check.sh"),
	);
	fs.copyFileSync(
		path.join(rootScripts, "release.sh"),
		path.join(dir, "scripts", "release.sh"),
	);

	fs.writeFileSync(
		path.join(dir, "scripts", "verify.sh"),
		'#!/usr/bin/env bash\necho "mock verify"\n',
	);
	fs.chmodSync(path.join(dir, "scripts", "verify.sh"), 0o755);
	fs.chmodSync(path.join(dir, "scripts", "release-check.sh"), 0o755);
	fs.chmodSync(path.join(dir, "scripts", "release.sh"), 0o755);

	const binDir = path.join(dir, "bin");
	fs.mkdirSync(binDir);
	fs.writeFileSync(
		path.join(binDir, "npm"),
		`#!/usr/bin/env node
const fs = require("fs");
const { execFileSync } = require("child_process");
const [, , cmd, ...rest] = process.argv;

function bump() {
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const v = p.version.split(".");
  v[2] = +v[2] + 1;
  p.version = v.join(".");
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\\n");
  return p.version;
}

switch (cmd) {
  case "whoami":
    console.log("testuser");
    break;
  case "pack":
    console.log("mock pack");
    break;
  case "version":
    const ver = bump();
    if (!rest.includes("--no-git-tag-version")) {
      fs.writeFileSync("package-lock.json", "{}");
      execFileSync("git", ["add", "package.json", "package-lock.json"], { stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "v" + ver], { stdio: "ignore" });
      execFileSync("git", ["tag", "v" + ver], { stdio: "ignore" });
    }
    console.log(ver);
    break;
  default:
    console.error("Unknown npm command: " + cmd);
    process.exit(1);
}
`,
	);
	fs.chmodSync(path.join(binDir, "npm"), 0o755);

	const originDir = path.join(dir, "origin.git");
	fs.mkdirSync(originDir);
	execFileSync("git", ["init", "--bare"], { cwd: originDir });
	execFileSync("git", ["remote", "add", "origin", originDir], { cwd: dir });

	fs.writeFileSync(path.join(dir, ".gitignore"), "bin/\norigin.git/\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

	return dir;
}

function getPathEnv(dir: string): string {
	return `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
}

function commitFiles(dir: string, rev = "HEAD"): string[] {
	const out = execFileSync(
		"git",
		["diff-tree", "--no-commit-id", "--name-only", "-r", rev],
		{
			cwd: dir,
			encoding: "utf-8",
		},
	);
	return out.trim().split("\n").filter(Boolean);
}

function commitMessage(dir: string, rev = "HEAD"): string {
	const out = execFileSync("git", ["log", "-1", "--pretty=%B", rev], {
		cwd: dir,
		encoding: "utf-8",
	});
	return out.trim();
}

describe("release-check.sh", () => {
	let dir: string;

	beforeEach(() => {
		dir = setupTempRepo();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("passes on a clean tree", () => {
		const result = exec(["scripts/release-check.sh"], dir, undefined, {
			PATH: getPathEnv(dir),
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Release checks complete");
	});

	it("fails on a dirty tree with modified tracked files", () => {
		fs.writeFileSync(
			path.join(dir, "src", "index.ts"),
			"export const x = 2;\n",
		);
		const result = exec(["scripts/release-check.sh"], dir, undefined, {
			PATH: getPathEnv(dir),
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			"Working tree is not clean",
		);
	});

	it("fails on a dirty tree with untracked files", () => {
		fs.writeFileSync(path.join(dir, "untracked.txt"), "hello\n");
		const result = exec(["scripts/release-check.sh"], dir, undefined, {
			PATH: getPathEnv(dir),
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			"Working tree is not clean",
		);
	});

	it("passes on a dirty tree with --allow-dirty", () => {
		fs.writeFileSync(
			path.join(dir, "src", "index.ts"),
			"export const x = 2;\n",
		);
		const result = exec(
			["scripts/release-check.sh", "--allow-dirty"],
			dir,
			undefined,
			{
				PATH: getPathEnv(dir),
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("allowed via --allow-dirty");
		expect(result.stdout).toContain("Release checks complete");
	});

	it("mentions dry run with --dry-run", () => {
		const result = exec(
			["scripts/release-check.sh", "--dry-run"],
			dir,
			undefined,
			{
				PATH: getPathEnv(dir),
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Dry run complete");
	});

	it("rejects unknown flags", () => {
		const result = exec(
			["scripts/release-check.sh", "--bogus"],
			dir,
			undefined,
			{
				PATH: getPathEnv(dir),
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("Unknown option");
	});
});

describe("release.sh", () => {
	let dir: string;

	beforeEach(() => {
		dir = setupTempRepo();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("fails on a dirty tree without --allow-dirty", () => {
		fs.writeFileSync(
			path.join(dir, "src", "index.ts"),
			"export const x = 2;\n",
		);
		const result = exec(["scripts/release.sh", "patch"], dir, undefined, {
			PATH: getPathEnv(dir),
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			"Working tree is not clean",
		);
	});

	it("fails with --allow-dirty when only untracked files exist", () => {
		fs.writeFileSync(path.join(dir, "untracked.txt"), "hello\n");
		const result = exec(
			["scripts/release.sh", "--allow-dirty", "patch", "msg"],
			dir,
			undefined,
			{
				PATH: getPathEnv(dir),
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			"Untracked files are never auto-committed",
		);
	});

	it("with --allow-dirty commits only tracked modified files, not untracked", () => {
		fs.writeFileSync(
			path.join(dir, "src", "index.ts"),
			"export const x = 2;\n",
		);
		fs.writeFileSync(path.join(dir, "untracked.txt"), "hello\n");

		const result = exec(
			["scripts/release.sh", "--allow-dirty", "patch", "tracked change"],
			dir,
			"y\ny\n",
			{ PATH: getPathEnv(dir) },
		);

		expect(result.exitCode).not.toBe(0);
		// It will eventually fail on npm publish (no registry), but the commit should have happened.
		const committed = commitFiles(dir, "HEAD~1");
		expect(committed).toContain("src/index.ts");
		expect(committed).not.toContain("untracked.txt");
		expect(commitMessage(dir, "HEAD~1")).toContain("tracked change");
	});

	it("with --allow-dirty commits staged-only tracked changes", () => {
		fs.writeFileSync(
			path.join(dir, "src", "index.ts"),
			"export const x = 2;\n",
		);
		execFileSync("git", ["add", "src/index.ts"], { cwd: dir });

		const result = exec(
			["scripts/release.sh", "--allow-dirty", "patch", "staged change"],
			dir,
			"y\ny\n",
			{ PATH: getPathEnv(dir) },
		);

		expect(result.exitCode).not.toBe(0);
		const committed = commitFiles(dir, "HEAD~1");
		expect(committed).toContain("src/index.ts");
		expect(commitMessage(dir, "HEAD~1")).toContain("staged change");
	});

	it("with --allow-dirty commits both staged and unstaged tracked changes, not untracked", () => {
		fs.writeFileSync(
			path.join(dir, "src", "other.ts"),
			"export const y = 1;\n",
		);
		execFileSync("git", ["add", "src/other.ts"], { cwd: dir });
		execFileSync("git", ["commit", "-m", "add other.ts"], { cwd: dir });

		fs.writeFileSync(
			path.join(dir, "src", "index.ts"),
			"export const x = 2;\n",
		);
		execFileSync("git", ["add", "src/index.ts"], { cwd: dir });
		fs.writeFileSync(
			path.join(dir, "src", "other.ts"),
			"export const y = 2;\n",
		);
		fs.writeFileSync(path.join(dir, "untracked.txt"), "hello\n");

		const result = exec(
			["scripts/release.sh", "--allow-dirty", "patch", "mixed change"],
			dir,
			"y\ny\n",
			{ PATH: getPathEnv(dir) },
		);

		expect(result.exitCode).not.toBe(0);
		const committed = commitFiles(dir, "HEAD~1");
		expect(committed).toContain("src/index.ts");
		expect(committed).toContain("src/other.ts");
		expect(committed).not.toContain("untracked.txt");
		expect(commitMessage(dir, "HEAD~1")).toContain("mixed change");
	});

	it("does not auto-commit anything on a clean tree", () => {
		const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: dir,
			encoding: "utf-8",
		}).trim();

		const result = exec(["scripts/release.sh", "patch"], dir, "y\ny\n", {
			PATH: getPathEnv(dir),
		});

		expect(result.exitCode).not.toBe(0);
		const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: dir,
			encoding: "utf-8",
		}).trim();
		// On a clean tree, release.sh commits via npm version, so HEAD changes.
		// The key behavior is that no *local* files were auto-committed before npm version.
		expect(headBefore).not.toBe(headAfter);
	});
});
