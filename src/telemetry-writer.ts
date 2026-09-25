import type { PersistedTelemetry, SaveTelemetryResult } from "./persist.js";
import type { TelemetryPersistenceIssue } from "./types.js";

type Snapshot = Omit<PersistedTelemetry, "version">;

/** Serialize snapshots, including writes started by void Pi compaction callbacks. */
export function createTelemetryWriter(deps: {
	snapshot: () => Snapshot;
	save: (snapshot: Snapshot) => Promise<SaveTelemetryResult>;
	reportIssue: (issue: TelemetryPersistenceIssue | null) => void;
}): { persist: () => Promise<void>; drain: () => Promise<void> } {
	let pending: Promise<void> = Promise.resolve();

	return {
		persist: () => {
			// Capture now, not when earlier writes finish; a later session may reset state.
			const value = deps.snapshot();
			pending = pending.then(async () => {
				try {
					const result = await deps.save(value);
					deps.reportIssue(result.issue);
				} catch {
					// Never leak an unexpected filesystem/provider error through an
					// unawaited lifecycle callback or block a later snapshot.
					deps.reportIssue({
						operation: "save",
						code: "write-failed",
						path: "",
						message: "Could not persist telemetry snapshot.",
						timestamp: Date.now(),
					});
				}
			});
			return pending;
		},
		// Session replacement/reload must not read a snapshot while an older
		// background save can still replace it. Shutdown awaits the same boundary.
		drain: () => pending,
	};
}
