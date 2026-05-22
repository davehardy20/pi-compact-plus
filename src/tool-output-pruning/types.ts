/**
 * Types for Compact+ experimental tool-output pruning.
 *
 * Adapted from pi-context-prune (MIT-licensed prior art) into Compact+.
 */

/** Maximum records captured in a single batch. */
export const MAX_RECORDS_PER_BATCH = 50;
/** Maximum pending batches before oldest are dropped. */
export const MAX_PENDING_BATCHES = 20;
/** Maximum pending records before oldest are dropped. */
export const MAX_PENDING_RECORDS = 100;
/** Maximum finalized records retained. */
export const MAX_FINALIZED_RECORDS = 500;
/** Maximum inputs sent to the LLM summarizer in one call. */
export const MAX_SUMMARIZER_INPUTS_PER_BATCH = 32;
/** Maximum finalized records scanned by the query tool. */
export const MAX_QUERY_SCAN_RECORDS = 500;
/** Maximum characters scanned from one original tool result for query matching. */
export const MAX_QUERY_SCAN_CHARS_PER_RECORD = 12000;
/** Maximum total original tool-result characters scanned by one query. */
export const MAX_QUERY_SCAN_TOTAL_CHARS = 50000;
/** Maximum total characters returned in a query result. */
export const MAX_QUERY_RESULT_CHARS = 50000;

export type ToolOutputPruningMode = "off" | "agent-message";
export type ToolOutputSummaryStrategy = "llm";
export type ToolOutputPruneStrategy = "stub" | "delete";
export type ToolOutputSummarizerThinking =
	| "default"
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export interface ToolOutputPruningSettings {
	experimentalToolOutputPruning: boolean;
	toolOutputPruningMode: ToolOutputPruningMode;
	toolOutputSummaryStrategy: ToolOutputSummaryStrategy;
	toolOutputPruneStrategy: ToolOutputPruneStrategy;
	toolOutputPruneMinChars: number;
	toolOutputSummaryMaxChars: number;
	toolOutputQueryMaxChars: number;
	toolOutputSummarizerModel: "default" | string;
	toolOutputSummarizerThinking: ToolOutputSummarizerThinking;
	toolOutputPruneExcludedTools: string[];
	toolOutputPruneIncludedTools: string[];
}

export interface ToolOutputRecord {
	recordId: string;
	entryId: string | null;
	toolCallId: string;
	toolName: string;
	timestamp: number;
	chars: number;
	isError: boolean;
	summary: string | null;
	shortRef: string;
	argsPreview: string | null;
	fallbackSnippets: string | null;
}

export interface PendingToolOutputBatch {
	batchId: string;
	turnIndex: number;
	timestamp: number;
	recordIds: string[];
}

export interface ToolOutputPruningStateSnapshot {
	pendingBatches: PendingToolOutputBatch[];
	pendingRecords: ToolOutputRecord[];
	finalizedRecords: ToolOutputRecord[];
	isFlushing: boolean;
	lastSummaryStatus: "ok" | "error" | null;
	lastSummaryTime: number | null;
	lastPrunedCount: number;
	shortRefCounter: number;
}

export interface QueryToolOutputParams {
	query?: string;
	recordId?: string;
	ref?: string;
	toolCallId?: string;
	toolName?: string;
	limit?: number;
	includeContent?: boolean;
}

export interface QueryToolOutputMatch {
	recordId: string;
	entryId: string | null;
	shortRef: string;
	toolCallId: string;
	toolName: string;
	timestamp: number;
	summary: string | null;
	chars: number;
	isError: boolean;
	inCurrentBranch: boolean;
	content?: string | null;
	contentTruncated?: boolean;
}

export interface QueryToolOutputResult {
	text: string;
	matches: QueryToolOutputMatch[];
	scannedRecords: number;
	truncated: boolean;
}
