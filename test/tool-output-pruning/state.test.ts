import { beforeEach, describe, expect, it } from "vitest";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";
import {
	MAX_FINALIZED_RECORDS,
	MAX_PENDING_BATCHES,
	MAX_PENDING_RECORDS,
	type ToolOutputRecord,
} from "../../src/tool-output-pruning/types.js";
import {
	makePendingBatch,
	makeToolOutputRecord,
} from "../fixtures/tool-output-pruning.js";

describe("ToolOutputPruningState", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it("initializes with empty state", () => {
		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.finalizedRecords).toHaveLength(0);
		expect(state.isFlushing).toBe(false);
		expect(state.lastSummaryStatus).toBeNull();
		expect(state.lastSummaryTime).toBeNull();
		expect(state.lastPrunedCount).toBe(0);
		expect(state.lastReconstructionStatus).toBeNull();
		expect(state.lastReconstructionTime).toBeNull();
		expect(state.lastReconstructionError).toBeNull();
		expect(state.lastReconstructionScannedEntries).toBe(0);
		expect(state.lastReconstructionScannedBytes).toBe(0);
		expect(state.lastReconstructionSkippedEntries).toBe(0);
		expect(state.lastReconstructedCount).toBe(0);
		expect(state.shortRefCounter).toBe(0);
		expect(state.activeRecordCount).toBe(0);
	});

	it("reset clears all state", () => {
		state.pendingBatches.push(makePendingBatch({ batchId: "b1" }));
		state.pendingRecords.push(makeToolOutputRecord());
		state.finalizedRecords.push(
			makeToolOutputRecord({ entryId: "e1", summary: "summary" }),
		);
		state.isFlushing = true;
		state.lastSummaryStatus = "ok";
		state.lastSummaryTime = 12345;
		state.lastPrunedCount = 3;
		state.lastReconstructionStatus = "error";
		state.lastReconstructionTime = 12346;
		state.lastReconstructionError = "bad metadata";
		state.lastReconstructionScannedEntries = 4;
		state.lastReconstructionScannedBytes = 500;
		state.lastReconstructionSkippedEntries = 2;
		state.lastReconstructedCount = 1;
		state.shortRefCounter = 5;

		state.reset();

		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.finalizedRecords).toHaveLength(0);
		expect(state.isFlushing).toBe(false);
		expect(state.lastSummaryStatus).toBeNull();
		expect(state.lastSummaryTime).toBeNull();
		expect(state.lastPrunedCount).toBe(0);
		expect(state.lastReconstructionStatus).toBeNull();
		expect(state.lastReconstructionTime).toBeNull();
		expect(state.lastReconstructionError).toBeNull();
		expect(state.lastReconstructionScannedEntries).toBe(0);
		expect(state.lastReconstructionScannedBytes).toBe(0);
		expect(state.lastReconstructionSkippedEntries).toBe(0);
		expect(state.lastReconstructedCount).toBe(0);
		expect(state.shortRefCounter).toBe(0);
	});

	it("resetPending clears only pending batches, records, and flushing flag", () => {
		state.pendingBatches.push(makePendingBatch({ batchId: "b1" }));
		state.pendingRecords.push(makeToolOutputRecord());
		state.finalizedRecords.push(
			makeToolOutputRecord({ entryId: "e1", summary: "summary" }),
		);
		state.isFlushing = true;
		state.lastSummaryStatus = "ok";
		state.lastPrunedCount = 3;
		state.recordReconstructionResult({
			ok: false,
			records: [],
			inspectedEntries: 9,
			scannedEntries: 8,
			scannedBytes: 700,
			skippedEntries: 1,
			error: "metadata error",
		});

		state.resetPending();

		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.isFlushing).toBe(false);
		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.lastSummaryStatus).toBe("ok");
		expect(state.lastPrunedCount).toBe(3);
		expect(state.lastReconstructionStatus).toBe("error");
		expect(state.lastReconstructionError).toBe("metadata error");
	});

	it("generates sequential short refs", () => {
		expect(state.generateShortRef()).toBe("t1");
		expect(state.generateShortRef()).toBe("t2");
		expect(state.generateShortRef()).toBe("t3");
		expect(state.shortRefCounter).toBe(3);
	});

	it("advances short-ref allocation past reconstructed t-number records", () => {
		state.shortRefCounter = 2;

		state.advanceShortRefCounterFromRecords([
			makeToolOutputRecord({ shortRef: "t7" }),
			makeToolOutputRecord({ recordId: "r2", shortRef: "summary-9" }),
			makeToolOutputRecord({ recordId: "r3", shortRef: "t4" }),
		]);

		expect(state.shortRefCounter).toBe(7);
		expect(state.generateShortRef()).toBe("t8");
	});

	it("does not move the short-ref counter backwards from reconstructed records", () => {
		state.shortRefCounter = 10;

		state.advanceShortRefCounterFromRecords([
			makeToolOutputRecord({ shortRef: "t2" }),
			makeToolOutputRecord({ recordId: "r2", shortRef: "not-a-t-ref" }),
		]);

		expect(state.shortRefCounter).toBe(10);
		expect(state.generateShortRef()).toBe("t11");
	});

	it("looks up records by ref, toolCallId, and entryId", () => {
		const record = makeToolOutputRecord({
			entryId: "e1",
			summary: "summary",
		});
		state.finalizedRecords.push(record);

		expect(state.getRecordByRef("t1")).toBe(record);
		expect(state.getRecordByRef("t2")).toBeUndefined();
		expect(state.getRecordByToolCallId("tc1")).toBe(record);
		expect(state.getRecordByToolCallId("tc2")).toBeUndefined();
		expect(state.getRecordByEntryId("e1")).toBe(record);
		expect(state.getRecordByEntryId("e2")).toBeUndefined();
	});

	it("returns a snapshot copy", () => {
		state.pendingBatches.push(makePendingBatch({ timestamp: 1000 }));
		state.pendingRecords.push(makeToolOutputRecord({ timestamp: 1000 }));
		state.finalizedRecords.push(
			makeToolOutputRecord({
				entryId: "e1",
				timestamp: 1000,
				summary: "summary",
			}),
		);
		state.lastSummaryStatus = "ok";
		state.lastPrunedCount = 2;
		state.shortRefCounter = 1;

		const snap = state.snapshot();
		expect(snap.pendingBatches).toHaveLength(1);
		expect(snap.pendingRecords).toHaveLength(1);
		expect(snap.finalizedRecords).toHaveLength(1);
		expect(snap.lastSummaryStatus).toBe("ok");
		expect(snap.lastPrunedCount).toBe(2);
		expect(snap.shortRefCounter).toBe(1);

		snap.pendingBatches.pop();
		snap.pendingRecords.pop();
		snap.finalizedRecords.pop();
		expect(state.pendingBatches).toHaveLength(1);
		expect(state.pendingRecords).toHaveLength(1);
		expect(state.finalizedRecords).toHaveLength(1);
	});

	it("exposes intent snapshots without exposing mutable arrays", () => {
		state.addPendingBatch(makePendingBatch({ batchId: "b1" }), [
			makeToolOutputRecord({ recordId: "r1" }),
		]);
		state.addFinalizedRecord(
			makeToolOutputRecord({
				recordId: "f1",
				entryId: "e1",
				summary: "summary",
			}),
		);
		state.recordSummarySuccess(2);

		const pending = state.pendingSnapshot();
		const finalized = state.finalizedSnapshot();
		const status = state.statusSnapshot();

		pending.pendingBatches.pop();
		pending.pendingRecords.pop();
		finalized.pop();

		expect(state.pendingBatches).toHaveLength(1);
		expect(state.pendingRecords).toHaveLength(1);
		expect(state.finalizedRecords).toHaveLength(1);
		expect(status.lastSummaryStatus).toBe("ok");
		expect(status.lastPrunedCount).toBe(2);
		expect(status).not.toHaveProperty("pendingBatches");
	});

	it("guards flush begin/end through intent helpers", () => {
		expect(state.hasPending()).toBe(false);
		expect(state.canFlush(true, false)).toBe(false);
		expect(state.beginFlush()).toBe(false);

		state.addPendingBatch(makePendingBatch({ batchId: "b1" }), [
			makeToolOutputRecord({ recordId: "r1" }),
		]);

		expect(state.hasPending()).toBe(true);
		expect(state.canFlush(false, false)).toBe(false);
		expect(state.canFlush(true, true)).toBe(false);
		expect(state.canFlush(true, false)).toBe(true);
		expect(state.beginFlush()).toBe(true);
		expect(state.isFlushing).toBe(true);
		expect(state.canFlush(true, false)).toBe(false);
		expect(state.beginFlush()).toBe(false);

		state.endFlush();

		expect(state.isFlushing).toBe(false);
	});

	it("removes a pending batch and only its records by batch id", () => {
		state.addPendingBatch(
			makePendingBatch({ batchId: "b1", recordIds: ["r1"] }),
			[makeToolOutputRecord({ recordId: "r1" })],
		);
		state.addPendingBatch(
			makePendingBatch({ batchId: "b2", recordIds: ["r2"] }),
			[
				makeToolOutputRecord({
					recordId: "r2",
					toolCallId: "tc2",
					shortRef: "t2",
				}),
			],
		);

		expect(state.removePendingBatch("missing")).toBeUndefined();
		const removed = state.removePendingBatch("b1");

		expect(removed?.batchId).toBe("b1");
		expect(state.pendingBatches.map((batch) => batch.batchId)).toEqual(["b2"]);
		expect(state.pendingRecords.map((record) => record.recordId)).toEqual([
			"r2",
		]);
	});

	it("replaces finalized records through reconciliation helpers", () => {
		const original = makeToolOutputRecord({
			recordId: "r1",
			entryId: "e1",
			summary: "summary",
		});
		const replacement = makeToolOutputRecord({
			recordId: "r1",
			entryId: "e1-new",
			summary: "updated summary",
		});
		state.addFinalizedRecord(original);

		state.replaceFinalizedRecord(replacement);
		state.replaceFinalizedRecord(
			makeToolOutputRecord({
				recordId: "r2",
				entryId: "e2",
				toolCallId: "tc2",
				shortRef: "t2",
				summary: "second summary",
			}),
		);

		expect(state.finalizedRecords.map((record) => record.recordId)).toEqual([
			"r1",
			"r2",
		]);
		expect(state.finalizedRecords[0]?.summary).toBe("updated summary");
		expect(state.finalizedRecords[0]?.entryId).toBe("e1-new");

		state.replaceFinalizedRecords([original]);

		expect(state.finalizedRecords).toEqual([original]);
	});

	it("reconciles with branch entry ids", () => {
		state.finalizedRecords.push(
			makeToolOutputRecord({ entryId: "e1", summary: "summary" }),
			makeToolOutputRecord({
				recordId: "r2",
				entryId: "e2",
				toolCallId: "tc2",
				toolName: "read",
				chars: 200,
				summary: "summary2",
				shortRef: "t2",
			}),
			makeToolOutputRecord({
				recordId: "r3",
				entryId: null,
				toolCallId: "tc3",
				toolName: "edit",
				chars: 50,
				shortRef: "t3",
			}),
		);

		state.reconcileWithBranch(new Set(["e1"]));

		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.finalizedRecords[0]?.recordId).toBe("r1");
		expect(state.activeRecordCount).toBe(1);
	});

	it("activeRecordCount counts only records with entryId", () => {
		state.finalizedRecords.push(
			makeToolOutputRecord({ entryId: "e1", summary: "summary" }),
			makeToolOutputRecord({
				recordId: "r2",
				entryId: null,
				toolCallId: "tc2",
				toolName: "read",
				chars: 200,
				shortRef: "t2",
			}),
		);

		expect(state.activeRecordCount).toBe(1);
	});

	it("updates summary status and pruned count through intent helpers", () => {
		state.updatePrunedCount(3);
		expect(state.lastPrunedCount).toBe(3);
		expect(state.lastSummaryStatus).toBeNull();

		state.recordSummaryError();
		expect(state.lastSummaryStatus).toBe("error");
		expect(state.lastSummaryTime).not.toBeNull();
		expect(state.lastPrunedCount).toBe(3);

		state.recordSummarySuccess(5);
		expect(state.lastSummaryStatus).toBe("ok");
		expect(state.lastPrunedCount).toBe(5);
	});

	it("records ok reconstruction diagnostics with bounded counters", () => {
		const reconstructed = [
			makeToolOutputRecord({ recordId: "r1" }),
			makeToolOutputRecord({ recordId: "r2", toolCallId: "tc2" }),
		];

		state.recordReconstructionResult({
			ok: true,
			records: reconstructed,
			inspectedEntries: 5,
			scannedEntries: 4,
			scannedBytes: 1234,
			skippedEntries: 1,
		});

		expect(state.lastReconstructionStatus).toBe("ok");
		expect(state.lastReconstructionTime).not.toBeNull();
		expect(state.lastReconstructionError).toBeNull();
		expect(state.lastReconstructionScannedEntries).toBe(4);
		expect(state.lastReconstructionScannedBytes).toBe(1234);
		expect(state.lastReconstructionSkippedEntries).toBe(1);
		expect(state.lastReconstructedCount).toBe(2);
	});

	it("records skipped reconstruction diagnostics when no records are restored", () => {
		state.recordReconstructionResult({
			ok: true,
			records: [],
			inspectedEntries: 3,
			scannedEntries: 3,
			scannedBytes: 99,
			skippedEntries: 0,
		});

		expect(state.lastReconstructionStatus).toBe("skipped");
		expect(state.lastReconstructedCount).toBe(0);
	});

	it("records truncated reconstruction errors and clears diagnostics", () => {
		state.recordReconstructionResult({
			ok: false,
			records: [makeToolOutputRecord({ recordId: "ignored" })],
			inspectedEntries: 6,
			scannedEntries: 6,
			scannedBytes: 2048,
			skippedEntries: 2,
			error: "x".repeat(200),
		});

		expect(state.lastReconstructionStatus).toBe("error");
		expect(state.lastReconstructionError).toBe("x".repeat(160));
		expect(state.lastReconstructedCount).toBe(0);

		state.clearReconstructionResult();

		expect(state.lastReconstructionStatus).toBeNull();
		expect(state.lastReconstructionTime).toBeNull();
		expect(state.lastReconstructionError).toBeNull();
		expect(state.lastReconstructionScannedEntries).toBe(0);
		expect(state.lastReconstructionScannedBytes).toBe(0);
		expect(state.lastReconstructionSkippedEntries).toBe(0);
		expect(state.lastReconstructedCount).toBe(0);
	});
});

