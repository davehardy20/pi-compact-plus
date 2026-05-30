import type { ToolOutputMetadataReconstructionResult } from "./metadata.js";
import {
	MAX_FINALIZED_RECORDS,
	MAX_PENDING_BATCHES,
	MAX_PENDING_RECORDS,
	type PendingToolOutputBatch,
	type ToolOutputPruningStateSnapshot,
	type ToolOutputRecord,
} from "./types.js";

/**
 * Encapsulates mutable state for tool-output pruning.
 *
 * Holds pending batches (captured but not yet summarized), finalized records
 * (summarized and eligible for pruning), and flushing/stat guards.
 */
export class ToolOutputPruningState {
	pendingBatches: PendingToolOutputBatch[] = [];
	pendingRecords: ToolOutputRecord[] = [];
	finalizedRecords: ToolOutputRecord[] = [];
	isFlushing = false;
	lastSummaryStatus: "ok" | "error" | null = null;
	lastSummaryTime: number | null = null;
	lastPrunedCount = 0;
	lastReconstructionStatus: "ok" | "skipped" | "error" | null = null;
	lastReconstructionTime: number | null = null;
	lastReconstructionError: string | null = null;
	lastReconstructionScannedEntries = 0;
	lastReconstructionScannedBytes = 0;
	lastReconstructionSkippedEntries = 0;
	lastReconstructedCount = 0;
	shortRefCounter = 0;

	/** Reset all state to initial values. */
	reset(): void {
		this.pendingBatches = [];
		this.pendingRecords = [];
		this.finalizedRecords = [];
		this.isFlushing = false;
		this.lastSummaryStatus = null;
		this.lastSummaryTime = null;
		this.lastPrunedCount = 0;
		this.lastReconstructionStatus = null;
		this.lastReconstructionTime = null;
		this.lastReconstructionError = null;
		this.lastReconstructionScannedEntries = 0;
		this.lastReconstructionScannedBytes = 0;
		this.lastReconstructionSkippedEntries = 0;
		this.lastReconstructedCount = 0;
		this.shortRefCounter = 0;
	}

	/** Reset only pending captures (e.g. at agent_start). */
	resetPending(): void {
		this.pendingBatches = [];
		this.pendingRecords = [];
		this.isFlushing = false;
	}

	/**
	 * Add a pending batch and its records, enforcing bounded pending limits.
	 * If limits are exceeded, oldest batches and their records are dropped.
	 */
	addPendingBatch(
		batch: PendingToolOutputBatch,
		records: ToolOutputRecord[],
	): void {
		this.pendingBatches.push(batch);
		this.pendingRecords.push(...records);
		this.trimPending();
	}

	private trimPending(): void {
		// Drop oldest batches if over batch limit
		while (this.pendingBatches.length > MAX_PENDING_BATCHES) {
			const removed = this.pendingBatches.shift();
			if (!removed) break;
			const removedIds = new Set(removed.recordIds);
			this.pendingRecords = this.pendingRecords.filter(
				(r) => !removedIds.has(r.recordId),
			);
		}
		// Drop oldest batches if still over record limit
		while (
			this.pendingRecords.length > MAX_PENDING_RECORDS &&
			this.pendingBatches.length > 0
		) {
			const removed = this.pendingBatches.shift();
			if (!removed) break;
			const removedIds = new Set(removed.recordIds);
			this.pendingRecords = this.pendingRecords.filter(
				(r) => !removedIds.has(r.recordId),
			);
		}
		// Final safety trim if records still exceed limit (orphaned records)
		if (this.pendingRecords.length > MAX_PENDING_RECORDS) {
			this.pendingRecords = this.pendingRecords.slice(-MAX_PENDING_RECORDS);
		}
	}

	/**
	 * Add a finalized record, enforcing the finalized record limit.
	 * If the limit is exceeded, oldest records are dropped.
	 */
	addFinalizedRecord(record: ToolOutputRecord): void {
		const exists = this.finalizedRecords.some(
			(r) => r.recordId === record.recordId,
		);
		if (!exists) {
			this.finalizedRecords.push(record);
		}
		if (this.finalizedRecords.length > MAX_FINALIZED_RECORDS) {
			this.finalizedRecords = this.finalizedRecords.slice(
				-MAX_FINALIZED_RECORDS,
			);
		}
	}

