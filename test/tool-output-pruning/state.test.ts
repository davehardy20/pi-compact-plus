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
		state.shortRefCounter = 5;

		state.reset();

		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.finalizedRecords).toHaveLength(0);
		expect(state.isFlushing).toBe(false);
		expect(state.lastSummaryStatus).toBeNull();
		expect(state.lastSummaryTime).toBeNull();
		expect(state.lastPrunedCount).toBe(0);
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

		state.resetPending();

		expect(state.pendingBatches).toHaveLength(0);
		expect(state.pendingRecords).toHaveLength(0);
		expect(state.isFlushing).toBe(false);
		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.lastSummaryStatus).toBe("ok");
		expect(state.lastPrunedCount).toBe(3);
	});

	it("generates sequential short refs", () => {
		expect(state.generateShortRef()).toBe("t1");
		expect(state.generateShortRef()).toBe("t2");
		expect(state.generateShortRef()).toBe("t3");
		expect(state.shortRefCounter).toBe(3);
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
		expect(state.pendingRecords.length).toBeLessThanOrEqual(
			MAX_PENDING_RECORDS,
		);
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
		state.addFinalizedRecord(record);
		expect(state.finalizedRecords.length).toBe(1);
	});
});