describe("ToolOutputPruningState bounded limits", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it("addPendingBatch drops oldest batches when over MAX_PENDING_BATCHES", () => {
		for (let i = 0; i < MAX_PENDING_BATCHES + 5; i++) {
			state.addPendingBatch(
				makePendingBatch({
					batchId: `b${i}`,
					turnIndex: i,
					recordIds: [`r${i}`],
				}),
				[
					makeToolOutputRecord({
						recordId: `r${i}`,
						toolCallId: `tc${i}`,
						shortRef: `t${i + 1}`,
					}),
				],
			);
		}
		expect(state.pendingBatches.length).toBe(MAX_PENDING_BATCHES);
		expect(state.pendingRecords.length).toBe(MAX_PENDING_BATCHES);
		expect(state.pendingBatches[0]?.batchId).toBe("b5");
	});

	it("addPendingBatch drops oldest records when over MAX_PENDING_RECORDS", () => {
		const records: ToolOutputRecord[] = [];
		for (let i = 0; i < MAX_PENDING_RECORDS + 10; i++) {
			records.push(
				makeToolOutputRecord({
					recordId: `r${i}`,
					toolCallId: `tc${i}`,
					shortRef: `t${i + 1}`,
				}),
			);
		}
		state.addPendingBatch(
			makePendingBatch({
				batchId: "b0",
				turnIndex: 0,
				recordIds: records.map((r) => r.recordId),
			}),
			records,
		);
		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
	});

	it("addPendingBatch trims orphaned pending records to the newest MAX_PENDING_RECORDS", () => {
		const records: ToolOutputRecord[] = [];
		for (let i = 0; i < MAX_PENDING_RECORDS + 10; i++) {
			records.push(
				makeToolOutputRecord({
					recordId: `orphan-${i}`,
					toolCallId: `tc-orphan-${i}`,
					shortRef: `t${i + 1}`,
				}),
			);
		}
		state.pendingRecords = records;

		state.addPendingBatch(
			makePendingBatch({ batchId: "b0", recordIds: [] }),
			[],
		);

		expect(state.pendingRecords).toHaveLength(MAX_PENDING_RECORDS);
		expect(state.pendingRecords[0]?.recordId).toBe("orphan-10");
	});

	it("addFinalizedRecord enforces MAX_FINALIZED_RECORDS", () => {
		for (let i = 0; i < MAX_FINALIZED_RECORDS + 10; i++) {
			state.addFinalizedRecord(
				makeToolOutputRecord({
					recordId: `r${i}`,
					entryId: `e${i}`,
					toolCallId: `tc${i}`,
					summary: "summary",
					shortRef: `t${i + 1}`,
				}),
			);
		}
		expect(state.finalizedRecords.length).toBe(MAX_FINALIZED_RECORDS);
		expect(state.finalizedRecords[0]?.recordId).toBe("r10");
	});

	it("addFinalizedRecord deduplicates by recordId", () => {
		const record = makeToolOutputRecord({
			entryId: "e1",
			summary: "summary",
		});
		state.addFinalizedRecord(record);
		state.addFinalizedRecord({
			...record,
			entryId: "new-entry-for-same-record-id",
			summary: "new summary should not replace existing record",
		});
		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.finalizedRecords[0]).toBe(record);
		expect(state.finalizedRecords[0]?.entryId).toBe("e1");
	});
});
