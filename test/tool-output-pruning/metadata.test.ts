import { describe, expect, it } from "vitest";
import { createSessionBranchView } from "../../src/session-branch-view.js";
import {
	buildToolPruneSummaryData,
	MAX_RECONSTRUCTED_ARGS_PREVIEW_CHARS,
	MAX_RECONSTRUCTED_SUMMARY_CHARS,
	MAX_RECONSTRUCTION_BRANCH_SCAN_ENTRIES,
	MAX_RECONSTRUCTION_SCAN_BYTES,
	MAX_RECONSTRUCTION_SCAN_ENTRIES,
	reconstructToolOutputRecordsFromBranch,
	TOOL_PRUNE_METADATA_SCHEMA_VERSION,
	TOOL_PRUNE_METADATA_SOURCE,
	type ToolPruneSummaryData,
} from "../../src/tool-output-pruning/metadata.js";
import type { ToolOutputBranchEntry } from "../../src/tool-output-pruning/pruner.js";
import type {
	ToolOutputPruningSettings,
	ToolOutputRecord,
} from "../../src/tool-output-pruning/types.js";
import { TOOL_PRUNE_SUMMARY_CUSTOM_TYPE } from "../../src/types.js";

const SETTINGS: ToolOutputPruningSettings = {
	experimentalToolOutputPruning: true,
	toolOutputPruningMode: "agent-message",
	toolOutputSummaryStrategy: "llm",
	toolOutputPruneStrategy: "stub",
	toolOutputPruneMinChars: 100,
	toolOutputSummaryMaxChars: 800,
	toolOutputQueryMaxChars: 8000,
	toolOutputSummarizerModel: "default",
	toolOutputSummarizerThinking: "low",
	toolOutputPruneExcludedTools: ["read", "read_hashed", "hashline_edit"],
	toolOutputPruneIncludedTools: [],
};

function makeRecord(
	overrides: Partial<ToolOutputRecord> = {},
): ToolOutputRecord {
	return {
		recordId: "rec-tc1",
		entryId: "entry-1",
		toolCallId: "tc1",
		toolName: "bash",
		timestamp: 1234,
		chars: 250,
		isError: false,
		summary: "summary",
		shortRef: "t1",
		argsPreview: '{"command":"echo test"}',
		fallbackSnippets: "original output snippets must not persist",
		...overrides,
	};
}

function makeToolResultEntry(
	overrides: {
		id?: string;
		toolCallId?: string;
		toolName?: string;
		content?: unknown;
		type?: string;
	} = {},
): ToolOutputBranchEntry {
	return {
		type: overrides.type ?? "message",
		id: overrides.id ?? "entry-1",
		message: {
			role: "toolResult",
			toolCallId: overrides.toolCallId ?? "tc1",
			toolName: overrides.toolName ?? "bash",
			content: overrides.content ?? [{ type: "text", text: "original output" }],
			isError: false,
		} as never,
	};
}

function makeSummaryEntry(data: ToolPruneSummaryData) {
	return {
		type: "custom",
		id: "summary-1",
		customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
		data,
	};
}

function makePersistedData(
	records: ToolOutputRecord[] = [makeRecord()],
	settings: ToolOutputPruningSettings = SETTINGS,
): ToolPruneSummaryData {
	return buildToolPruneSummaryData({
		allRecords: records,
		metadataRecords: records,
		settings,
		summaryChars: 42,
		timestamp: 9999,
	});
}

function makeView(
	summaryEntries: unknown[],
	branchEntries: ToolOutputBranchEntry[],
) {
	return createSessionBranchView([
		...(branchEntries as Array<{
			type: string;
			id: string;
			message: ToolOutputBranchEntry["message"];
		}>),
		...(summaryEntries as Array<{
			type: string;
			id: string;
			customType?: string;
			data?: unknown;
		}>),
	]);
}

function reconstruct(data: ToolPruneSummaryData, settings = SETTINGS) {
	return reconstructToolOutputRecordsFromBranch(
		makeView([makeSummaryEntry(data)], [makeToolResultEntry()]),
		settings,
	);
}