	/** Generate the next short ref (t1, t2, …). */
	generateShortRef(): string {
		this.shortRefCounter += 1;
		return `t${this.shortRefCounter}`;
	}

	/** Advance short-ref allocation past restored finalized records. */
	advanceShortRefCounterFromRecords(records: ToolOutputRecord[]): void {
		let maxRefNumber = this.shortRefCounter;
		for (const record of records) {
			const match = /^t(\d+)$/.exec(record.shortRef);
			if (!match) continue;
			const parsed = Number.parseInt(match[1], 10);
			if (Number.isSafeInteger(parsed) && parsed > maxRefNumber) {
				maxRefNumber = parsed;
			}
		}
		this.shortRefCounter = maxRefNumber;
	}

	/** Look up a finalized record by short ref. */
	getRecordByRef(ref: string): ToolOutputRecord | undefined {
		return this.finalizedRecords.find((r) => r.shortRef === ref);
	}

	/** Look up a finalized record by toolCallId. */
	getRecordByToolCallId(toolCallId: string): ToolOutputRecord | undefined {
		return this.finalizedRecords.find((r) => r.toolCallId === toolCallId);
	}

	/** Look up a finalized record by entryId. */
	getRecordByEntryId(entryId: string): ToolOutputRecord | undefined {
		return this.finalizedRecords.find((r) => r.entryId === entryId);
	}

	/** Record safe, bounded reconstruction diagnostics. */
	recordReconstructionResult(
		result: ToolOutputMetadataReconstructionResult,
	): void {
		this.lastReconstructionStatus = result.ok
			? result.records.length > 0
				? "ok"
				: "skipped"
			: "error";
		this.lastReconstructionTime = Date.now();
		this.lastReconstructionError = result.ok
			? null
			: (result.error ?? "metadata reconstruction failed").slice(0, 160);
		this.lastReconstructionScannedEntries = result.scannedEntries;
		this.lastReconstructionScannedBytes = result.scannedBytes;
		this.lastReconstructionSkippedEntries = result.skippedEntries;
		this.lastReconstructedCount = result.ok ? result.records.length : 0;
	}

	/** Clear reconstruction diagnostics when pruning is disabled or state resets. */
	clearReconstructionResult(): void {
		this.lastReconstructionStatus = null;
		this.lastReconstructionTime = null;
		this.lastReconstructionError = null;
		this.lastReconstructionScannedEntries = 0;
		this.lastReconstructionScannedBytes = 0;
		this.lastReconstructionSkippedEntries = 0;
		this.lastReconstructedCount = 0;
	}

	/** Return a snapshot for testing/inspection. */
	snapshot(): ToolOutputPruningStateSnapshot {
		return {
			pendingBatches: this.pendingBatches.slice(),
			pendingRecords: this.pendingRecords.slice(),
			finalizedRecords: this.finalizedRecords.slice(),
			isFlushing: this.isFlushing,
			lastSummaryStatus: this.lastSummaryStatus,
			lastSummaryTime: this.lastSummaryTime,
			lastPrunedCount: this.lastPrunedCount,
			lastReconstructionStatus: this.lastReconstructionStatus,
			lastReconstructionTime: this.lastReconstructionTime,
			lastReconstructionError: this.lastReconstructionError,
			lastReconstructionScannedEntries: this.lastReconstructionScannedEntries,
			lastReconstructionScannedBytes: this.lastReconstructionScannedBytes,
			lastReconstructionSkippedEntries: this.lastReconstructionSkippedEntries,
			lastReconstructedCount: this.lastReconstructedCount,
			shortRefCounter: this.shortRefCounter,
		};
	}

	/**
	 * Reconcile finalized records against the current branch entry ids.
	 * Removes records whose entryId is no longer present.
	 */
	reconcileWithBranch(entryIds: Set<string>): void {
		this.finalizedRecords = this.finalizedRecords.filter(
			(r) => r.entryId !== null && entryIds.has(r.entryId),
		);
	}

	/** Count of finalized records currently in the active branch. */
	get activeRecordCount(): number {
		return this.finalizedRecords.filter((r) => r.entryId !== null).length;
	}
}
