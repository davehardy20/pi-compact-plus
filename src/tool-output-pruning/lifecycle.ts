import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getAssistantToolCallBlocks,
	isAssistantMessage,
} from "../pi-messages.js";
import { TOOL_PRUNE_SUMMARY_CUSTOM_TYPE } from "../types.js";
import { type CaptureBatchResult, captureBatch } from "./capture.js";
import { type IndexedBatch, indexToolResultsFromBranch } from "./indexer.js";
import { buildToolPruneSummaryData } from "./metadata.js";
import { isToolOutputPruningEnabled } from "./policy.js";
import {
	extractToolResultText,
	recordMatchesBranchEntry,
	type ToolOutputBranchEntry,
} from "./record-identity.js";
import type { ToolOutputPruningState } from "./state.js";
import { summarizeBatch } from "./summarizer.js";
import type { ToolOutputPruningSettings, ToolOutputRecord } from "./types.js";
import { MAX_SUMMARIZER_INPUTS_PER_BATCH } from "./types.js";

export interface FlushResult {
	ok: boolean;
	indexedCount: number;
	prunedCount: number;
	error?: string;
}

/**
 * Determine whether a message_end event should trigger a flush of pending batches.
 *
 * Requirements:
 * - Pruning must be effectively enabled.
 * - No auto-compaction may be in progress.
 * - No flush may already be in progress.
 * - There must be pending batches to flush.
 */
export function shouldFlushOnMessageEnd(
	state: ToolOutputPruningState,
	settings: ToolOutputPruningSettings,
	isCompacting: boolean,
): boolean {
	return state.canFlush(isToolOutputPruningEnabled(settings), isCompacting);
}

/**
 * Check that an assistant message is a final text response, not a tool-use,
 * error, or aborted message. V1 intentionally flushes only from this safe
 * agent-message boundary and does not perform late agent_end summarization.
 */
export function isFinalAssistantMessageForToolPrune(
	message: AgentMessage,
): boolean {
	if (!isAssistantMessage(message)) return false;

	const stopReason = (message as { stopReason?: string }).stopReason;
	if (
		stopReason === "toolUse" ||
		stopReason === "tool_use" ||
		stopReason === "error" ||
		stopReason === "aborted"
	) {
		return false;
	}

	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return true;
	return getAssistantToolCallBlocks(message).length === 0;
}

/**
 * Build summarizer inputs from pending records and the current branch.
 *
 * Looks up each pending record's original tool result text from the branch
 * by toolCallId. Returns `null` if any record is no longer in the branch or
 * if the total exceeds the summarizer limit, ensuring atomic all-record
 * summarization: either every pending record is summarized or none are.
 */
export function buildSummarizerInputs(
	pendingRecords: ToolOutputRecord[],
	branchEntries: ToolOutputBranchEntry[],
	settings: ToolOutputPruningSettings,
): import("./summarizer.js").SummarizerInput[] | null {
	const inputs: import("./summarizer.js").SummarizerInput[] = [];

	for (const record of pendingRecords) {
		const branchEntry = branchEntries.find((entry) =>
			recordMatchesBranchEntry(
				entry,
				{ ...record, entryId: entry.id },
				settings,
			),
		);
		if (!branchEntry) {
			return null;
		}

		const text = extractToolResultText(branchEntry.message);
		inputs.push({
			recordId: record.recordId,
			shortRef: record.shortRef,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			text,
			isError: record.isError,
			argsPreview: record.argsPreview,
		});
	}

	if (inputs.length > MAX_SUMMARIZER_INPUTS_PER_BATCH) {
		return null;
	}
	return inputs;
}

/**
 * Atomically flush pending batches: summarize, index, and append session entries.
 *
 * If summarization fails or aborts, pending batches are cleared but records
 * are not finalized and no pruning occurs. On success, indexed batches are
 * reconciled with the branch and a summary entry is appended.
 */
