import type { ToolOutputRecord } from "./types.js";

/**
 * A single entry in the short-ref lookup map.
 */
export interface RefEntry {
	recordId: string;
	toolCallId: string;
	toolName: string;
	shortRef: string;
}

/**
 * Build a lookup map from short ref (e.g. `t1`) to ref metadata.
 *
 * Adapted from pi-context-prune (MIT-licensed prior art) into Compact+.
 */
export function buildRefMap(
	records: ToolOutputRecord[],
): Map<string, RefEntry> {
	const map = new Map<string, RefEntry>();
	for (const record of records) {
		map.set(record.shortRef, {
			recordId: record.recordId,
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			shortRef: record.shortRef,
		});
	}
	return map;
}

/**
 * Look up a ref entry by short ref string.
 */
export function lookupRef(
	ref: string,
	map: Map<string, RefEntry>,
): RefEntry | undefined {
	return map.get(ref);
}

/**
 * Format a single ref line for inclusion in a summary or index.
 */
export function formatRefLine(record: ToolOutputRecord): string {
	return `${record.shortRef}: ${record.toolName} (toolCallId=${record.toolCallId})`;
}

/**
 * Format a list of ref lines, one per record.
 */
export function formatRefList(records: ToolOutputRecord[]): string {
	return records.map(formatRefLine).join("\n");
}
