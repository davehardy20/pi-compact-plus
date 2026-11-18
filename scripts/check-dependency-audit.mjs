import { spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Dave accepted this development-only risk, not a vulnerability fix (7566).
const ADVISORY = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const EXPIRES = "2026-11-25T00:00:00Z";
const LIMIT = 1048576;
const LEVELS = ["info", "low", "moderate", "high", "critical"];
class AuditFailure extends Error {}
const requireValid = (condition, message) => {
	if (!condition) throw new AuditFailure(message);
};
const record = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function ancestors(roots, parents) {
	const found = new Set(roots);
	const queue = [...found];
	for (let i = 0; i < queue.length; i++) {
		for (const parent of parents.get(queue[i])) {
			if (!found.has(parent)) {
				found.add(parent);
				queue.push(parent);
			}
		}
	}
	return found;
}

export function assessAudit(report, lock, status, now = Date.now()) {
	requireValid(
		Number.isFinite(now) && now >= 0 && now < Date.parse(EXPIRES),
		"Picomatch exception expired or clock invalid; remove/review the exception.",
	);
	requireValid(
		record(report) &&
			report.auditReportVersion === 2 &&
			!Object.hasOwn(report, "error") &&
			record(report.vulnerabilities) &&
			record(report.metadata?.vulnerabilities),
		"Unsupported or failed npm audit report.",
	);
	requireValid(
		record(lock) && lock.lockfileVersion === 3 && record(lock.packages),
		"Missing reviewed version-3 lockfile.",
	);
	const entries = Object.entries(report.vulnerabilities);
	requireValid(entries.length <= 512, "Audit report exceeds policy bounds.");
	const parents = new Map(entries.map(([name]) => [name, []]));
	const roots = new Set();
	const acceptedRoots = new Set();
	const counts = Object.fromEntries(LEVELS.map((level) => [level, 0]));
	let edges = 0;
	for (const [name, entry] of entries) {
		requireValid(
			record(entry) &&
				entry.name === name &&
				LEVELS.includes(entry.severity) &&
				Array.isArray(entry.via) &&
				entry.via.length > 0 &&
				Array.isArray(entry.nodes) &&
				entry.nodes.length > 0,
			"Malformed vulnerability entry.",
		);
		counts[entry.severity]++;
		requireValid(entry.severity !== "critical", "Critical findings remain.");
		for (const node of entry.nodes) {
			requireValid(
				typeof node === "string" &&
					node.startsWith("node_modules/") &&
					!node.includes("\\") &&
					node
						.split("/")
						.every((part) => part && part !== "." && part !== ".."),
				"Invalid audit node path.",
			);
		}
		for (const cause of entry.via) {
			requireValid(++edges <= 4096, "Audit graph exceeds policy bounds.");
			if (typeof cause === "string") {
				requireValid(parents.has(cause), "Unresolved audit cause.");
				parents.get(cause).push(name);
				continue;
			}
			requireValid(
				record(cause) &&
					cause.name === name &&
					cause.dependency === name &&
					LEVELS.includes(cause.severity) &&
					typeof cause.url === "string",
				"Malformed direct advisory.",
			);
			roots.add(name);
			if (cause.severity !== "high" && cause.severity !== "critical") continue;
			requireValid(
				name === "picomatch" &&
					cause.url === ADVISORY &&
					cause.severity === "high" &&
					entry.severity === "high" &&
					entry.nodes.every((node) => {
						const pinned = lock.packages[node];
						return (
							/(?:^|\/)node_modules\/picomatch$/.test(node) &&
							record(pinned) &&
							pinned.version === "4.0.7" &&
							pinned.dev === true
						);
					}),
				"Unaccepted high/critical advisory; run npm audit for details.",
			);
			acceptedRoots.add(name);
		}
	}
	const metadata = report.metadata.vulnerabilities;
	for (const level of LEVELS) {
		requireValid(metadata[level] === counts[level], "Audit counts disagree.");
	}
	requireValid(metadata.total === entries.length, "Audit total disagrees.");
	requireValid(
		status === (counts.high + counts.critical > 0 ? 1 : 0),
		"Unexplained npm exit status.",
	);
	// Reachability, not recursive whitelisting: npm's peer graph can be cyclic.
	const explained = ancestors(roots, parents);
	const accepted = ancestors(acceptedRoots, parents);
	for (const [name, entry] of entries) {
		requireValid(explained.has(name), "Audit entry has no advisory cause.");
		requireValid(
			entry.severity !== "high" || accepted.has(name),
			"Unexplained high-severity finding.",
		);
	}
	return { ...counts, accepted: counts.high, expires: EXPIRES };
}

function readLock(root) {
	const fd = openSync(
		join(root, "package-lock.json"),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		requireValid(fstatSync(fd).isFile(), "Lockfile must be a regular file.");
		const buffer = Buffer.alloc(5 * LIMIT + 1);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		requireValid(size <= 5 * LIMIT, "Lockfile exceeds policy bounds.");
		return buffer.subarray(0, size).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

export function runAudit(run = spawnSync, now) {
	const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
	const locked = readLock(root);
	const result = run(
		"npm",
		[
			"audit",
			"--json",
			"--audit-level=high",
			"--package-lock-only",
			"--include=prod",
			"--include=dev",
			"--include=optional",
			"--include=peer",
		],
		{
			cwd: root,
			shell: false,
			encoding: "utf8",
			timeout: 120000,
			killSignal: "SIGKILL",
			maxBuffer: LIMIT,
		},
	);
	requireValid(
		!result.error &&
			!result.signal &&
			typeof result.stdout === "string" &&
			Buffer.byteLength(result.stdout) <= LIMIT &&
			readLock(root) === locked,
		"Audit execution failed, exceeded bounds, or lockfile changed.",
	);
	let report;
	let lock;
	try {
		report = JSON.parse(result.stdout);
		lock = JSON.parse(locked);
	} catch {
		throw new AuditFailure("Audit or lockfile is not valid JSON.");
	}
	return assessAudit(report, lock, result.status, now ?? Date.now());
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		requireValid(
			process.argv.length === 2,
			"Audit checker takes no arguments.",
		);
		const result = runAudit();
		console.log(
			`Audit: ${result.info} info, ${result.low} low, ${result.moderate} moderate; ${result.accepted} high package entries temporarily accepted for GHSA-fc5q-39xc-vjpf only; expires ${result.expires}. This is risk acceptance, NOT a vulnerability fix.`,
			"Run npm audit --audit-level=high to inspect the unfiltered findings.",
		);
	} catch (error) {
		console.error(
			error instanceof AuditFailure
				? error.message
				: "Dependency audit failed.",
		);
		process.exitCode = 1;
	}
}