export async function flushPendingBatches(
	state: ToolOutputPruningState,
	settings: ToolOutputPruningSettings,
	ctx: ExtensionContext,
	branchEntries: ToolOutputBranchEntry[],
	pi: { appendEntry: (customType: string, data?: unknown) => void },
): Promise<FlushResult> {
	if (!isToolOutputPruningEnabled(settings)) {
		return { ok: false, indexedCount: 0, prunedCount: 0, error: "not enabled" };
	}

	if (!state.beginFlush()) {
		return { ok: true, indexedCount: 0, prunedCount: 0 };
	}

	// Snapshot the full finalized array because indexing may trim/replace it before
	// a later appendEntry side effect fails. Length-only rollback can keep failed
	// records while dropping older finalized records.
	const finalizedRecordsBefore = state.finalizedSnapshot();

	try {
		const pending = state.pendingSnapshot();
		const inputs = buildSummarizerInputs(
			pending.pendingRecords,
			branchEntries,
			settings,
		);

		if (inputs === null) {
			// Atomicity violation: not all pending records are resolvable or within limits
			state.recordSummaryError();
			state.resetPending();
			return {
				ok: false,
				indexedCount: 0,
				prunedCount: 0,
				error:
					"Not all pending records could be resolved for atomic summarization",
			};
		}

		const result = await summarizeBatch(inputs, settings, ctx);

		if (!result.ok) {
			state.recordSummaryError();
			state.resetPending();
			return {
				ok: false,
				indexedCount: 0,
				prunedCount: 0,
				error: result.error,
			};
		}

		// Build indexed batches from pending state
		const indexedBatches: IndexedBatch[] = pending.pendingBatches
			.map((batch) => {
				const records = pending.pendingRecords.filter((r) =>
					batch.recordIds.includes(r.recordId),
				);
				const summaries = new Map<string, string>();
				for (const record of records) {
					const summary = result.summaries.get(record.recordId);
					if (summary !== undefined) {
						summaries.set(record.recordId, summary);
					}
				}
				return { batch, records, summaries };
			})
			.filter((ib) => ib.records.length > 0);

		const indexedRecordIds = new Set(
			indexedBatches.flatMap((indexed) =>
				indexed.records.map((record) => record.recordId),
			),
		);
		indexToolResultsFromBranch(branchEntries, indexedBatches, state, settings);
		const finalizedRecords = state.finalizedSnapshot();
		const finalizedRecordsForMetadata = finalizedRecords.filter((record) =>
			indexedRecordIds.has(record.recordId),
		);

		// Append a compact summary entry for observability/recovery. The legacy
		// top-level fields are preserved for status/history compatibility; bounded
		// metadata is included separately for branch-safe reconstruction.
		pi.appendEntry(
			TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
			buildToolPruneSummaryData({
				allRecords: finalizedRecords,
				metadataRecords: finalizedRecordsForMetadata,
				settings,
				summaryChars: result.totalChars,
				timestamp: Date.now(),
			}),
		);

		state.recordSummarySuccess();
		state.resetPending();

		return {
			ok: true,
			indexedCount: finalizedRecords.length,
			prunedCount: 0,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Roll back any partially finalized records to preserve atomicity.
		state.replaceFinalizedRecords(finalizedRecordsBefore);
		state.recordSummaryError();
		state.resetPending();
		return {
			ok: false,
			indexedCount: 0,
			prunedCount: 0,
			error: `flush error: ${message}`,
		};
	} finally {
		state.endFlush();
	}
}

/**
 * Capture a batch of tool results from a turn_end event into pending state.
 *
 * Returns the capture result so callers can observe what was captured.
 */
export function captureTurnEndBatch(
	assistantMessage: AgentMessage,
	toolResults: AgentMessage[],
	turnIndex: number,
	timestamp: number,
	settings: ToolOutputPruningSettings,
	state: ToolOutputPruningState,
): CaptureBatchResult | null {
	if (!isToolOutputPruningEnabled(settings)) return null;

	const result = captureBatch(
		assistantMessage,
		toolResults,
		turnIndex,
		timestamp,
		settings,
		state,
	);

	if (result) {
		state.addPendingBatch(result.batch, result.records);
	}

	return result;
}
