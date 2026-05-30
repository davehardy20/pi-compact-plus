import { getToolName } from "../pi-messages.js";
import { TOOL_PRUNE_SUMMARY_CUSTOM_TYPE } from "../types.js";
import { isExcludedTool, isTextOnlyToolResult } from "./capture.js";
import {
	branchEntryMatchesToolOutputRecord,
	type ToolOutputBranchEntry,
} from "./pruner.js";
import {
	MAX_FINALIZED_RECORDS,
	type ToolOutputPruningSettings,
	type ToolOutputRecord,
} from "./types.js";

export const TOOL_PRUNE_METADATA_SCHEMA_VERSION = 1;
export const TOOL_PRUNE_METADATA_SOURCE = "compact-plus-tool-output-pruning";
export const MAX_RECONSTRUCTION_BRANCH_SCAN_ENTRIES = 20_000;
export const MAX_RECONSTRUCTION_SCAN_ENTRIES = 100;
export const MAX_RECONSTRUCTION_SCAN_BYTES = 200_000;
export const MAX_RECONSTRUCTED_ID_CHARS = 512;
export const MAX_RECONSTRUCTED_TOOL_NAME_CHARS = 128;
export const MAX_RECONSTRUCTED_SHORT_REF_CHARS = 32;
export const MAX_RECONSTRUCTED_SUMMARY_CHARS = 4_000;
export const MAX_RECONSTRUCTED_ARGS_PREVIEW_CHARS = 200;
export const MAX_RECONSTRUCTED_CHARS_VALUE = 100_000_000;

export interface ToolOutputRecordMetadata {
	recordId: string;
	entryId: string;
	toolCallId: string;
	toolName: string;
	timestamp: number;
	chars: number;
	isError: boolean;
	summary: string | null;
	shortRef: string;
	argsPreview: string | null;
	/** Always null in durable metadata; original-output snippets are not persisted. */
	fallbackSnippets: null;
}

export interface ToolPrunePersistedMetadata {
	schemaVersion: typeof TOOL_PRUNE_METADATA_SCHEMA_VERSION;
	source: typeof TOOL_PRUNE_METADATA_SOURCE;
	createdAt: number;
	recordCount: number;
	records: ToolOutputRecordMetadata[];
}

export interface ToolPruneSummaryData {
	timestamp: number;
	refs: string;
	summaryChars: number;
	recordCount: number;
	metadata?: ToolPrunePersistedMetadata;
}

export interface BuildToolPruneSummaryDataOptions {
	allRecords: ToolOutputRecord[];
	metadataRecords: ToolOutputRecord[];
	summaryChars: number;
	timestamp: number;
	settings: ToolOutputPruningSettings;
}

export interface ToolOutputMetadataReconstructionResult {
	ok: boolean;
	records: ToolOutputRecord[];
	inspectedEntries: number;
	scannedEntries: number;
	scannedBytes: number;
	skippedEntries: number;
	error?: string;
}

interface ToolPruneCustomEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolPruneSummaryEntry(
	entry: ToolPruneCustomEntry,
): entry is ToolPruneCustomEntry {
	return (
		entry.type === "custom" &&
		entry.customType === TOOL_PRUNE_SUMMARY_CUSTOM_TYPE
	);
}

function safeJsonSize(value: unknown): number | null {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return null;
	}
}

function isNonNegativeSafeInteger(
	value: unknown,
	max: number,
): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= max
	);
}

function truncateNullableString(
	value: string | null,
	maxChars: number,
): string | null {
	if (value === null) return null;
	if (value.length <= maxChars) return value;
	return value.slice(0, maxChars);
}

function requireBoundedString(
	value: string,
	fieldName: string,
	maxChars: number,
): string {
	if (value.length === 0 || value.length > maxChars) {
		throw new Error(`${fieldName} exceeds durable metadata bounds`);
	}
	return value;
}