describe("buildToolPruneSummaryData", () => {
	it("persists bounded metadata only and preserves legacy observability fields", () => {
		const longSummary = "s".repeat(MAX_RECONSTRUCTED_SUMMARY_CHARS + 50);
		const longArgs = "a".repeat(MAX_RECONSTRUCTED_ARGS_PREVIEW_CHARS + 50);
		const data = makePersistedData([
			makeRecord({ summary: longSummary, argsPreview: longArgs }),
		]);

		expect(data.timestamp).toBe(9999);
		expect(data.refs).toBe("t1: bash");
		expect(data.summaryChars).toBe(42);
		expect(data.recordCount).toBe(1);
		expect(data.metadata?.schemaVersion).toBe(
			TOOL_PRUNE_METADATA_SCHEMA_VERSION,
		);
		expect(data.metadata?.source).toBe(TOOL_PRUNE_METADATA_SOURCE);
		expect(data.metadata?.recordCount).toBe(1);
		const persisted = data.metadata?.records[0];
		expect(persisted?.summary).toHaveLength(SETTINGS.toolOutputSummaryMaxChars);
		expect(persisted?.argsPreview).toHaveLength(
			MAX_RECONSTRUCTED_ARGS_PREVIEW_CHARS,
		);
		expect(persisted?.fallbackSnippets).toBeNull();
		expect(JSON.stringify(data)).not.toContain(
			"original output snippets must not persist",
		);
	});

	it("rejects overlong required identity strings before append", () => {
		const longId = "x".repeat(600);

		expect(() =>
			makePersistedData([
				makeRecord({
					recordId: longId,
					entryId: "entry-1",
					toolCallId: "tc1",
					toolName: "bash",
					shortRef: "t1",
				}),
			]),
		).toThrow("recordId exceeds durable metadata bounds");
	});

	it("fails before append when durable metadata exceeds the byte budget", () => {
		const settings = { ...SETTINGS, toolOutputSummaryMaxChars: 10_000 };
		const records = Array.from({ length: 50 }, (_, index) =>
			makeRecord({
				recordId: `rec-${index}`,
				entryId: `entry-${index}`,
				toolCallId: `tc-${index}`,
				shortRef: `t${index + 1}`,
				summary: "s".repeat(MAX_RECONSTRUCTED_SUMMARY_CHARS),
			}),
		);

		expect(() => makePersistedData(records, settings)).toThrow(
			`metadata payload exceeded ${MAX_RECONSTRUCTION_SCAN_BYTES} bytes`,
		);
	});

	it("checks summary record count before projecting refs", () => {
		const allRecords = Array.from({ length: 501 }, (_, index) => {
			const record = makeRecord({
				recordId: `rec-${index}`,
				entryId: `entry-${index}`,
				toolCallId: `tc-${index}`,
			});
			Object.defineProperty(record, "shortRef", {
				get: () => {
					throw new Error("shortRef should not be projected");
				},
			});
			return record;
		});

		expect(() =>
			buildToolPruneSummaryData({
				allRecords,
				metadataRecords: [],
				settings: SETTINGS,
				summaryChars: 0,
				timestamp: 1,
			}),
		).toThrow("summary record count exceeded 500");
	});

	it("checks metadata record count before projecting records", () => {
		const metadataRecords = Array.from({ length: 501 }, (_, index) =>
			makeRecord({
				recordId: "x".repeat(600),
				entryId: `entry-${index}`,
				toolCallId: `tc-${index}`,
				shortRef: `t${index + 1}`,
			}),
		);

		expect(() =>
			buildToolPruneSummaryData({
				allRecords: [],
				metadataRecords,
				settings: SETTINGS,
				summaryChars: 0,
				timestamp: 1,
			}),
		).toThrow("metadata record count exceeded 500");
	});
});

