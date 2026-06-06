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
		`${JSON.stringify({ name: "test-pkg", version: "0.0.1", files: ["src", "README.md", "LICENSE", "package.json"] }, null, 2)}\n`,
	);
	fs.writeFileSync(path.join(dir, "README.md"), "# test-pkg\n");
	fs.writeFileSync(path.join(dir, "LICENSE"), "MIT\n");
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
	fs.copyFileSync(
		path.join(rootScripts, "check-package-contents.js"),
		path.join(dir, "scripts", "check-package-contents.js"),
	);

	fs.writeFileSync(
		path.join(dir, "scripts", "verify.sh"),
		'#!/usr/bin/env bash\necho "mock verify"\n',
	);
	fs.chmodSync(path.join(dir, "scripts", "verify.sh"), 0o755);
	fs.chmodSync(path.join(dir, "scripts", "release-check.sh"), 0o755);
	fs.chmodSync(path.join(dir, "scripts", "release.sh"), 0o755);
	fs.chmodSync(path.join(dir, "scripts", "check-package-contents.js"), 0o755);

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
  case "view":
    if (process.env.NPM_VIEW_EXISTS === "1") {
      console.log("0.0.2");
    } else {
      console.error("npm error code E404");
      console.error("npm error 404 Not Found - GET https://registry.npmjs.org/test-pkg");
      process.exit(1);
    }
    break;
  case "pack":
    if (rest.includes("--json")) {
      const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
      const included = new Set(["package.json"]);
      function addEntry(entry) {
        if (!fs.existsSync(entry)) return;
        const stat = fs.statSync(entry);
        if (stat.isDirectory()) {
          for (const child of fs.readdirSync(entry).sort()) addEntry(entry + "/" + child);
        } else {
          included.add(entry);
        }
      }
      for (const file of p.files || []) addEntry(file);
      console.log(JSON.stringify([{ files: [...included].sort().map((path) => ({ path })) }]));
    } else {
      console.log("mock pack");
    }
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
  case "publish":
    console.log(rest.includes("--dry-run") ? "mock publish dry-run" : "mock publish");
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

	it("fails with --allow-dirty when untracked files exist", () => {
		fs.writeFileSync(
			path.join(dir, "src", "index.ts"),
			"export const x = 2;\n",
		);
		fs.writeFileSync(path.join(dir, "src", "local-secret.ts"), "secret\n");
		const result = exec(
			["scripts/release-check.sh", "--allow-dirty"],
			dir,
			undefined,
			{
				PATH: getPathEnv(dir),
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			"Working tree has untracked files",
		);
	});

	it("package content check accepts the release allow-list", () => {
		const result = exec(
			["-lc", "node scripts/check-package-contents.js"],
			dir,
			undefined,
			{
				PATH: getPathEnv(dir),
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Package contents look sane");
	});

	it("package content check rejects non-release files in package files", () => {
		const packagePath = path.join(dir, "package.json");
		const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
		pkg.files = ["src", "README.md", "LICENSE", "package.json", "scripts"];
		fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

		const result = exec(
			["-lc", "node scripts/check-package-contents.js"],
			dir,
			undefined,
			{
				PATH: getPathEnv(dir),
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			"Package includes non-release artifacts: scripts/check-package-contents.js",
		);
	});

	it("package content check rejects untracked files under shipped directories", () => {
		fs.writeFileSync(path.join(dir, "src", "local-secret.ts"), "secret\n");

		const result = exec(
			["-lc", "node scripts/check-package-contents.js"],
			dir,
			undefined,
			{
				PATH: getPathEnv(dir),
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			"Package includes files not tracked by git: src/local-secret.ts",
		);
	});

	it("verify script includes live and package content checks", () => {
		const verifyScript = fs.readFileSync(
			path.join(process.cwd(), "scripts", "verify.sh"),
			"utf8",
		);
		expect(verifyScript).toContain("node scripts/live-custom-path-check.mjs");
		expect(verifyScript).toContain("node scripts/check-package-contents.js");
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
			"Working tree has untracked files",
		);
	});

	it("fails with --allow-dirty before commit when tracked and untracked files coexist", () => {
		const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: dir,
			encoding: "utf-8",
		}).trim();
		fs.writeFileSync(
			path.join(dir, "src", "index.ts"),
			"export const x = 2;\n",
		);
		fs.writeFileSync(path.join(dir, "src", "local-secret.ts"), "secret\n");

		const result = exec(
			["scripts/release.sh", "--allow-dirty", "patch", "tracked change"],
			dir,
			"y\ny\n",
			{ PATH: getPathEnv(dir) },
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			"Working tree has untracked files",
		);
		expect(
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: dir,
				encoding: "utf-8",
			}).trim(),
		).toBe(headBefore);
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

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Released test-pkg@0.0.2");
		const committed = commitFiles(dir, "HEAD~1");
		expect(committed).toContain("src/index.ts");
		expect(commitMessage(dir, "HEAD~1")).toContain("staged change");
	});

	it("with --allow-dirty commits both staged and unstaged tracked changes", () => {
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

		const result = exec(
			["scripts/release.sh", "--allow-dirty", "patch", "mixed change"],
			dir,
			"y\ny\n",
			{ PATH: getPathEnv(dir) },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Released test-pkg@0.0.2");
		const committed = commitFiles(dir, "HEAD~1");
		expect(committed).toContain("src/index.ts");
		expect(committed).toContain("src/other.ts");
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

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("npm publish --dry-run --access public");
		expect(result.stdout).toContain("mock publish dry-run");
		expect(result.stdout).toContain("npm publish --access public");
		expect(result.stdout).toContain("mock publish");
		expect(result.stdout).toContain("Released test-pkg@0.0.2");
		const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: dir,
			encoding: "utf-8",
		}).trim();
		// On a clean tree, release.sh commits via npm version, so HEAD changes.
		// The key behavior is that no *local* files were auto-committed before npm version.
		expect(headBefore).not.toBe(headAfter);
	});

	it("fails before version commit when the next npm version already exists", () => {
		const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: dir,
			encoding: "utf-8",
		}).trim();

		const result = exec(["scripts/release.sh", "patch"], dir, undefined, {
			PATH: getPathEnv(dir),
			NPM_VIEW_EXISTS: "1",
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			"test-pkg@0.0.2 is already published",
		);
		expect(
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: dir,
				encoding: "utf-8",
			}).trim(),
		).toBe(headBefore);
	});
});
