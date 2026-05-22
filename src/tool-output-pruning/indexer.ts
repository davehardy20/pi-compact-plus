import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolOutputPruningState } from "./state.js";
import type { PendingToolOutputBatch, ToolOutputRecord } from "./types.js";

/**
 * Represents a batch that has been summarized and is ready for indexing.
 */
export interface IndexedBatch {
	batch: PendingToolOutputBatch;
	records: ToolOutputRecord[];
	/** recordId -> summary text */
	summaries: Map<string, string>;
}

/**
 * Find the session branch entry id for a given toolCallId.
 * Scans branch entries whose message role is "toolResult".
 *
 * Returns `null` if no matching entry is found.
 */
export function findEntryIdForToolCallId(
	branchEntries: Array<{ id: string; message: AgentMessage }>,
	toolCallId: string,
): string | null {
	for (const entry of branchEntries) {
		const msg = entry.message;
		if (msg.role === "toolResult") {
			const id = (msg as { toolCallId?: string }).toolCallId;
			if (id === toolCallId) {
				return entry.id;
			}
		}
	}
	return null;
}

/**
 * Reconcile summarized tool-output records with the current session branch.
 *
 * For each record, if the matching toolResult is still present in the branch,
 * the record's `entryId` is set and the record is moved into finalized state.
 * Records whose toolCallId no longer appears in the branch are discarded.
 *
 * After reconciliation, indexed pending batches are removed from state.
 *
 * Adapted from pi-context-prune (MIT-licensed prior art) into Compact+.
 */
export function indexToolResultsFromBranch(
	branchEntries: Array<{ id: string; message: AgentMessage }>,
	indexedBatches: IndexedBatch[],
	state: ToolOutputPruningState,
): void {
	for (const indexed of indexedBatches) {
		for (const record of indexed.records) {
			const entryId = findEntryIdForToolCallId(
				branchEntries,
				record.toolCallId,
			);
			if (entryId) {
				record.entryId = entryId;

				const summary = indexed.summaries.get(record.recordId);
				if (summary !== undefined) {
					record.summary = summary;
				}

				state.addFinalizedRecord(record);
			}
		}
	}

	// Remove indexed batches from pending
	const indexedBatchIds = new Set(indexedBatches.map((b) => b.batch.batchId));
	state.pendingBatches = state.pendingBatches.filter(
		(b) => !indexedBatchIds.has(b.batchId),
	);
}
