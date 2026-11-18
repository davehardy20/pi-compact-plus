import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assessAudit, runAudit } from "../scripts/check-dependency-audit.mjs";

const url = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const before = Date.parse("2026-11-24T23:59:59Z");
const expiry = Date.parse("2026-11-25T00:00:00Z");
const lock = {
	lockfileVersion: 3,
	packages: { "node_modules/picomatch": { version: "4.0.7", dev: true } },
};
function fixture() {
	const vulnerabilities = {};
	const add = (name, severity, via) => {
		vulnerabilities[name] = {
			name,
			severity,
			via,
			nodes: [`node_modules/${name}`],
		};
	};
	const advisory = (
		name,
		severity,
		advisoryUrl = "https://github.com/advisories/GHSA-other",
	) => ({ name, dependency: name, severity, url: advisoryUrl });
	add("picomatch", "high", [advisory("picomatch", "high", url)]);
	add("fdir", "high", ["picomatch"]);
	add("tinyglobby", "high", ["picomatch", "fdir"]);
	add("vite", "high", ["picomatch", "fdir", "tinyglobby"]);
	add("vitest", "high", [
		"picomatch",
		"tinyglobby",
		"@vitest/mocker",
		"@vitest/coverage-v8",
	]);
	add("@vitest/mocker", "moderate", [advisory("@vitest/mocker", "moderate")]);
	add("@vitest/coverage-v8", "moderate", ["vitest"]);
	return recount({ auditReportVersion: 2, vulnerabilities });
}
function recount(report) {
	const counts = {
		info: 0,
		low: 0,
		moderate: 0,
		high: 0,
		critical: 0,
		total: 0,
	};
	for (const entry of Object.values(report.vulnerabilities)) {
		counts[entry.severity]++;
		counts.total++;
	}
	report.metadata = { vulnerabilities: counts };
	return report;
}
const check = (report = fixture(), locked = lock, status = 1, now = before) =>
	assessAudit(report, locked, status, now);