function toMetadataRecord(
	record: ToolOutputRecord,
	settings: ToolOutputPruningSettings,
): ToolOutputRecordMetadata {
	if (record.entryId === null) {
		throw new Error("cannot persist metadata for a record without entryId");
	}
	if (!isNonNegativeSafeInteger(record.timestamp, Number.MAX_SAFE_INTEGER)) {
		throw new Error("record timestamp exceeds durable metadata bounds");
	}
	if (!isNonNegativeSafeInteger(record.chars, MAX_RECONSTRUCTED_CHARS_VALUE)) {
		throw new Error("record chars exceeds durable metadata bounds");
	}

	return {
		recordId: requireBoundedString(
			record.recordId,
			"recordId",
			MAX_RECONSTRUCTED_ID_CHARS,
		),
		entryId: requireBoundedString(
			record.entryId,
			"entryId",
			MAX_RECONSTRUCTED_ID_CHARS,
		),
		toolCallId: requireBoundedString(
			record.toolCallId,
			"toolCallId",
			MAX_RECONSTRUCTED_ID_CHARS,
		),
		toolName: requireBoundedString(
			record.toolName,
			"toolName",
			MAX_RECONSTRUCTED_TOOL_NAME_CHARS,
		),
		timestamp: record.timestamp,
		chars: record.chars,
		isError: record.isError,
		summary: truncateNullableString(
			record.summary,
			Math.min(
				settings.toolOutputSummaryMaxChars,
				MAX_RECONSTRUCTED_SUMMARY_CHARS,
			),
		),
		shortRef: requireBoundedString(
			record.shortRef,
			"shortRef",
			MAX_RECONSTRUCTED_SHORT_REF_CHARS,
		),
		argsPreview: truncateNullableString(
			record.argsPreview,
			MAX_RECONSTRUCTED_ARGS_PREVIEW_CHARS,
		),
		fallbackSnippets: null,
	};
}

function buildRefLine(record: ToolOutputRecord): string {
	const shortRef = record.shortRef.slice(0, MAX_RECONSTRUCTED_SHORT_REF_CHARS);
	const toolName = record.toolName.slice(0, MAX_RECONSTRUCTED_TOOL_NAME_CHARS);
	return `${shortRef}: ${toolName}`;
}

export function buildToolPruneSummaryData(
	opts: BuildToolPruneSummaryDataOptions,
): ToolPruneSummaryData {
	if (opts.allRecords.length > MAX_FINALIZED_RECORDS) {
		throw new Error(`summary record count exceeded ${MAX_FINALIZED_RECORDS}`);
	}
	if (opts.metadataRecords.length > MAX_FINALIZED_RECORDS) {
		throw new Error(`metadata record count exceeded ${MAX_FINALIZED_RECORDS}`);
	}

	const refs = opts.allRecords.map(buildRefLine).join("\n");
	const records = opts.metadataRecords.map((record) =>
		toMetadataRecord(record, opts.settings),
	);

	const data: ToolPruneSummaryData = {
		timestamp: opts.timestamp,
		refs,
		summaryChars: opts.summaryChars,
		recordCount: opts.allRecords.length,
		metadata: {
			schemaVersion: TOOL_PRUNE_METADATA_SCHEMA_VERSION,
			source: TOOL_PRUNE_METADATA_SOURCE,
			createdAt: opts.timestamp,
			recordCount: records.length,
			records,
		},
	};
	const serializedBytes = safeJsonSize(data);
	if (serializedBytes === null) {
		throw new Error("metadata payload is not JSON serializable");
	}
	if (serializedBytes > MAX_RECONSTRUCTION_SCAN_BYTES) {
		throw new Error(
			`metadata payload exceeded ${MAX_RECONSTRUCTION_SCAN_BYTES} bytes`,
		);
	}

	return data;
}

function fail(
	message: string,
	inspectedEntries: number,
	scannedEntries: number,
	scannedBytes: number,
	skippedEntries: number,
): ToolOutputMetadataReconstructionResult {
	return {
		ok: false,
		records: [],
		inspectedEntries,
		scannedEntries,
		scannedBytes,
		skippedEntries,
		error: message,
	};
}

function getString(
	value: Record<string, unknown>,
	key: keyof ToolOutputRecordMetadata,
	maxChars: number,
): string | null {
	const field = value[key];
	return typeof field === "string" &&
		field.length > 0 &&
		field.length <= maxChars
		? field
		: null;
}

function getNullableString(
	value: Record<string, unknown>,
	key: keyof ToolOutputRecordMetadata,
	maxChars: number,
): string | null | undefined {
	const field = value[key];
	if (field === null) return null;
	if (typeof field !== "string") return undefined;
	if (field.length > maxChars) return undefined;
	return field;
}

function getNonNegativeInteger(
	value: Record<string, unknown>,
	key: keyof ToolOutputRecordMetadata,
	max: number,
): number | null {
	const field = value[key];
	return isNonNegativeSafeInteger(field, max) ? field : null;
}

function buildBranchEntryById(
	branchEntries: ToolOutputBranchEntry[],
): { entriesById: Map<string, ToolOutputBranchEntry> } | { error: string } {
	if (branchEntries.length > MAX_RECONSTRUCTION_BRANCH_SCAN_ENTRIES) {
		return {
			error: `branch message scan exceeded ${MAX_RECONSTRUCTION_BRANCH_SCAN_ENTRIES} entries`,
		};
	}
	const entriesById = new Map<string, ToolOutputBranchEntry>();
	for (const entry of branchEntries) {
		entriesById.set(entry.id, entry);
	}
	return { entriesById };
}

