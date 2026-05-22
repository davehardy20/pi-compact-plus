import { beforeEach, describe, expect, it } from "vitest";
import { ToolOutputPruningState } from "../../src/tool-output-pruning/state.js";

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
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 1,
			timestamp: Date.now(),
			recordIds: ["r1"],
		});
		state.pendingRecords.push({
			recordId: "r1",
			entryId: null,
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: null,
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
		state.finalizedRecords.push({
			recordId: "r1",
			entryId: "e1",
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: "summary",
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
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
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 1,
			timestamp: Date.now(),
			recordIds: ["r1"],
		});
		state.pendingRecords.push({
			recordId: "r1",
			entryId: null,
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: null,
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
		state.finalizedRecords.push({
			recordId: "r1",
			entryId: "e1",
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: "summary",
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
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
		const record = {
			recordId: "r1",
			entryId: "e1",
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: "summary",
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		};
		state.finalizedRecords.push(record);

		expect(state.getRecordByRef("t1")).toBe(record);
		expect(state.getRecordByRef("t2")).toBeUndefined();
		expect(state.getRecordByToolCallId("tc1")).toBe(record);
		expect(state.getRecordByToolCallId("tc2")).toBeUndefined();
		expect(state.getRecordByEntryId("e1")).toBe(record);
		expect(state.getRecordByEntryId("e2")).toBeUndefined();
	});

	it("returns a snapshot copy", () => {
		state.pendingBatches.push({
			batchId: "b1",
			turnIndex: 1,
			timestamp: 1000,
			recordIds: ["r1"],
		});
		state.pendingRecords.push({
			recordId: "r1",
			entryId: null,
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: 1000,
			chars: 100,
			isError: false,
			summary: null,
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
		state.finalizedRecords.push({
			recordId: "r1",
			entryId: "e1",
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: 1000,
			chars: 100,
			isError: false,
			summary: "summary",
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		});
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

		// Mutating snapshot should not affect state
		snap.pendingBatches.pop();
		snap.pendingRecords.pop();
		snap.finalizedRecords.pop();
		expect(state.pendingBatches).toHaveLength(1);
		expect(state.pendingRecords).toHaveLength(1);
		expect(state.finalizedRecords).toHaveLength(1);
	});

	it("reconciles with branch entry ids", () => {
		state.finalizedRecords.push(
			{
				recordId: "r1",
				entryId: "e1",
				toolCallId: "tc1",
				toolName: "bash",
				timestamp: Date.now(),
				chars: 100,
				isError: false,
				summary: "summary",
				shortRef: "t1",
				argsPreview: null,
				fallbackSnippets: null,
			},
			{
				recordId: "r2",
				entryId: "e2",
				toolCallId: "tc2",
				toolName: "read",
				timestamp: Date.now(),
				chars: 200,
				isError: false,
				summary: "summary2",
				shortRef: "t2",
				argsPreview: null,
				fallbackSnippets: null,
			},
			{
				recordId: "r3",
				entryId: null,
				toolCallId: "tc3",
				toolName: "edit",
				timestamp: Date.now(),
				chars: 50,
				isError: false,
				summary: null,
				shortRef: "t3",
				argsPreview: null,
				fallbackSnippets: null,
			},
		);

		state.reconcileWithBranch(new Set(["e1"]));

		expect(state.finalizedRecords).toHaveLength(1);
		expect(state.finalizedRecords[0]?.recordId).toBe("r1");
		expect(state.activeRecordCount).toBe(1);
	});

	it("activeRecordCount counts only records with entryId", () => {
		state.finalizedRecords.push(
			{
				recordId: "r1",
				entryId: "e1",
				toolCallId: "tc1",
				toolName: "bash",
				timestamp: Date.now(),
				chars: 100,
				isError: false,
				summary: "summary",
				shortRef: "t1",
				argsPreview: null,
				fallbackSnippets: null,
			},
			{
				recordId: "r2",
				entryId: null,
				toolCallId: "tc2",
				toolName: "read",
				timestamp: Date.now(),
				chars: 200,
				isError: false,
				summary: null,
				shortRef: "t2",
				argsPreview: null,
				fallbackSnippets: null,
			},
		);

		expect(state.activeRecordCount).toBe(1);
	});
});

import {
	MAX_FINALIZED_RECORDS,
	MAX_PENDING_BATCHES,
	MAX_PENDING_RECORDS,
} from "../../src/tool-output-pruning/types.js";

describe("ToolOutputPruningState bounded limits", () => {
	let state: ToolOutputPruningState;

	beforeEach(() => {
		state = new ToolOutputPruningState();
	});

	it("addPendingBatch drops oldest batches when over MAX_PENDING_BATCHES", () => {
		for (let i = 0; i < MAX_PENDING_BATCHES + 5; i++) {
			const batch = {
				batchId: `b${i}`,
				turnIndex: i,
				timestamp: Date.now(),
				recordIds: [`r${i}`],
			};
			const record = {
				recordId: `r${i}`,
				entryId: null,
				toolCallId: `tc${i}`,
				toolName: "bash",
				timestamp: Date.now(),
				chars: 100,
				isError: false,
				summary: null,
				shortRef: `t${i + 1}`,
				argsPreview: null,
				fallbackSnippets: null,
			};
			state.addPendingBatch(batch, [record]);
		}
		expect(state.pendingBatches.length).toBe(MAX_PENDING_BATCHES);
		expect(state.pendingRecords.length).toBe(MAX_PENDING_BATCHES);
		// Oldest batches should have been dropped
		expect(state.pendingBatches[0]?.batchId).toBe(`b5`);
	});

	it("addPendingBatch drops oldest records when over MAX_PENDING_RECORDS", () => {
		// Add one batch with many records to exceed the record limit
		const records: import("../../src/tool-output-pruning/types.js").ToolOutputRecord[] =
			[];
		for (let i = 0; i < MAX_PENDING_RECORDS + 10; i++) {
			records.push({
				recordId: `r${i}`,
				entryId: null,
				toolCallId: `tc${i}`,
				toolName: "bash",
				timestamp: Date.now(),
				chars: 100,
				isError: false,
				summary: null,
				shortRef: `t${i + 1}`,
				argsPreview: null,
				fallbackSnippets: null,
			});
		}
		const batch = {
			batchId: "b0",
			turnIndex: 0,
			timestamp: Date.now(),
			recordIds: records.map((r) => r.recordId),
		};
		state.addPendingBatch(batch, records);
		expect(state.pendingRecords.length).toBeLessThanOrEqual(
			MAX_PENDING_RECORDS,
		);
	});

	it("addFinalizedRecord enforces MAX_FINALIZED_RECORDS", () => {
		for (let i = 0; i < MAX_FINALIZED_RECORDS + 10; i++) {
			state.addFinalizedRecord({
				recordId: `r${i}`,
				entryId: `e${i}`,
				toolCallId: `tc${i}`,
				toolName: "bash",
				timestamp: Date.now(),
				chars: 100,
				isError: false,
				summary: "summary",
				shortRef: `t${i + 1}`,
				argsPreview: null,
				fallbackSnippets: null,
			});
		}
		expect(state.finalizedRecords.length).toBe(MAX_FINALIZED_RECORDS);
		// Oldest records should have been dropped
		expect(state.finalizedRecords[0]?.recordId).toBe(`r10`);
	});

	it("addFinalizedRecord deduplicates by recordId", () => {
		const record = {
			recordId: "r1",
			entryId: "e1",
			toolCallId: "tc1",
			toolName: "bash",
			timestamp: Date.now(),
			chars: 100,
			isError: false,
			summary: "summary",
			shortRef: "t1",
			argsPreview: null,
			fallbackSnippets: null,
		};
		state.addFinalizedRecord(record);
		state.addFinalizedRecord(record);
		expect(state.finalizedRecords.length).toBe(1);
	});
});
