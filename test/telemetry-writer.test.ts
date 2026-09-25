import { describe, expect, it, vi } from "vitest";
import type {
	PersistedTelemetry,
	SaveTelemetryResult,
} from "../src/persist.js";
import { createTelemetryWriter } from "../src/telemetry-writer.js";
import type { TelemetryPersistenceIssue } from "../src/types.js";

type Snapshot = Omit<PersistedTelemetry, "version">;

function snapshot(lastCompactTime: number): Snapshot {
	return {
		lastCompaction: null,
		lastFallbackReason: null,
		lastInjectedEcho: null,
		lastCompactTime,
		lastCompactTokens: 0,
		lastModelKey: null,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

describe("serialized telemetry snapshots", () => {
	it("saves invocation-time snapshots in order and drains before a session load", async () => {
		let current = 1;
		const firstSave = deferred<SaveTelemetryResult>();
		const save = vi
			.fn<(value: Snapshot) => Promise<SaveTelemetryResult>>()
			.mockImplementationOnce(async () => firstSave.promise)
			.mockResolvedValue({ saved: true, issue: null });
		const writer = createTelemetryWriter({
			snapshot: () => snapshot(current),
			save,
			reportIssue: vi.fn(),
		});
		const earlier = writer.persist();
		current = 2;
		const later = writer.persist();
		const loaded = vi.fn();
		const sessionStart = writer.drain().then(loaded);
		await Promise.resolve();
		expect(save).toHaveBeenCalledTimes(1);
		expect(loaded).not.toHaveBeenCalled();
		firstSave.resolve({ saved: true, issue: null });
		await Promise.all([earlier, later, sessionStart]);
		expect(save.mock.calls.map(([value]) => value.lastCompactTime)).toEqual([
			1, 2,
		]);
		expect(loaded).toHaveBeenCalledTimes(1);
	});

	it("reports a safe diagnostic and continues after an unexpected write failure", async () => {
		let current = 1;
		const issues: TelemetryPersistenceIssue[] = [];
		const save = vi
			.fn<(value: Snapshot) => Promise<SaveTelemetryResult>>()
			.mockRejectedValueOnce(new Error("provider key: SYNTHETIC_SECRET"))
			.mockResolvedValue({ saved: true, issue: null });
		const writer = createTelemetryWriter({
			snapshot: () => snapshot(current),
			save,
			reportIssue: (issue) => {
				if (issue) issues.push(issue);
			},
		});
		const failed = writer.persist();
		current = 2;
		const retry = writer.persist();
		await Promise.all([failed, retry, writer.drain()]);
		expect(save.mock.calls.map(([value]) => value.lastCompactTime)).toEqual([
			1, 2,
		]);
		expect(issues).toMatchObject([{ operation: "save", code: "write-failed" }]);
		expect(JSON.stringify(issues)).not.toContain("SYNTHETIC_SECRET");
	});
});