function validateMetadataRecord(
	value: unknown,
	settings: ToolOutputPruningSettings,
	branchEntryById: Map<string, ToolOutputBranchEntry>,
): { record: ToolOutputRecord } | { error: string } {
	if (!isObject(value)) {
		return { error: "metadata record is not an object" };
	}

	const recordId = getString(value, "recordId", MAX_RECONSTRUCTED_ID_CHARS);
	const entryId = getString(value, "entryId", MAX_RECONSTRUCTED_ID_CHARS);
	const toolCallId = getString(value, "toolCallId", MAX_RECONSTRUCTED_ID_CHARS);
	const toolName = getString(
		value,
		"toolName",
		MAX_RECONSTRUCTED_TOOL_NAME_CHARS,
	);
	const shortRef = getString(
		value,
		"shortRef",
		MAX_RECONSTRUCTED_SHORT_REF_CHARS,
	);
	const timestamp = getNonNegativeInteger(
		value,
		"timestamp",
		Number.MAX_SAFE_INTEGER,
	);
	const chars = getNonNegativeInteger(
		value,
		"chars",
		MAX_RECONSTRUCTED_CHARS_VALUE,
	);
	const isError = value.isError;
	const summary = getNullableString(
		value,
		"summary",
		Math.min(
			settings.toolOutputSummaryMaxChars,
			MAX_RECONSTRUCTED_SUMMARY_CHARS,
		),
	);
	const argsPreview = getNullableString(
		value,
		"argsPreview",
		MAX_RECONSTRUCTED_ARGS_PREVIEW_CHARS,
	);

	if (
		!recordId ||
		!entryId ||
		!toolCallId ||
		!toolName ||
		!shortRef ||
		timestamp === null ||
		chars === null ||
		typeof isError !== "boolean" ||
		summary === undefined ||
		argsPreview === undefined ||
		value.fallbackSnippets !== null
	) {
		return { error: "metadata record has invalid fields" };
	}
	if (!/^t\d+$/.test(shortRef)) {
		return { error: "metadata record has invalid short ref" };
	}
	if (isExcludedTool(toolName, settings)) {
		return { error: `metadata record uses excluded tool ${toolName}` };
	}
	if (
		settings.toolOutputPruneIncludedTools.length > 0 &&
		!settings.toolOutputPruneIncludedTools.includes(toolName)
	) {
		return { error: `metadata record tool ${toolName} is not included` };
	}

	const record: ToolOutputRecord = {
		recordId,
		entryId,
		toolCallId,
		toolName,
		timestamp,
		chars,
		isError,
		summary,
		shortRef,
		argsPreview,
		fallbackSnippets: null,
	};
	const matchingEntry = branchEntryById.get(entryId);
	if (
		!matchingEntry ||
		!branchEntryMatchesToolOutputRecord(matchingEntry, record)
	) {
		return { error: "metadata record does not match current branch" };
	}
	if (getToolName(matchingEntry.message) !== toolName) {
		return { error: "metadata record tool name does not match current branch" };
	}
	if (!isTextOnlyToolResult(matchingEntry.message)) {
		return { error: "metadata record branch tool result is not text-only" };
	}

	return { record };
}

function isDuplicate(
	record: ToolOutputRecord,
	seenRecordIds: Set<string>,
	seenEntryIds: Set<string>,
	seenShortRefs: Set<string>,
): boolean {
	return (
		seenRecordIds.has(record.recordId) ||
		(record.entryId !== null && seenEntryIds.has(record.entryId)) ||
		seenShortRefs.has(record.shortRef)
	);
}

function validateMetadataHeader(
	metadata: Record<string, unknown>,
): { records: unknown[] } | { error: string } | { skip: true } {
	if (metadata.schemaVersion !== TOOL_PRUNE_METADATA_SCHEMA_VERSION) {
		return { skip: true };
	}
	if (metadata.source !== TOOL_PRUNE_METADATA_SOURCE) {
		return { error: "metadata source is invalid" };
	}
	if (!isNonNegativeSafeInteger(metadata.createdAt, Number.MAX_SAFE_INTEGER)) {
		return { error: "metadata createdAt is invalid" };
	}
	if (!isNonNegativeSafeInteger(metadata.recordCount, MAX_FINALIZED_RECORDS)) {
		return { error: "metadata recordCount is invalid" };
	}
	if (!Array.isArray(metadata.records)) {
		return { error: "metadata records are invalid" };
	}
	if (metadata.recordCount !== metadata.records.length) {
		return { error: "metadata recordCount does not match records length" };
	}
	return { records: metadata.records };
}