describe("reconstructToolOutputRecordsFromBranch", () => {
	it("reconstructs valid current-branch metadata without original-output snippets", () => {
		const result = reconstruct(makePersistedData());

		expect(result.ok).toBe(true);
		expect(result.records).toHaveLength(1);
		expect(result.records[0]).toMatchObject({
			recordId: "rec-tc1",
			entryId: "entry-1",
			toolCallId: "tc1",
			toolName: "bash",
			shortRef: "t1",
			fallbackSnippets: null,
		});
		expect(result.scannedEntries).toBe(1);
		expect(result.scannedBytes).toBeGreaterThan(0);
	});

	it("skips legacy summary entries without metadata", () => {
		const result = reconstructToolOutputRecordsFromBranch(
			makeView(
				[
					makeSummaryEntry({
						timestamp: 1,
						refs: "t1: bash",
						summaryChars: 10,
						recordCount: 1,
					}),
				],
				[makeToolResultEntry()],
			),
			SETTINGS,
		);

		expect(result.ok).toBe(true);
		expect(result.records).toHaveLength(0);
		expect(result.skippedEntries).toBe(1);
	});

	it("fails atomically for mismatched active-schema recordCount", () => {
		const data = makePersistedData();
		if (data.metadata) data.metadata.recordCount = 99;

		const result = reconstruct(data);

		expect(result.ok).toBe(false);
		expect(result.records).toHaveLength(0);
		expect(result.error).toContain("recordCount");
	});

	it("fails atomically for stale branch entry ids", () => {
		const result = reconstructToolOutputRecordsFromBranch(
			makeView(
				[makeSummaryEntry(makePersistedData())],
				[makeToolResultEntry({ id: "other-entry" })],
			),
			SETTINGS,
		);

		expect(result.ok).toBe(false);
		expect(result.records).toHaveLength(0);
		expect(result.error).toContain("current branch");
	});

	it("fails atomically for toolCallId and toolName mismatches", () => {
		const wrongCall = reconstructToolOutputRecordsFromBranch(
			makeView(
				[makeSummaryEntry(makePersistedData())],
				[makeToolResultEntry({ toolCallId: "tc-other" })],
			),
			SETTINGS,
		);
		expect(wrongCall.ok).toBe(false);
		expect(wrongCall.records).toHaveLength(0);

		const wrongTool = reconstructToolOutputRecordsFromBranch(
			makeView(
				[makeSummaryEntry(makePersistedData())],
				[makeToolResultEntry({ toolName: "python" })],
			),
			SETTINGS,
		);
		expect(wrongTool.ok).toBe(false);
		expect(wrongTool.records).toHaveLength(0);
		expect(wrongTool.error).toContain("current branch");
	});

	it("fails atomically for protected excluded tools and include-list misses", () => {
		const protectedTool = makePersistedData([
			makeRecord({ recordId: "rec-read", toolCallId: "tc1", toolName: "read" }),
		]);
		const protectedResult = reconstructToolOutputRecordsFromBranch(
			makeView(
				[makeSummaryEntry(protectedTool)],
				[makeToolResultEntry({ toolName: "read" })],
			),
			SETTINGS,
		);
		expect(protectedResult.ok).toBe(false);
		expect(protectedResult.error).toContain("excluded tool read");

		const includedOnly = {
			...SETTINGS,
			toolOutputPruneIncludedTools: ["python"],
		};
		const includeResult = reconstruct(makePersistedData(), includedOnly);
		expect(includeResult.ok).toBe(false);
		expect(includeResult.error).toContain("not included");
	});

	it("fails atomically for non-text current branch tool results", () => {
		const result = reconstructToolOutputRecordsFromBranch(
			makeView(
				[makeSummaryEntry(makePersistedData())],
				[makeToolResultEntry({ content: [{ type: "image", data: "abc" }] })],
			),
			SETTINGS,
		);

		expect(result.ok).toBe(false);
		expect(result.records).toHaveLength(0);
		expect(result.error).toContain("current branch");
	});

	it("fails atomically for duplicate record identities", () => {
		const records = [
			makeRecord(),
			makeRecord({
				recordId: "rec-tc2",
				entryId: "entry-2",
				toolCallId: "tc2",
				shortRef: "t1",
			}),
		];
		const data = makePersistedData(records);
		const result = reconstructToolOutputRecordsFromBranch(
			makeView(
				[makeSummaryEntry(data)],
				[
					makeToolResultEntry(),
					makeToolResultEntry({ id: "entry-2", toolCallId: "tc2" }),
				],
			),
			SETTINGS,
		);

		expect(result.ok).toBe(false);
		expect(result.records).toHaveLength(0);
		expect(result.error).toContain("duplicate");
	});

	it("bounds summary-entry count, branch scan entries, and serialized metadata bytes", () => {
		const tooManySummaryEntries = Array.from(
			{ length: MAX_RECONSTRUCTION_SCAN_ENTRIES + 1 },
			(_, index) => ({
				type: "custom",
				id: `summary-${index}`,
				customType: TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
				data: { timestamp: index, refs: "", summaryChars: 0, recordCount: 0 },
			}),
		);
		const tooMany = reconstructToolOutputRecordsFromBranch(
			makeView(tooManySummaryEntries, [makeToolResultEntry()]),
			SETTINGS,
		);
		expect(tooMany.ok).toBe(false);
		expect(tooMany.error).toContain("too many metadata entries");

		const hugeBranch = Array.from(
			{ length: MAX_RECONSTRUCTION_BRANCH_SCAN_ENTRIES + 1 },
			(_, index) => ({
				type: "message",
				id: `entry-${index}`,
				message: { role: "assistant", content: [] },
			}),
		);
		const branchBound = reconstructToolOutputRecordsFromBranch(
			makeView([makeSummaryEntry(makePersistedData())], hugeBranch as never),
			SETTINGS,
		);
		expect(branchBound.ok).toBe(false);
		expect(branchBound.error).toContain("branch message scan exceeded");

		const data = makePersistedData();
		(data as unknown as { padding: string }).padding = "x".repeat(
			MAX_RECONSTRUCTION_SCAN_BYTES,
		);
		const bytesBound = reconstruct(data);
		expect(bytesBound.ok).toBe(false);
		expect(bytesBound.error).toContain("metadata scan exceeded");
	});
});
