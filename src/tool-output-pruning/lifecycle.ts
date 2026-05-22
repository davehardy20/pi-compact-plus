import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TOOL_PRUNE_SUMMARY_CUSTOM_TYPE } from "../types.js";
import {
	type CaptureBatchResult,
	captureBatch,
	extractToolResultText,
} from "./capture.js";
import { type IndexedBatch, indexToolResultsFromBranch } from "./indexer.js";
import { isToolOutputPruningEnabled } from "./policy.js";
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
	if (!isToolOutputPruningEnabled(settings)) return false;
	if (isCompacting) return false;
	if (state.isFlushing) return false;
	if (state.pendingBatches.length === 0) return false;
	return true;
}

/**
 * Check that an assistant message is a final text response, not a tool-use,
 * error, or aborted message. V1 intentionally flushes only from this safe
 * agent-message boundary and does not perform late agent_end summarization.
 */
export function isFinalAssistantMessageForToolPrune(
	message: AgentMessage,
): boolean {
	if (message.role !== "assistant") return false;

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
	return !content.some(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: string }).type === "toolCall",
	);
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
	branchEntries: Array<{ id: string; message: AgentMessage }>,
): import("./summarizer.js").SummarizerInput[] | null {
	const inputs: import("./summarizer.js").SummarizerInput[] = [];

	for (const record of pendingRecords) {
		const toolResult = branchEntries.find((e) => {
			const msg = e.message;
			return (
				msg.role === "toolResult" &&
				(msg as { toolCallId?: string }).toolCallId === record.toolCallId
			);
		})?.message;

		if (!toolResult) {
			return null;
		}

		const text = extractToolResultText(toolResult);
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
	branchEntries: Array<{ id: string; message: AgentMessage }>,
	pi: { appendEntry: (customType: string, data?: unknown) => void },
): Promise<FlushResult> {
	if (!isToolOutputPruningEnabled(settings)) {
		return { ok: false, indexedCount: 0, prunedCount: 0, error: "not enabled" };
	}

	if (state.pendingBatches.length === 0) {
		return { ok: true, indexedCount: 0, prunedCount: 0 };
	}

	state.isFlushing = true;
	// Snapshot the full finalized array because indexing may trim/replace it before
	// a later appendEntry side effect fails. Length-only rollback can keep failed
	// records while dropping older finalized records.
	const finalizedRecordsBefore = state.finalizedRecords.slice();

	try {
		const inputs = buildSummarizerInputs(state.pendingRecords, branchEntries);

		if (inputs === null) {
			// Atomicity violation: not all pending records are resolvable or within limits
			state.lastSummaryStatus = "error";
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
			state.lastSummaryStatus = "error";
			state.resetPending();
			return {
				ok: false,
				indexedCount: 0,
				prunedCount: 0,
				error: result.error,
			};
		}

		// Build indexed batches from pending state
		const indexedBatches: IndexedBatch[] = state.pendingBatches
			.map((batch) => {
				const records = state.pendingRecords.filter((r) =>
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

		indexToolResultsFromBranch(branchEntries, indexedBatches, state);

		// Append a compact summary entry for observability/recovery
		const refLines = state.finalizedRecords
			.map((r) => `${r.shortRef}: ${r.toolName}`)
			.join("\n");
		pi.appendEntry(TOOL_PRUNE_SUMMARY_CUSTOM_TYPE, {
			timestamp: Date.now(),
			refs: refLines,
			summaryChars: result.totalChars,
			recordCount: state.finalizedRecords.length,
		});

		state.lastSummaryStatus = "ok";
		state.lastSummaryTime = Date.now();
		state.resetPending();

		return {
			ok: true,
			indexedCount: state.finalizedRecords.length,
			prunedCount: 0,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Roll back any partially finalized records to preserve atomicity.
		state.finalizedRecords = finalizedRecordsBefore.slice();
		state.lastSummaryStatus = "error";
		state.resetPending();
		return {
			ok: false,
			indexedCount: 0,
			prunedCount: 0,
			error: `flush error: ${message}`,
		};
	} finally {
		state.isFlushing = false;
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