/**
 * Reconstruct bounded pruning metadata from current-branch summary entries.
 *
 * This never reconstructs or persists original tool output. Recovered records
 * become usable only when their metadata matches an active branch tool-result
 * entry by entryId, toolCallId, toolName, role, and text-only content.
 */
export function reconstructToolOutputRecordsFromBranch(
	branch: ToolPruneCustomEntry[],
	branchEntries: ToolOutputBranchEntry[],
	settings: ToolOutputPruningSettings,
): ToolOutputMetadataReconstructionResult {
	let inspectedEntries = 0;
	let scannedEntries = 0;
	let scannedBytes = 0;
	let skippedEntries = 0;

	const branchEntryMap = buildBranchEntryById(branchEntries);
	if ("error" in branchEntryMap) {
		return fail(
			branchEntryMap.error,
			inspectedEntries,
			scannedEntries,
			scannedBytes,
			skippedEntries,
		);
	}

	const records: ToolOutputRecord[] = [];
	const seenRecordIds = new Set<string>();
	const seenEntryIds = new Set<string>();
	const seenShortRefs = new Set<string>();

	for (const entry of branch) {
		inspectedEntries++;
		if (inspectedEntries > MAX_RECONSTRUCTION_BRANCH_SCAN_ENTRIES) {
			return fail(
				`branch metadata scan exceeded ${MAX_RECONSTRUCTION_BRANCH_SCAN_ENTRIES} entries`,
				inspectedEntries,
				scannedEntries,
				scannedBytes,
				skippedEntries,
			);
		}
		if (!isToolPruneSummaryEntry(entry)) {
			continue;
		}

		scannedEntries++;
		if (scannedEntries > MAX_RECONSTRUCTION_SCAN_ENTRIES) {
			return fail(
				`too many metadata entries: ${scannedEntries}`,
				inspectedEntries,
				scannedEntries,
				scannedBytes,
				skippedEntries,
			);
		}

		const size = safeJsonSize(entry.data);
		if (size === null) {
			return fail(
				"metadata entry is not JSON serializable",
				inspectedEntries,
				scannedEntries,
				scannedBytes,
				skippedEntries,
			);
		}
		scannedBytes += size;
		if (scannedBytes > MAX_RECONSTRUCTION_SCAN_BYTES) {
			return fail(
				`metadata scan exceeded ${MAX_RECONSTRUCTION_SCAN_BYTES} bytes`,
				inspectedEntries,
				scannedEntries,
				scannedBytes,
				skippedEntries,
			);
		}

		if (!isObject(entry.data) || !("metadata" in entry.data)) {
			skippedEntries++;
			continue;
		}
		const metadata = entry.data.metadata;
		if (!isObject(metadata)) {
			return fail(
				"metadata payload is invalid",
				inspectedEntries,
				scannedEntries,
				scannedBytes,
				skippedEntries,
			);
		}

		const header = validateMetadataHeader(metadata);
		if ("skip" in header) {
			skippedEntries++;
			continue;
		}
		if ("error" in header) {
			return fail(
				header.error,
				inspectedEntries,
				scannedEntries,
				scannedBytes,
				skippedEntries,
			);
		}
		if (records.length + header.records.length > MAX_FINALIZED_RECORDS) {
			return fail(
				`metadata record count exceeded ${MAX_FINALIZED_RECORDS}`,
				inspectedEntries,
				scannedEntries,
				scannedBytes,
				skippedEntries,
			);
		}

		for (const rawRecord of header.records) {
			const result = validateMetadataRecord(
				rawRecord,
				settings,
				branchEntryMap.entriesById,
			);
			if ("error" in result) {
				return fail(
					result.error,
					inspectedEntries,
					scannedEntries,
					scannedBytes,
					skippedEntries,
				);
			}
			if (
				isDuplicate(result.record, seenRecordIds, seenEntryIds, seenShortRefs)
			) {
				return fail(
					"metadata records contain duplicate identities",
					inspectedEntries,
					scannedEntries,
					scannedBytes,
					skippedEntries,
				);
			}
			seenRecordIds.add(result.record.recordId);
			if (result.record.entryId !== null) {
				seenEntryIds.add(result.record.entryId);
			}
			seenShortRefs.add(result.record.shortRef);
			records.push(result.record);
		}
	}

	return {
		ok: true,
		records,
		inspectedEntries,
		scannedEntries,
		scannedBytes,
		skippedEntries,
	};
}