describe("temporary Picomatch audit acceptance", () => {
	it("accepts only the known high cause, including cyclic peer propagation", () => {
		expect(check()).toMatchObject({
			accepted: 5,
			moderate: 2,
			expires: "2026-11-25T00:00:00Z",
		});
	});
	it("accepts a clean report and reports no exception use", () => {
		expect(
			check(recount({ auditReportVersion: 2, vulnerabilities: {} }), lock, 0),
		).toMatchObject({ accepted: 0 });
	});
	it.each([expiry, expiry + 1, Number.NaN])(
		"fails at/after expiry or for an invalid clock: %s",
		(now) => {
			expect(() => check(fixture(), lock, 1, now)).toThrow();
		},
	);
	it.each(["4.0.6", "4.0.8"])(
		"rejects a different locked version: %s",
		(version) => {
			expect(() =>
				check(fixture(), {
					...lock,
					packages: { "node_modules/picomatch": { version, dev: true } },
				}),
			).toThrow();
		},
	);
	it.each([false, undefined])(
		"rejects non-development lock entries: %s",
		(dev) => {
			expect(() =>
				check(fixture(), {
					...lock,
					packages: { "node_modules/picomatch": { version: "4.0.7", dev } },
				}),
			).toThrow();
		},
	);
	it("requires every reported Picomatch copy to be in scope", () => {
		const report = fixture();
		report.vulnerabilities.picomatch.nodes.push(
			"node_modules/other/node_modules/picomatch",
		);
		expect(() => check(report)).toThrow();
	});
	it.each(["picomatch", "vite", "vitest", "fdir", "tinyglobby"])(
		"does not whitelist a package name: %s",
		(name) => {
			const report = fixture();
			report.vulnerabilities[name].via.push({
				name,
				dependency: name,
				severity: "high",
				url: "https://github.com/advisories/GHSA-new",
			});
			expect(() => check(report)).toThrow();
		},
	);
	it.each(["critical", "moderate"])(
		"does not accept changed advisory severity: %s",
		(severity) => {
			const report = fixture();
			report.vulnerabilities.picomatch.via[0].severity = severity;
			expect(() => check(report)).toThrow();
		},
	);
	it("blocks critical aggregate severity", () => {
		const report = fixture();
		report.vulnerabilities.vite.severity = "critical";
		expect(() => check(recount(report))).toThrow();
	});
	it.each([
		(r) => {
			r.auditReportVersion = 1;
		},
		(r) => {
			r.error = { code: "ENOAUDIT" };
		},
		(r) => {
			r.metadata.vulnerabilities.high--;
		},
		(r) => {
			r.vulnerabilities.vite.via = ["missing"];
		},
		(r) => {
			r.vulnerabilities.vite.via = [];
		},
		(r) => {
			r.vulnerabilities.picomatch.nodes = [];
		},
		(r) => {
			r.vulnerabilities.picomatch.nodes = ["../node_modules/picomatch"];
		},
		(r) => {
			r.vulnerabilities.picomatch.via[0].url += "?other";
		},
		(r) => {
			r.vulnerabilities.picomatch.via[0].dependency = "other";
		},
		(r) => {
			r.vulnerabilities.vite.severity = "unknown";
		},
		(r) => {
			r.vulnerabilities.vite.name = "other";
		},
		(r) => {
			r.vulnerabilities.vite.via = ["vite"];
		},
	])(
		"fails closed on malformed, contradictory or unexplained reports: %s",
		(mutate) => {
			const report = fixture();
			mutate(report);
			expect(() => check(report)).toThrow();
		},
	);
	it.each([0, 2, null])("rejects an unexplained npm status: %s", (status) => {
		expect(() => check(fixture(), lock, status)).toThrow();
	});
	it("requires a reviewed lockfile", () => {
		expect(() => check(fixture(), {})).toThrow();
	});
	it("uses a bounded shell-free audit including every dependency class", () => {
		const report = recount({ auditReportVersion: 2, vulnerabilities: {} });
		const run = vi.fn(() => ({ status: 0, stdout: JSON.stringify(report) }));
		expect(runAudit(run, before)).toMatchObject({ accepted: 0 });
		expect(run).toHaveBeenCalledWith(
			"npm",
			expect.arrayContaining([
				"audit",
				"--json",
				"--audit-level=high",
				"--include=prod",
				"--include=dev",
				"--include=optional",
				"--include=peer",
			]),
			expect.objectContaining({
				shell: false,
				timeout: 120000,
				maxBuffer: 1048576,
			}),
		);
	});
	it("checks expiry after the audit finishes, not before it starts", () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(before);
		try {
			expect(() =>
				runAudit(() => {
					clock.mockReturnValue(expiry);
					return {
						status: 0,
						stdout: JSON.stringify(
							recount({ auditReportVersion: 2, vulnerabilities: {} }),
						),
					};
				}),
			).toThrow();
		} finally {
			clock.mockRestore();
		}
	});
	it.each([
		{ status: 1, error: new Error("private error"), stdout: "{}" },
		{ status: null, signal: "SIGTERM", stdout: "{}" },
		{ status: 1, stdout: "not JSON private response" },
		{ status: 0, stdout: "x".repeat(1048577) },
	])("does not turn audit execution failures into a pass", (result) => {
		expect(() => runAudit(() => result, before)).toThrow();
	});
	it("routes the CI audit through the scoped checker without ignoring errors", () => {
		const workflow = readFileSync(
			new URL("../.github/workflows/pr-checks-node.yml", import.meta.url),
			"utf8",
		);
		const step = workflow
			.split("      - name: Dependency audit if lockfile present\n")[1]
			?.split("      - name: ")[0];
		expect(step).toContain("node scripts/check-dependency-audit.mjs");
		expect(step).not.toContain("continue-on-error");
		expect(step).not.toContain("|| true");
	});
});
