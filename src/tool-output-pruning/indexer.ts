import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { recordMatchesBranchEntry } from "./record-identity.js";
import type { ToolOutputPruningState } from "./state.js";
import type {
	PendingToolOutputBatch,
	ToolOutputPruningSettings,
	ToolOutputRecord,
} from "./types.js";

/**
 * Represents a batch that has been summarized and is ready for indexing.
 */
export interface IndexedBatch {
	batch: PendingToolOutputBatch;
	records: ToolOutputRecord[];
	/** recordId -> summary text */
	summaries: Map<string, string>;
}

function findEntryIdForRecord(
	branchEntries: Array<{ type?: unknown; id: string; message: AgentMessage }>,
	record: ToolOutputRecord,
	settings: ToolOutputPruningSettings,
): string | null {
	for (const entry of branchEntries) {
		if (
			recordMatchesBranchEntry(
				entry,
				{ ...record, entryId: entry.id },
				settings,
			)
		) {
			return entry.id;
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
	branchEntries: Array<{ type?: unknown; id: string; message: AgentMessage }>,
	indexedBatches: IndexedBatch[],
	state: ToolOutputPruningState,
	settings: ToolOutputPruningSettings,
): void {
	for (const indexed of indexedBatches) {
		for (const record of indexed.records) {
			const entryId = findEntryIdForRecord(branchEntries, record, settings);
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
